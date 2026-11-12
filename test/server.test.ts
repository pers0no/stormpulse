import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.ts";
import { NwsError } from "../src/nws/client.ts";
import type { PollRun } from "../src/store.ts";
import { buildServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { alert } from "./helpers.ts";

const NOW = new Date("2026-11-12T18:30:00.000Z");

function pollRun(overrides: Partial<PollRun> = {}): PollRun {
  return {
    startedAt: "2026-11-12T18:29:00.000Z", durationMs: 500, status: "ok", error: null,
    fetched: 3, added: 3, updated: 0, ended: 0, notified: 0, ...overrides,
  };
}

describe("HTTP API", () => {
  let app: FastifyInstance;
  let store: Store;
  let polls = 0;

  before(async () => {
    store = new Store(":memory:");
    store.sync(
      [
        alert({ id: "tx", areas: ["TX"], severity: "Severe", sent: "2026-11-12T17:00:00.000Z" }),
        alert({ id: "ok", areas: ["OK", "TX"], severity: "Extreme", event: "Tornado Warning", sent: "2026-11-12T12:10:00-06:00" }),
        alert({ id: "sea", areas: [], zoneType: "marine", severity: "Minor", event: "Small Craft Advisory" }),
      ],
      "2026-11-12T18:29:00.000Z",
    );
    store.recordPoll(pollRun());

    app = await buildServer({
      store,
      client: {
        async getForecast(lat) {
          if (lat > 45) throw new NwsError("Data Unavailable For Requested Point", 404);
          return { location: { city: "Austin", state: "TX", lat, lon: -97 }, office: "EWX", updated: null, periods: [] };
        },
      },
      poller: {
        busy: false,
        async pollOnce() {
          polls++;
          return pollRun();
        },
      },
      pollIntervalMs: 120_000,
      adminToken: "s3cret",
      now: () => NOW,
    });
  });

  after(async () => {
    await app.close();
    store.close();
  });

  it("GET /api/alerts defaults to land alerts, most severe first", async () => {
    const res = await app.inject("/api/alerts");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().alerts.map((a: { id: string }) => a.id), ["ok", "tx"]);
  });

  it("GET /api/alerts filters by state and severity", async () => {
    const res = await app.inject("/api/alerts?area=tx&severity=Severe");
    assert.deepEqual(res.json().alerts.map((a: { id: string }) => a.id), ["tx"]);
  });

  it("GET /api/alerts validates query parameters", async () => {
    assert.equal((await app.inject("/api/alerts?severity=Apocalyptic")).statusCode, 400);
    assert.equal((await app.inject("/api/alerts?area=Texas")).statusCode, 400);
  });

  it("GET /api/alerts/:id returns 404 for unknown ids", async () => {
    assert.equal((await app.inject("/api/alerts/ok")).json().event, "Tornado Warning");
    assert.equal((await app.inject("/api/alerts/nope")).statusCode, 404);
  });

  it("GET /api/stats aggregates by severity, event and state", async () => {
    const stats = (await app.inject("/api/stats")).json();
    assert.equal(stats.total, 2);
    assert.equal(stats.bySeverity.Extreme, 1);
    assert.deepEqual(stats.byArea.TX, { count: 2, maxSeverity: "Extreme" });
    assert.equal(stats.issuedLastHour, 1, "compares instants, not offset-formatted strings");
    assert.equal(stats.lastSuccessfulPoll.status, "ok");
  });

  it("GET /api/forecast proxies the forecast and maps non-U.S. points to 404", async () => {
    const ok = await app.inject("/api/forecast?lat=30.27&lon=-97.74");
    assert.equal(ok.json().location.city, "Austin");
    assert.equal((await app.inject("/api/forecast?lat=48.15&lon=17.1")).statusCode, 404);
    assert.equal((await app.inject("/api/forecast?lat=999&lon=0")).statusCode, 400);
  });

  it("GET /api/health is ok while data is fresh", async () => {
    const res = await app.inject("/api/health");
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().dataAgeSeconds, 60);
  });

  it("POST /api/poll requires the admin token and enforces a cooldown", async () => {
    const auth = { authorization: "Bearer s3cret" };
    assert.equal((await app.inject({ method: "POST", url: "/api/poll" })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/poll", headers: { authorization: "Bearer wrong!" } })).statusCode, 401);

    // Last poll was 60 s ago → allowed.
    assert.equal((await app.inject({ method: "POST", url: "/api/poll", headers: auth })).statusCode, 200);
    assert.equal(polls, 1);

    // A poll 10 s ago → rate-limited.
    store.recordPoll(pollRun({ startedAt: "2026-11-12T18:29:50.000Z" }));
    assert.equal((await app.inject({ method: "POST", url: "/api/poll", headers: auth })).statusCode, 429);
    assert.equal(polls, 1);
  });

  it("serves the dashboard for unknown non-API routes", async () => {
    const res = await app.inject("/some/page");
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<title>StormPulse/);
    assert.equal((await app.inject("/api/unknown")).statusCode, 404);
  });
});

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig({});
    assert.equal(config.port, 3000);
    assert.equal(config.pollIntervalMs, 120_000);
    assert.equal(config.webhookUrl, null);
    assert.equal(config.notify.minSeverity, "Severe");
  });

  it("parses lists and validates values", () => {
    const config = loadConfig({ NOTIFY_AREAS: "tx, ok ,", NOTIFY_INCLUDE_MARINE: "true", WEBHOOK_URL: "https://hooks.slack.com/x" });
    assert.deepEqual(config.notify.areas, ["TX", "OK"]);
    assert.equal(config.notify.includeMarine, true);
    assert.throws(() => loadConfig({ POLL_INTERVAL_SECONDS: "5" }), /POLL_INTERVAL_SECONDS/);
    assert.throws(() => loadConfig({ NOTIFY_AREAS: "Texas" }), /NOTIFY_AREAS/);
    assert.throws(() => loadConfig({ WEBHOOK_URL: "ftp://nope" }), /WEBHOOK_URL/);
  });
});
