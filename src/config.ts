import { z } from "zod";
import { SEVERITIES } from "./nws/types.ts";

const csv = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().regex(/^[A-Z]{2}$/, "use two-letter state codes, e.g. TX,OK")));

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .default("")
  .transform((v) => v === "true" || v === "1");

const optionalUrl = z
  .string()
  .default("")
  .transform((v) => v.trim() || null)
  .pipe(z.url({ protocol: /^https?$/ }).nullable());

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("127.0.0.1"),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(30, "poll no more often than every 30 seconds").default(120),
  NWS_USER_AGENT: z.string().min(1).default("StormPulse/1.0 (self-hosted NWS alert monitor)"),
  DB_PATH: z.string().default("data/stormpulse.db"),
  HISTORY_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(48),
  WEBHOOK_URL: optionalUrl,
  NOTIFY_MIN_SEVERITY: z.enum(SEVERITIES).default("Severe"),
  NOTIFY_AREAS: csv,
  NOTIFY_INCLUDE_MARINE: bool,
  NOTIFY_MAX_PER_POLL: z.coerce.number().int().min(1).max(10).default(5),
  PUBLIC_URL: optionalUrl,
  ADMIN_TOKEN: z
    .string()
    .default("")
    .transform((v) => v || null),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

export interface Config {
  port: number;
  host: string;
  pollIntervalMs: number;
  userAgent: string;
  dbPath: string;
  historyMs: number;
  webhookUrl: string | null;
  notify: {
    minSeverity: Env["NOTIFY_MIN_SEVERITY"];
    areas: string[];
    includeMarine: boolean;
    maxPerPoll: number;
  };
  publicUrl: string | null;
  adminToken: string | null;
  logLevel: Env["LOG_LEVEL"];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    host: e.HOST,
    pollIntervalMs: e.POLL_INTERVAL_SECONDS * 1000,
    userAgent: e.NWS_USER_AGENT,
    dbPath: e.DB_PATH,
    historyMs: e.HISTORY_HOURS * 3_600_000,
    webhookUrl: e.WEBHOOK_URL,
    notify: {
      minSeverity: e.NOTIFY_MIN_SEVERITY,
      areas: e.NOTIFY_AREAS,
      includeMarine: e.NOTIFY_INCLUDE_MARINE,
      maxPerPoll: e.NOTIFY_MAX_PER_POLL,
    },
    publicUrl: e.PUBLIC_URL,
    adminToken: e.ADMIN_TOKEN,
    logLevel: e.LOG_LEVEL,
  };
}
