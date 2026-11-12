import type { Alert } from "../src/nws/types.ts";

/** A raw NWS GeoJSON feature, shaped like the real /alerts/active payload (trimmed). */
export function rawFeature(overrides: Record<string, unknown> = {}, geometry: unknown = null) {
  return {
    id: `https://api.weather.gov/alerts/${String(overrides.id ?? "urn:oid:test.1")}`,
    type: "Feature",
    geometry,
    properties: {
      "@id": `https://api.weather.gov/alerts/${String(overrides.id ?? "urn:oid:test.1")}`,
      id: "urn:oid:test.1",
      areaDesc: "Travis, TX; Williamson, TX",
      geocode: { SAME: ["048453", "048491"], UGC: ["TXZ192", "TXZ173"] },
      sent: "2026-11-12T12:41:00-06:00",
      effective: "2026-11-12T12:41:00-06:00",
      onset: "2026-11-12T12:41:00-06:00",
      expires: "2026-11-12T13:30:00-06:00",
      ends: "2026-11-12T13:30:00-06:00",
      status: "Actual",
      messageType: "Alert",
      category: "Met",
      severity: "Severe",
      certainty: "Observed",
      urgency: "Immediate",
      event: "Severe Thunderstorm Warning",
      sender: "w-nws.webmaster@noaa.gov",
      senderName: "NWS Austin/San Antonio TX",
      headline: "Severe Thunderstorm Warning issued November 12 at 12:41PM CST until 1:30PM CST",
      description: "At 1241 PM CST, a severe thunderstorm was located near Austin.\n\nHAZARD...60 mph wind gusts.",
      instruction: "For your protection move to an interior room on the lowest floor of a building.",
      response: "Shelter",
      references: [],
      parameters: {},
      ...overrides,
    },
  };
}

export function collection(features: unknown[]) {
  return { type: "FeatureCollection", updated: "2026-11-12T18:41:00+00:00", features };
}

export function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: "urn:oid:test.1",
    event: "Severe Thunderstorm Warning",
    messageType: "Alert",
    severity: "Severe",
    urgency: "Immediate",
    certainty: "Observed",
    headline: null,
    description: "",
    instruction: null,
    areaDesc: "Travis, TX",
    areas: ["TX"],
    zoneType: "land",
    senderName: "NWS Austin/San Antonio TX",
    sent: "2026-11-12T18:41:00.000Z",
    effective: null,
    onset: null,
    expires: "2026-11-12T19:30:00.000Z",
    ends: null,
    references: [],
    geometry: null,
    ...overrides,
  };
}

export const silentLogger = { info() {}, warn() {}, error() {} };

/** Minimal fetch double: returns queued responses (or throws queued errors) and records calls. */
export function fakeFetch(queue: Array<Response | Error | (() => Response)>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected request: ${String(input)}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "Content-Type": "application/geo+json", ...(init.headers as Record<string, string> | undefined) },
  });
}
