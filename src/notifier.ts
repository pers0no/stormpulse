import { SEVERITY_RANK, type Alert, type Severity } from "./nws/types.ts";

export interface NotifyRules {
  minSeverity: Severity;
  /** State / territory codes to watch. Empty means the whole country. */
  areas: string[];
  includeMarine: boolean;
  maxPerPoll: number;
}

export interface Notification {
  kind: "new" | "updated";
  alert: Alert;
}

/** Apply the notification rules and sort the most severe first. */
export function selectNotifications(added: Alert[], updated: Alert[], rules: NotifyRules): Notification[] {
  const min = SEVERITY_RANK[rules.minSeverity];
  const watched = new Set(rules.areas.map((a) => a.toUpperCase()));

  const matches = (a: Alert) =>
    SEVERITY_RANK[a.severity] >= min &&
    (rules.includeMarine || a.zoneType === "land") &&
    (watched.size === 0 || a.areas.some((area) => watched.has(area)));

  return [
    ...added.filter(matches).map((alert) => ({ kind: "new" as const, alert })),
    ...updated.filter(matches).map((alert) => ({ kind: "updated" as const, alert })),
  ].sort((x, y) => SEVERITY_RANK[y.alert.severity] - SEVERITY_RANK[x.alert.severity]);
}

const SEVERITY_COLOR: Record<Severity, number> = {
  Extreme: 0x9f1239,
  Severe: 0xdc2626,
  Moderate: 0xea580c,
  Minor: 0xca8a04,
  Unknown: 0x64748b,
};

const SEVERITY_EMOJI: Record<Severity, string> = {
  Extreme: "🟥",
  Severe: "🔴",
  Moderate: "🟠",
  Minor: "🟡",
  Unknown: "⚪",
};

function formatUntil(alert: Alert): string {
  const until = alert.ends ?? alert.expires;
  if (!until) return "";
  const date = new Date(until);
  // NWS timestamps carry the issuing office's offset; show Eastern time so every message reads the same.
  return ` until ${date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  })}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function alertLink(publicUrl: string | null, alert: Alert): string | null {
  return publicUrl ? `${publicUrl.replace(/\/+$/, "")}/#alert=${encodeURIComponent(alert.id)}` : null;
}

/** Discord webhooks take `embeds`; anything else gets a Slack-compatible `text` + `blocks` body. */
export function buildWebhookPayload(
  webhookUrl: string,
  items: Notification[],
  overflow: number,
  publicUrl: string | null,
): Record<string, unknown> {
  const isDiscord = /^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\//.test(webhookUrl);
  const more = overflow > 0 ? `…and ${overflow} more matching alert${overflow === 1 ? "" : "s"}.` : null;

  if (isDiscord) {
    return {
      username: "StormPulse",
      content: more,
      embeds: items.slice(0, 10).map(({ kind, alert }) => ({
        title: truncate(`${kind === "updated" ? "Updated: " : ""}${alert.event}`, 256),
        url: alertLink(publicUrl, alert) ?? undefined,
        description: truncate(alert.areaDesc, 1000),
        color: SEVERITY_COLOR[alert.severity],
        fields: [
          { name: "Severity", value: alert.severity, inline: true },
          { name: "Urgency", value: alert.urgency, inline: true },
          { name: "Issued by", value: alert.senderName, inline: true },
        ],
        footer: { text: `Source: National Weather Service${formatUntil(alert)}` },
        timestamp: new Date(alert.sent).toISOString(),
      })),
    };
  }

  const lines = items.map(({ kind, alert }) => {
    const link = alertLink(publicUrl, alert);
    const title = link ? `<${link}|${alert.event}>` : alert.event;
    const tag = kind === "updated" ? " _(updated)_" : "";
    return `${SEVERITY_EMOJI[alert.severity]} *${title}*${tag} — ${truncate(alert.areaDesc, 180)}${formatUntil(alert)}`;
  });
  if (more) lines.push(more);
  const text = lines.join("\n");

  return {
    text: `StormPulse: ${items.length + overflow} new NWS alert${items.length + overflow === 1 ? "" : "s"}`,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: truncate(text, 3000) } }],
  };
}

export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

export class WebhookNotifier {
  readonly #url: string | null;
  readonly #rules: NotifyRules;
  readonly #publicUrl: string | null;
  readonly #fetch: typeof fetch;
  readonly #log: Logger;

  constructor(opts: {
    url: string | null;
    rules: NotifyRules;
    publicUrl: string | null;
    logger: Logger;
    fetch?: typeof fetch;
  }) {
    this.#url = opts.url;
    this.#rules = opts.rules;
    this.#publicUrl = opts.publicUrl;
    this.#log = opts.logger;
    this.#fetch = opts.fetch ?? globalThis.fetch;
  }

  get enabled(): boolean {
    return this.#url !== null;
  }

  /** Returns how many alerts were delivered. Never throws: a broken webhook must not stop polling. */
  async notify(added: Alert[], updated: Alert[]): Promise<number> {
    const selected = selectNotifications(added, updated, this.#rules);
    if (selected.length === 0) return 0;

    const items = selected.slice(0, this.#rules.maxPerPoll);
    const overflow = selected.length - items.length;

    if (!this.#url) {
      this.#log.info(
        { alerts: items.map((n) => `${n.alert.severity} ${n.alert.event} (${n.alert.areas.join(", ") || "marine"})`) },
        `dry run: ${selected.length} alert(s) match notification rules (set WEBHOOK_URL to deliver)`,
      );
      return 0;
    }

    try {
      const res = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildWebhookPayload(this.#url, items, overflow, this.#publicUrl)),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        this.#log.warn({ status: res.status }, "webhook delivery failed");
        return 0;
      }
      return selected.length;
    } catch (err) {
      this.#log.warn({ err: (err as Error).message }, "webhook delivery failed");
      return 0;
    }
  }
}
