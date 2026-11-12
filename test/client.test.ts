import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NwsClient, NwsError } from "../src/nws/client.ts";
import { collection, fakeFetch, json, rawFeature } from "./helpers.ts";

const noSleep = async () => {};

function makeClient(fetch: typeof globalThis.fetch, maxRetries = 3) {
  return new NwsClient({ userAgent: "StormPulse-test", fetch, sleep: noSleep, maxRetries });
}

describe("NwsClient.getActiveAlerts", () => {
  it("sends the User-Agent and parses the feed", async () => {
    const fetch = fakeFetch([json(collection([rawFeature()]), { headers: { ETag: 'W/"a"' } })]);
    const result = await makeClient(fetch).getActiveAlerts();

    assert.equal(result.notModified, false);
    assert.equal(result.notModified === false && result.alerts.length, 1);
    const headers = fetch.calls[0]!.init!.headers as Record<string, string>;
    assert.equal(headers["User-Agent"], "StormPulse-test");
    assert.match(fetch.calls[0]!.url, /\/alerts\/active\?status=actual/);
  });

  it("reports notModified when the ETag is unchanged, even on a 200", async () => {
    const fetch = fakeFetch([
      json(collection([rawFeature()]), { headers: { ETag: 'W/"a"' } }),
      json(collection([rawFeature()]), { headers: { ETag: 'W/"a"' } }),
      new Response(null, { status: 304 }),
    ]);
    const client = makeClient(fetch);
    await client.getActiveAlerts();

    assert.deepEqual(await client.getActiveAlerts(), { notModified: true });
    assert.equal((fetch.calls[1]!.init!.headers as Record<string, string>)["If-None-Match"], 'W/"a"');
    assert.deepEqual(await client.getActiveAlerts(), { notModified: true });
  });

  it("retries 5xx and network errors, then succeeds", async () => {
    const fetch = fakeFetch([
      new TypeError("fetch failed"),
      json({ title: "Bad Gateway" }, { status: 502 }),
      json(collection([])),
    ]);
    const result = await makeClient(fetch).getActiveAlerts();
    assert.equal(result.notModified, false);
    assert.equal(fetch.calls.length, 3);
  });

  it("gives up after maxRetries and surfaces the API's problem detail", async () => {
    const unavailable = () => json({ title: "Service Unavailable", detail: "Upstream outage" }, { status: 503 });
    const fetch = fakeFetch([unavailable, unavailable, unavailable]);

    await assert.rejects(makeClient(fetch, 2).getActiveAlerts(), (err: unknown) => {
      assert.ok(err instanceof NwsError);
      assert.equal(err.status, 503);
      assert.equal(err.message, "Upstream outage");
      return true;
    });
    assert.equal(fetch.calls.length, 3);
  });

  it("does not retry client errors", async () => {
    const fetch = fakeFetch([json({ detail: "Bad query" }, { status: 400 })]);
    await assert.rejects(makeClient(fetch).getActiveAlerts(), /Bad query/);
    assert.equal(fetch.calls.length, 1);
  });

  it("honors Retry-After on 429", async () => {
    const waits: number[] = [];
    const fetch = fakeFetch([json({}, { status: 429, headers: { "Retry-After": "7" } }), json(collection([]))]);
    const client = new NwsClient({ userAgent: "t", fetch, sleep: async (ms) => void waits.push(ms) });
    await client.getActiveAlerts();
    assert.deepEqual(waits, [7000]);
  });
});

describe("NwsClient.getForecast", () => {
  const point = {
    properties: {
      forecast: "https://api.weather.gov/gridpoints/EWX/156,91/forecast",
      gridId: "EWX",
      relativeLocation: { properties: { city: "Austin", state: "TX" } },
    },
  };
  const forecast = {
    properties: {
      updateTime: "2026-11-12T18:00:00+00:00",
      periods: [
        {
          number: 1, name: "This Afternoon", startTime: "2026-11-12T13:00:00-06:00", isDaytime: true,
          temperature: 78, temperatureUnit: "F", windSpeed: "10 mph", windDirection: "S",
          probabilityOfPrecipitation: { value: 40 }, shortForecast: "Chance Showers", icon: null,
        },
      ],
    },
  };

  it("resolves the grid point, then fetches and caches the forecast", async () => {
    const fetch = fakeFetch([json(point), json(forecast)]);
    const client = makeClient(fetch);

    const first = await client.getForecast(30.26715, -97.74306);
    assert.deepEqual(first.location, { city: "Austin", state: "TX", lat: 30.2672, lon: -97.7431 });
    assert.equal(first.periods[0]?.precipitationChance, 40);
    assert.match(fetch.calls[0]!.url, /\/points\/30\.2672,-97\.7431$/);

    await client.getForecast(30.26718, -97.74309); // Same rounded point → served from cache.
    assert.equal(fetch.calls.length, 2);
  });

  it("refuses to follow a forecast URL to another host", async () => {
    const evil = { properties: { ...point.properties, forecast: "https://example.com/steal" } };
    const fetch = fakeFetch([json(evil)]);
    await assert.rejects(makeClient(fetch).getForecast(30, -97), /Unexpected forecast URL host/);
  });

  it("maps a point outside the U.S. to a 404 NwsError", async () => {
    const fetch = fakeFetch([json({ title: "Data Unavailable For Requested Point" }, { status: 404 })]);
    await assert.rejects(makeClient(fetch).getForecast(48.15, 17.1), (err: unknown) => {
      assert.ok(err instanceof NwsError && err.status === 404);
      return true;
    });
  });
});
