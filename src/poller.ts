import type { NwsClient } from "./nws/client.ts";
import type { Logger, WebhookNotifier } from "./notifier.ts";
import type { PollRun, Store } from "./store.ts";

export interface PollerOptions {
  client: Pick<NwsClient, "getActiveAlerts">;
  store: Store;
  notifier: Pick<WebhookNotifier, "notify">;
  logger: Logger;
  intervalMs: number;
  retentionMs: number;
  now?: () => Date;
}

/**
 * Polls the NWS feed on a fixed interval. Uses a setTimeout chain instead of setInterval so a slow
 * poll can never overlap the next one, and concurrent `pollOnce()` calls share the in-flight run.
 */
export class Poller {
  readonly #opts: PollerOptions;
  readonly #now: () => Date;
  #timer: NodeJS.Timeout | null = null;
  #inFlight: Promise<PollRun> | null = null;
  #stopped = true;
  #consecutiveFailures = 0;

  constructor(opts: PollerOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? (() => new Date());
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#tick();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  get busy(): boolean {
    return this.#inFlight !== null;
  }

  pollOnce(): Promise<PollRun> {
    this.#inFlight ??= this.#run().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #tick(): Promise<void> {
    await this.pollOnce();
    if (this.#stopped) return;
    // Back off while the API is failing (up to 8× the interval), then return to normal.
    const factor = Math.min(2 ** this.#consecutiveFailures, 8);
    this.#timer = setTimeout(() => void this.#tick(), this.#opts.intervalMs * factor);
    this.#timer.unref();
  }

  async #run(): Promise<PollRun> {
    const { client, store, notifier, logger } = this.#opts;
    const started = this.#now();
    const startedAt = started.toISOString();
    const run: PollRun = {
      startedAt, durationMs: 0, status: "ok", error: null, fetched: 0, added: 0, updated: 0, ended: 0, notified: 0,
    };

    try {
      const baseline = store.isEmpty();
      const result = await client.getActiveAlerts();

      if (result.notModified) {
        run.status = "not_modified";
      } else {
        if (result.rejected > 0) logger.warn({ rejected: result.rejected }, "skipped alerts that failed validation");
        const changes = store.sync(result.alerts, startedAt);
        run.fetched = result.alerts.length;
        run.added = changes.added.length;
        run.updated = changes.updated.length;
        run.ended = changes.ended.length;
        // The first poll loads the existing backlog — notifying about hundreds of alerts at once is noise.
        if (!baseline) run.notified = await notifier.notify(changes.added, changes.updated);
      }

      store.recordSnapshot(startedAt);
      store.prune(new Date(started.getTime() - this.#opts.retentionMs).toISOString());
      this.#consecutiveFailures = 0;
    } catch (err) {
      run.status = "error";
      run.error = err instanceof Error ? err.message : String(err);
      this.#consecutiveFailures++;
      logger.error({ err: run.error, failures: this.#consecutiveFailures }, "poll failed");
    }

    run.durationMs = this.#now().getTime() - started.getTime();
    store.recordPoll(run);
    if (run.status !== "error") {
      logger.info(
        { status: run.status, fetched: run.fetched, added: run.added, updated: run.updated, ended: run.ended, notified: run.notified, ms: run.durationMs },
        "poll complete",
      );
    }
    return run;
  }
}
