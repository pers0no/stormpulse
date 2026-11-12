import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AlertsResult } from "../src/nws/client.ts";
import type { Alert } from "../src/nws/types.ts";
import { Poller } from "../src/poller.ts";
import { Store, diffAlerts } from "../src/store.ts";
import { alert, silentLogger } from "./helpers.ts";

describe("diffAlerts", () => {
  it("separates new, updated and ended alerts", () => {
    const fetched = [
      alert({ id: "a" }), // still active
      alert({ id: "c" }), // brand new
      alert({ id: "b2", messageType: "Update", references: ["b"] }), // replaces b
    ];
    const changes = diffAlerts(fetched, new Set(["a", "b", "z"]), new Set(["a", "b", "z"]));

    assert.deepEqual(changes.added.map((a) => a.id), ["c"]);
    assert.deepEqual(changes.updated.map((a) => a.id), ["b2"]);
    assert.deepEqual(changes.ended.sort(), ["b", "z"]);
  });
});

describe("Store", () => {
  it("syncs, filters and ends alerts", () => {
    const store = new Store(":memory:");
    store.sync(
      [
        alert({ id: "tx", areas: ["TX"], severity: "Severe", event: "Severe Thunderstorm Warning" }),
        alert({ id: "ok", areas: ["OK", "TX"], severity: "Extreme", event: "Tornado Warning" }),
        alert({ id: "sea", areas: [], zoneType: "marine", severity: "Minor", event: "Small Craft Advisory" }),
      ],
      "2026-11-12T18:00:00.000Z",
    );

    assert.deepEqual(store.listActive().map((a) => a.id), ["ok", "tx", "sea"], "most severe first");
    assert.deepEqual(store.listActive({ area: "tx" }).map((a) => a.id), ["ok", "tx"]);
    assert.deepEqual(store.listActive({ area: "OK" }).map((a) => a.id), ["ok"]);
    assert.deepEqual(store.listActive({ zone: "marine" }).map((a) => a.id), ["sea"]);
    assert.deepEqual(store.listActive({ severities: ["Extreme", "Minor"] }).map((a) => a.id), ["ok", "sea"]);
    assert.deepEqual(store.listActive({ q: "tornado" }).map((a) => a.id), ["ok"]);
    assert.deepEqual(store.listActive({ q: "100%" }), [], "LIKE wildcards in the query are escaped");

    const changes = store.sync([alert({ id: "tx", areas: ["TX"] })], "2026-11-12T18:02:00.000Z");
    assert.deepEqual(changes.ended.sort(), ["ok", "sea"]);
    assert.deepEqual(store.listActive().map((a) => a.id), ["tx"]);

    const ended = store.getAlert("ok");
    assert.equal(ended?.active, false);
    assert.equal(ended?.endedAt, "2026-11-12T18:02:00.000Z");
    assert.equal(store.getAlert("tx")?.firstSeen, "2026-11-12T18:00:00.000Z");
  });

  it("records snapshots per zone with zero rows so the history has no gaps", () => {
    const store = new Store(":memory:");
    const now = new Date().toISOString();
    store.sync([alert({ id: "1", severity: "Severe" }), alert({ id: "2", zoneType: "marine", severity: "Minor" })], now);
    store.recordSnapshot(now);

    const since = new Date(Date.now() - 3_600_000).toISOString();
    const [land] = store.snapshotsSince(since, "land");
    assert.equal(land?.Severe, 1);
    assert.equal(land?.Minor, 0);
    const [all] = store.snapshotsSince(since, "all");
    assert.equal(all?.Minor, 1);
  });
});

function fakeClient(results: Array<AlertsResult | Error>) {
  return {
    async getActiveAlerts(): Promise<AlertsResult> {
      const next = results.shift();
      if (!next) throw new Error("no more results");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const feed = (alerts: Alert[]): AlertsResult => ({ notModified: false, alerts, rejected: 0, updated: null });

describe("Poller", () => {
  it("doesn't notify on the first (baseline) poll, then notifies about changes", async () => {
    const store = new Store(":memory:");
    const notified: Array<{ added: string[]; updated: string[] }> = [];
    const notifier = {
      async notify(added: Alert[], updated: Alert[]) {
        notified.push({ added: added.map((a) => a.id), updated: updated.map((a) => a.id) });
        return added.length + updated.length;
      },
    };
    const client = fakeClient([
      feed([alert({ id: "a" })]),
      feed([alert({ id: "a" }), alert({ id: "b" })]),
      { notModified: true },
    ]);
    const poller = new Poller({ client, store, notifier, logger: silentLogger, intervalMs: 60_000, retentionMs: 86_400_000 });

    const first = await poller.pollOnce();
    assert.equal(first.added, 1);
    assert.equal(notified.length, 0, "baseline poll must not notify");

    const second = await poller.pollOnce();
    assert.deepEqual(notified, [{ added: ["b"], updated: [] }]);
    assert.equal(second.notified, 1);

    const third = await poller.pollOnce();
    assert.equal(third.status, "not_modified");
    assert.equal(store.listActive().length, 2);
  });

  it("records failures without throwing and keeps existing data", async () => {
    const store = new Store(":memory:");
    const client = fakeClient([feed([alert({ id: "a" })]), new Error("NWS is down")]);
    const poller = new Poller({
      client, store, notifier: { notify: async () => 0 }, logger: silentLogger, intervalMs: 60_000, retentionMs: 86_400_000,
    });

    await poller.pollOnce();
    const run = await poller.pollOnce();
    assert.equal(run.status, "error");
    assert.equal(run.error, "NWS is down");
    assert.equal(store.lastPoll()?.status, "error");
    assert.equal(store.lastSuccessfulPoll()?.status, "ok");
    assert.equal(store.listActive().length, 1);
  });

  it("shares one in-flight poll between concurrent callers", async () => {
    const store = new Store(":memory:");
    let calls = 0;
    const client = {
      async getActiveAlerts(): Promise<AlertsResult> {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return feed([]);
      },
    };
    const poller = new Poller({
      client, store, notifier: { notify: async () => 0 }, logger: silentLogger, intervalMs: 60_000, retentionMs: 86_400_000,
    });

    const [a, b] = await Promise.all([poller.pollOnce(), poller.pollOnce()]);
    assert.equal(a, b);
    assert.equal(calls, 1);
  });
});
