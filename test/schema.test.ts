import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { areasFromUgc, parseAlertCollection } from "../src/nws/schema.ts";
import { collection, rawFeature } from "./helpers.ts";

describe("areasFromUgc", () => {
  it("maps land zones to sorted, de-duplicated state codes", () => {
    assert.deepEqual(areasFromUgc(["TXZ192", "OKC001", "TXZ173"]), { areas: ["OK", "TX"], zoneType: "land" });
  });

  it("classifies coastal, Great Lakes and offshore zones as marine", () => {
    assert.deepEqual(areasFromUgc(["ANZ330", "LMZ740", "PKZ052"]), { areas: [], zoneType: "marine" });
  });

  it("treats an alert touching both land and water as land", () => {
    assert.deepEqual(areasFromUgc(["GMZ250", "LAZ073"]), { areas: ["LA"], zoneType: "land" });
  });

  it("recognizes territories", () => {
    assert.deepEqual(areasFromUgc(["PRZ001", "GUZ001"]).areas, ["GU", "PR"]);
  });
});

describe("parseAlertCollection", () => {
  it("normalizes a feature into the Alert shape", () => {
    const polygon = { type: "Polygon", coordinates: [[[-97.8, 30.2], [-97.6, 30.4], [-97.5, 30.2], [-97.8, 30.2]]] };
    const { alerts, rejected } = parseAlertCollection(collection([rawFeature({}, polygon)]));

    assert.equal(rejected, 0);
    assert.equal(alerts.length, 1);
    const a = alerts[0]!;
    assert.equal(a.id, "urn:oid:test.1");
    assert.equal(a.severity, "Severe");
    assert.deepEqual(a.areas, ["TX"]);
    assert.equal(a.zoneType, "land");
    assert.equal(a.geometry?.type, "Polygon");
    assert.deepEqual(a.references, []);
  });

  it("skips invalid features instead of failing the whole feed", () => {
    const bad = rawFeature({ id: undefined, event: undefined });
    const { alerts, rejected } = parseAlertCollection(collection([bad, rawFeature({ id: "urn:oid:ok" })]));
    assert.equal(rejected, 1);
    assert.deepEqual(alerts.map((a) => a.id), ["urn:oid:ok"]);
  });

  it("falls back to Unknown for unexpected severities and drops unsupported geometry", () => {
    const point = { type: "Point", coordinates: [-97.7, 30.3] };
    const [a] = parseAlertCollection(collection([rawFeature({ severity: "Catastrophic" }, point)])).alerts;
    assert.equal(a?.severity, "Unknown");
    assert.equal(a?.geometry, null);
  });

  it("keeps referenced alert ids for update tracking", () => {
    const update = rawFeature({
      messageType: "Update",
      references: [{ "@id": "https://api.weather.gov/alerts/urn:oid:old", identifier: "urn:oid:old", sent: "x" }],
    });
    assert.deepEqual(parseAlertCollection(collection([update])).alerts[0]?.references, ["urn:oid:old"]);
  });

  it("rejects a payload that isn't a FeatureCollection", () => {
    assert.throws(() => parseAlertCollection({ title: "Service Unavailable" }));
  });
});
