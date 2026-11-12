import { loadConfig } from "./config.ts";
import { WebhookNotifier } from "./notifier.ts";
import { NwsClient } from "./nws/client.ts";
import { Poller } from "./poller.ts";
import { buildServer } from "./server.ts";
import { Store } from "./store.ts";

const config = loadConfig();
const store = new Store(config.dbPath);
const client = new NwsClient({ userAgent: config.userAgent });

const app = await buildServer({
  store,
  client,
  // The poller needs the server's logger, so it's attached right after the server is built.
  poller: { pollOnce: () => poller.pollOnce(), get busy() { return poller.busy; } },
  pollIntervalMs: config.pollIntervalMs,
  adminToken: config.adminToken,
  logger: { level: config.logLevel },
});

const notifier = new WebhookNotifier({
  url: config.webhookUrl,
  rules: config.notify,
  publicUrl: config.publicUrl,
  logger: app.log,
});

const poller = new Poller({
  client,
  store,
  notifier,
  logger: app.log,
  intervalMs: config.pollIntervalMs,
  retentionMs: config.historyMs,
});

await app.listen({ port: config.port, host: config.host });
app.log.info(
  {
    pollEverySeconds: config.pollIntervalMs / 1000,
    webhook: notifier.enabled ? "enabled" : "dry run",
    notify: config.notify,
  },
  "StormPulse is running",
);
poller.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  poller.stop();
  await app.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
