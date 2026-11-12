import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { NwsError, type NwsClient } from "./nws/client.ts";
import { SEVERITIES, SEVERITY_RANK, type Severity } from "./nws/types.ts";
import type { Poller } from "./poller.ts";
import type { Store } from "./store.ts";

export interface ServerDeps {
  store: Store;
  poller: Pick<Poller, "pollOnce" | "busy">;
  client: Pick<NwsClient, "getForecast">;
  pollIntervalMs: number;
  adminToken: string | null;
  logger?: FastifyServerOptions["logger"];
  now?: () => Date;
}

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const MANUAL_POLL_COOLDOWN_MS = 30_000;

const alertsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    area: { type: "string", pattern: "^[A-Za-z]{2}$" },
    severity: { type: "string", pattern: `^(${SEVERITIES.join("|")})(,(${SEVERITIES.join("|")}))*$` },
    zone: { type: "string", enum: ["land", "marine", "all"], default: "land" },
    q: { type: "string", maxLength: 100 },
    limit: { type: "integer", minimum: 1, maximum: 1000, default: 500 },
  },
} as const;

interface AlertsQuery {
  area?: string;
  severity?: string;
  zone: "land" | "marine" | "all";
  q?: string;
  limit: number;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { store, poller, client } = deps;
  const now = deps.now ?? (() => new Date());
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: true });

  // Small, unversioned assets: let browsers revalidate (ETag) on every load instead of caching blindly.
  await app.register(fastifyStatic, { root: PUBLIC_DIR, cacheControl: true, maxAge: 0 });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  });

  app.get("/api/alerts", { schema: { querystring: alertsQuerySchema } }, async (req) => {
    const query = req.query as AlertsQuery;
    const alerts = store.listActive({
      area: query.area,
      severities: query.severity?.split(",") as Severity[] | undefined,
      zone: query.zone,
      q: query.q?.trim() || undefined,
      limit: query.limit,
    });
    return { count: alerts.length, alerts };
  });

  app.get<{ Params: { id: string } }>("/api/alerts/:id", async (req, reply) => {
    const alert = store.getAlert(req.params.id);
    if (!alert) return reply.code(404).send({ error: "Alert not found" });
    return alert;
  });

  app.get<{ Querystring: { zone?: "land" | "marine" | "all" } }>(
    "/api/stats",
    { schema: { querystring: { type: "object", properties: { zone: alertsQuerySchema.properties.zone } } } },
    async (req) => {
      const zone = req.query.zone ?? "land";
      const alerts = store.listActive({ zone, limit: 5000 });

      const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
      const byEvent = new Map<string, { count: number; severity: Severity }>();
      const byArea = new Map<string, { count: number; maxSeverity: Severity }>();

      for (const a of alerts) {
        bySeverity[a.severity]++;
        const ev = byEvent.get(a.event) ?? { count: 0, severity: a.severity };
        ev.count++;
        if (SEVERITY_RANK[a.severity] > SEVERITY_RANK[ev.severity]) ev.severity = a.severity;
        byEvent.set(a.event, ev);
        for (const area of a.areas) {
          const entry = byArea.get(area) ?? { count: 0, maxSeverity: a.severity };
          entry.count++;
          if (SEVERITY_RANK[a.severity] > SEVERITY_RANK[entry.maxSeverity]) entry.maxSeverity = a.severity;
          byArea.set(area, entry);
        }
      }

      // `sent` carries the issuing office's UTC offset, so compare instants rather than strings.
      const hourAgo = now().getTime() - 3_600_000;
      return {
        total: alerts.length,
        issuedLastHour: alerts.filter((a) => new Date(a.sent).getTime() >= hourAgo).length,
        bySeverity,
        topEvents: [...byEvent.entries()]
          .map(([event, v]) => ({ event, ...v }))
          .sort((x, y) => y.count - x.count)
          .slice(0, 8),
        byArea: Object.fromEntries([...byArea.entries()].sort(([a], [b]) => a.localeCompare(b))),
        lastPoll: store.lastPoll(),
        lastSuccessfulPoll: store.lastSuccessfulPoll(),
        pollIntervalSeconds: deps.pollIntervalMs / 1000,
      };
    },
  );

  app.get<{ Querystring: { hours: number; zone: "land" | "marine" | "all" } }>(
    "/api/history",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            hours: { type: "integer", minimum: 1, maximum: 720, default: 24 },
            zone: alertsQuerySchema.properties.zone,
          },
        },
      },
    },
    async (req) => {
      const since = new Date(now().getTime() - req.query.hours * 3_600_000).toISOString();
      return { snapshots: store.snapshotsSince(since, req.query.zone) };
    },
  );

  app.get<{ Querystring: { lat: number; lon: number } }>(
    "/api/forecast",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["lat", "lon"],
          properties: {
            lat: { type: "number", minimum: -90, maximum: 90 },
            lon: { type: "number", minimum: -180, maximum: 180 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const forecast = await client.getForecast(req.query.lat, req.query.lon);
        reply.header("Cache-Control", "public, max-age=600");
        return forecast;
      } catch (err) {
        if (err instanceof NwsError && err.status === 404) {
          return reply.code(404).send({ error: "Forecasts are only available for U.S. locations." });
        }
        req.log.warn({ err }, "forecast lookup failed");
        return reply.code(502).send({ error: "The National Weather Service did not respond. Try again shortly." });
      }
    },
  );

  /** Kubernetes / uptime-monitor friendly: 503 once the feed is stale for 3 poll intervals. */
  app.get("/api/health", async (_req, reply) => {
    const last = store.lastSuccessfulPoll();
    const ageMs = last ? now().getTime() - new Date(last.startedAt).getTime() : null;
    const healthy = ageMs !== null && ageMs < deps.pollIntervalMs * 3;
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? "ok" : "stale",
      lastSuccessfulPoll: last?.startedAt ?? null,
      dataAgeSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
    });
  });

  /** Trigger a poll now. Protected by ADMIN_TOKEN when set, and rate-limited either way. */
  app.post("/api/poll", async (req, reply) => {
    if (deps.adminToken && !tokenMatches(req.headers.authorization, deps.adminToken)) {
      return reply.code(401).send({ error: "Missing or invalid bearer token" });
    }
    const last = store.lastPoll();
    if (!poller.busy && last && now().getTime() - new Date(last.startedAt).getTime() < MANUAL_POLL_COOLDOWN_MS) {
      return reply.code(429).send({ error: "Data was refreshed less than 30 seconds ago", lastPoll: last });
    }
    return { poll: await poller.pollOnce() };
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });

  return app;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
