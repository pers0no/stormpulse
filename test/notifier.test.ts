import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WebhookNotifier, buildWebhookPayload, selectNotifications, type NotifyRules } from "../src/notifier.ts";
import { alert, fakeFetch, silentLogger } from "./helpers.ts";

const rules: NotifyRules = { minSeverity: "Severe", areas: [], includeMarine: false, maxPerPoll: 5 };

describe("selectNotifications", () => {
  it("applies the severity threshold and sorts the most severe first", () => {
    const picked = selectNotifications(
      [alert({ id: "minor", severity: "Minor" }), alert({ id: "severe" }), alert({ id: "extreme", severity: "Extreme" })],
      [],
      rules,
    );
    assert.deepEqual(picked.map((n) => n.alert.id), ["extreme", "severe"]);
  });

  it("filters by watched states and skips marine alerts unless enabled", () => {
    const added = [
      alert({ id: "tx", areas: ["TX"] }),
      alert({ id: "fl", areas: ["FL"] }),
      alert({ id: "sea", areas: [], zoneType: "marine" }),
    ];
    assert.deepEqual(selectNotifications(added, [], { ...rules, areas: ["tx"] }).map((n) => n.alert.id), ["tx"]);
    assert.deepEqual(
      selectNotifications(added, [], { ...rules, includeMarine: true }).map((n) => n.alert.id),
      ["tx", "fl", "sea"],
    );
  });

  it("labels updates", () => {
    const [n] = selectNotifications([], [alert({ id: "u" })], rules);
    assert.equal(n?.kind, "updated");
  });
});

describe("buildWebhookPayload", () => {
  const items = [{ kind: "new" as const, alert: alert({ event: "Tornado Warning", severity: "Extreme" }) }];

  it("builds Discord embeds for Discord webhook URLs", () => {
    const body = buildWebhookPayload("https://discord.com/api/webhooks/1/abc", items, 2, "https://storm.example.com/");
    const embeds = body.embeds as Array<Record<string, unknown>>;
    assert.equal(embeds.length, 1);
    assert.equal(embeds[0]!.title, "Tornado Warning");
    assert.equal(embeds[0]!.url, "https://storm.example.com/#alert=urn%3Aoid%3Atest.1");
    assert.equal(body.content, "…and 2 more matching alerts.");
  });

  it("builds a Slack-compatible message for anything else", () => {
    const body = buildWebhookPayload("https://hooks.slack.com/services/T/B/X", items, 0, null);
    assert.equal(body.text, "StormPulse: 1 new NWS alert");
    const blocks = body.blocks as Array<{ text: { text: string } }>;
    assert.match(blocks[0]!.text.text, /\*Tornado Warning\* — Travis, TX until/);
  });
});

describe("WebhookNotifier", () => {
  it("posts JSON and reports how many alerts were delivered", async () => {
    const fetch = fakeFetch([new Response("ok")]);
    const notifier = new WebhookNotifier({
      url: "https://hooks.slack.com/services/T/B/X", rules: { ...rules, maxPerPoll: 1 }, publicUrl: null, logger: silentLogger, fetch,
    });
    const sent = await notifier.notify([alert({ id: "1" }), alert({ id: "2" })], []);

    assert.equal(sent, 2);
    assert.equal(fetch.calls[0]!.init?.method, "POST");
    const body = JSON.parse(String(fetch.calls[0]!.init?.body)) as { blocks: Array<{ text: { text: string } }> };
    assert.match(body.blocks[0]!.text.text, /and 1 more matching alert\./);
  });

  it("never throws when the webhook is down", async () => {
    const fetch = fakeFetch([new TypeError("fetch failed")]);
    const notifier = new WebhookNotifier({ url: "https://hooks.slack.com/x", rules, publicUrl: null, logger: silentLogger, fetch });
    assert.equal(await notifier.notify([alert()], []), 0);
  });

  it("does a dry run when no URL is configured", async () => {
    const fetch = fakeFetch([]);
    const notifier = new WebhookNotifier({ url: null, rules, publicUrl: null, logger: silentLogger, fetch });
    assert.equal(await notifier.notify([alert()], []), 0);
    assert.equal(fetch.calls.length, 0);
  });
});
