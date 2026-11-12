import { forecastSchema, parseAlertCollection, pointSchema, toForecast, type ParseResult } from "./schema.ts";
import type { Forecast } from "./types.ts";

export class NwsError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "NwsError";
    this.status = status;
  }
}

export interface NwsClientOptions {
  /** NWS asks every client to send an identifying User-Agent (ideally with contact info). */
  userAgent: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected so tests don't actually wait for backoff delays. */
  sleep?: (ms: number) => Promise<void>;
  forecastCacheTtlMs?: number;
}

export type AlertsResult = ({ notModified: false } & ParseResult) | { notModified: true };

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 30_000;
const FORECAST_CACHE_MAX = 500;

/**
 * Thin client for https://api.weather.gov with:
 *  - per-request timeouts (AbortSignal.timeout)
 *  - retries with exponential backoff + jitter on network errors, 429 and 5xx (honors Retry-After)
 *  - ETag-based change detection for the alerts feed, so an unchanged feed is never re-parsed
 *  - a small TTL cache for point forecasts
 */
export class NwsClient {
  readonly #userAgent: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #forecastTtlMs: number;
  readonly #forecastCache = new Map<string, { expires: number; value: Forecast }>();
  #alertsEtag: string | null = null;

  constructor(options: NwsClientOptions) {
    this.#userAgent = options.userAgent;
    this.#baseUrl = (options.baseUrl ?? "https://api.weather.gov").replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#forecastTtlMs = options.forecastCacheTtlMs ?? 10 * 60_000;
  }

  /** Active, real (non-test) alerts and updates across the U.S. */
  async getActiveAlerts(): Promise<AlertsResult> {
    const headers: Record<string, string> = {};
    if (this.#alertsEtag) headers["If-None-Match"] = this.#alertsEtag;

    const res = await this.#request("/alerts/active?status=actual&message_type=alert,update", headers);
    // At the time of writing, api.weather.gov sends weak ETags but answers If-None-Match with a full
    // 200 instead of 304. Comparing the ETag ourselves still lets us skip parsing and the DB write.
    const etag = res.headers.get("etag");
    if (res.status === 304 || (etag !== null && etag === this.#alertsEtag)) {
      await res.body?.cancel();
      return { notModified: true };
    }

    const result = parseAlertCollection(await res.json());
    // Only remember the ETag once the body parsed, so a bad payload is re-fetched next time.
    this.#alertsEtag = etag;
    return { notModified: false, ...result };
  }


  /** 7-day forecast for a U.S. point. Two calls: /points resolves the forecast grid, then the grid forecast. */
  async getForecast(lat: number, lon: number): Promise<Forecast> {
    // ~11 m precision is plenty and keeps the cache hit rate high.
    const rLat = Math.round(lat * 1e4) / 1e4;
    const rLon = Math.round(lon * 1e4) / 1e4;
    const key = `${rLat},${rLon}`;

    const cached = this.#forecastCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;

    const point = pointSchema.parse(await (await this.#request(`/points/${key}`)).json());
    const forecastUrl = point.properties.forecast;
    if (!forecastUrl) throw new NwsError("No forecast is available for this location", 404);
    // The URL comes from the API response; never follow it off the NWS host.
    if (new URL(forecastUrl).origin !== new URL(this.#baseUrl).origin) {
      throw new NwsError("Unexpected forecast URL host", 502);
    }

    const forecast = forecastSchema.parse(await (await this.#request(forecastUrl)).json());
    const value = toForecast(point, forecast, rLat, rLon);

    if (this.#forecastCache.size >= FORECAST_CACHE_MAX) {
      // Map keeps insertion order, so the first key is the oldest entry.
      const oldest = this.#forecastCache.keys().next().value;
      if (oldest !== undefined) this.#forecastCache.delete(oldest);
    }
    this.#forecastCache.set(key, { expires: Date.now() + this.#forecastTtlMs, value });
    return value;
  }

  async #request(pathOrUrl: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.#baseUrl}${pathOrUrl}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) await this.#sleep(this.#backoff(attempt, lastError));

      let res: Response;
      try {
        res = await this.#fetch(url, {
          headers: { "User-Agent": this.#userAgent, Accept: "application/geo+json", ...extraHeaders },
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (err) {
        lastError = err; // DNS failure, reset connection, timeout…
        continue;
      }

      if (res.ok || res.status === 304) return res;

      const detail = await readProblemDetail(res);
      const error = new NwsError(detail ?? `NWS API responded ${res.status} ${res.statusText}`, res.status);
      if (!RETRYABLE_STATUS.has(res.status)) throw error;
      lastError = Object.assign(error, { retryAfter: res.headers.get("retry-after") });
    }

    if (lastError instanceof NwsError) throw lastError;
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new NwsError(`Request to NWS failed after ${this.#maxRetries + 1} attempts: ${reason}`);
  }

  #backoff(attempt: number, lastError: unknown): number {
    const retryAfter = Number((lastError as { retryAfter?: string | null } | undefined)?.retryAfter);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS);
    const cap = 500 * 2 ** (attempt - 1); // 500 ms, 1 s, 2 s, …
    return Math.round(cap / 2 + Math.random() * (cap / 2));
  }
}

/** NWS errors are RFC 7807 problem documents: prefer their human-readable `detail`. */
async function readProblemDetail(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { detail?: unknown; title?: unknown };
    if (typeof body.detail === "string") return body.detail;
    if (typeof body.title === "string") return body.title;
  } catch {
    // Not JSON — fall through to the generic message.
  }
  return null;
}
