import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { SEVERITIES, SEVERITY_RANK, type Alert, type Severity, type ZoneType } from "./nws/types.ts";

export interface StoredAlert extends Alert {
  firstSeen: string;
  lastSeen: string;
  active: boolean;
  endedAt: string | null;
}

export interface AlertQuery {
  area?: string;
  severities?: Severity[];
  zone?: ZoneType | "all";
  q?: string;
  limit?: number;
}

export interface PollRun {
  startedAt: string;
  durationMs: number;
  status: "ok" | "not_modified" | "error";
  error: string | null;
  fetched: number;
  added: number;
  updated: number;
  ended: number;
  notified: number;
}

export type Snapshot = { takenAt: string } & Record<Severity, number>;

const ZONE_TYPES: readonly ZoneType[] = ["land", "marine"];

export interface SyncChanges {
  added: Alert[];
  updated: Alert[];
  /** Ids of alerts that were active before this poll and are no longer in the feed. */
  ended: string[];
}

/**
 * SQLite persistence via Node's built-in `node:sqlite` (no native addon to compile).
 * Alerts keep their full JSON in `data`; the columns next to it exist for filtering and indexing.
 */
export class Store {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS alerts (
        id            TEXT PRIMARY KEY,
        event         TEXT NOT NULL,
        severity      TEXT NOT NULL,
        severity_rank INTEGER NOT NULL,
        zone_type     TEXT NOT NULL,
        areas         TEXT NOT NULL,  -- ",CA,NV," so a LIKE '%,CA,%' match is exact
        area_desc     TEXT NOT NULL,
        sent          TEXT NOT NULL,  -- normalized to UTC so it sorts correctly
        data          TEXT NOT NULL,
        first_seen    TEXT NOT NULL,
        last_seen     TEXT NOT NULL,
        active        INTEGER NOT NULL DEFAULT 1,
        ended_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS alerts_active_rank ON alerts (active, severity_rank DESC, sent DESC);

      CREATE TABLE IF NOT EXISTS poll_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at  TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        status      TEXT NOT NULL,
        error       TEXT,
        fetched     INTEGER NOT NULL DEFAULT 0,
        added       INTEGER NOT NULL DEFAULT 0,
        updated     INTEGER NOT NULL DEFAULT 0,
        ended       INTEGER NOT NULL DEFAULT 0,
        notified    INTEGER NOT NULL DEFAULT 0
      );

      -- One row per poll × zone type × severity (zeros included, so the chart has no gaps).
      CREATE TABLE IF NOT EXISTS snapshots (
        taken_at  TEXT NOT NULL,
        zone_type TEXT NOT NULL,
        severity  TEXT NOT NULL,
        n         INTEGER NOT NULL,
        PRIMARY KEY (taken_at, zone_type, severity)
      );
    `);
  }

  close(): void {
    this.#db.close();
  }

  /** True until the first successful poll — used to avoid notifying about the whole backlog on startup. */
  isEmpty(): boolean {
    return this.#db.prepare("SELECT 1 FROM poll_runs WHERE status != 'error' LIMIT 1").get() === undefined;
  }

  /**
   * Reconcile the latest feed with what we have. Runs in one transaction, so readers never
   * see a half-applied poll. Returns what changed so the caller can notify.
   */
  sync(fetched: Alert[], now: string): SyncChanges {
    const known = this.#db.prepare("SELECT id, active FROM alerts").all() as { id: string; active: number }[];
    const activeBefore = new Set(known.filter((r) => r.active).map((r) => r.id));
    const knownIds = new Set(known.map((r) => r.id));

    const changes = diffAlerts(fetched, activeBefore, knownIds);

    const upsert = this.#db.prepare(`
      INSERT INTO alerts (id, event, severity, severity_rank, zone_type, areas, area_desc, sent, data, first_seen, last_seen, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT (id) DO UPDATE SET
        data = excluded.data, severity = excluded.severity, severity_rank = excluded.severity_rank,
        last_seen = excluded.last_seen, active = 1, ended_at = NULL
    `);
    const end = this.#db.prepare("UPDATE alerts SET active = 0, ended_at = ? WHERE id = ?");

    this.#transaction(() => {
      for (const a of fetched) {
        upsert.run(
          a.id, a.event, a.severity, SEVERITY_RANK[a.severity], a.zoneType, `,${a.areas.join(",")},`,
          a.areaDesc, new Date(a.sent).toISOString(), JSON.stringify(a), now, now,
        );
      }
      for (const id of changes.ended) end.run(now, id);
    });

    return changes;
  }

  getAlert(id: string): StoredAlert | null {
    const row = this.#db.prepare("SELECT * FROM alerts WHERE id = ?").get(id) as AlertRow | undefined;
    return row ? fromRow(row) : null;
  }

  listActive(query: AlertQuery = {}): StoredAlert[] {
    const where = ["active = 1"];
    const params: SQLInputValue[] = [];

    if (query.area) {
      where.push("areas LIKE ?");
      params.push(`%,${query.area.toUpperCase()},%`);
    }
    if (query.severities?.length) {
      where.push(`severity IN (${query.severities.map(() => "?").join(",")})`);
      params.push(...query.severities);
    }
    if (query.zone && query.zone !== "all") {
      where.push("zone_type = ?");
      params.push(query.zone);
    }
    if (query.q) {
      where.push("(event LIKE ? ESCAPE '\\' OR area_desc LIKE ? ESCAPE '\\')");
      const like = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like);
    }
    params.push(query.limit ?? 1000);

    const rows = this.#db
      .prepare(`SELECT * FROM alerts WHERE ${where.join(" AND ")} ORDER BY severity_rank DESC, sent DESC LIMIT ?`)
      .all(...params) as unknown as AlertRow[];
    return rows.map(fromRow);
  }


  recordPoll(run: PollRun): void {
    this.#db
      .prepare(
        `INSERT INTO poll_runs (started_at, duration_ms, status, error, fetched, added, updated, ended, notified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(run.startedAt, run.durationMs, run.status, run.error, run.fetched, run.added, run.updated, run.ended, run.notified);
  }

  lastPoll(): PollRun | null {
    const row = this.#db.prepare("SELECT * FROM poll_runs ORDER BY id DESC LIMIT 1").get() as PollRunRow | undefined;
    return row ? fromPollRow(row) : null;
  }

  lastSuccessfulPoll(): PollRun | null {
    const row = this.#db
      .prepare("SELECT * FROM poll_runs WHERE status != 'error' ORDER BY id DESC LIMIT 1")
      .get() as PollRunRow | undefined;
    return row ? fromPollRow(row) : null;
  }

  /** Store the current count of active alerts per severity — the history chart is built from these. */
  recordSnapshot(takenAt: string): void {
    const rows = this.#db
      .prepare("SELECT zone_type, severity, COUNT(*) AS n FROM alerts WHERE active = 1 GROUP BY zone_type, severity")
      .all() as { zone_type: ZoneType; severity: Severity; n: number }[];
    const counts = new Map(rows.map((r) => [`${r.zone_type}|${r.severity}`, r.n]));

    const insert = this.#db.prepare("INSERT OR REPLACE INTO snapshots VALUES (?, ?, ?, ?)");
    this.#transaction(() => {
      for (const zone of ZONE_TYPES) {
        for (const severity of SEVERITIES) insert.run(takenAt, zone, severity, counts.get(`${zone}|${severity}`) ?? 0);
      }
    });
  }

  /**
   * Active-alert counts over time, bucketed to keep the chart light: 10-minute buckets up to two days,
   * hourly beyond that. Each bucket reports the peak count seen inside it.
   */
  snapshotsSince(since: string, zone: ZoneType | "all" = "all"): Snapshot[] {
    const hours = (Date.now() - new Date(since).getTime()) / 3_600_000;
    const bucket = hours <= 48 ? "substr(taken_at, 1, 15) || '0:00Z'" : "substr(taken_at, 1, 13) || ':00:00Z'";
    const rows = this.#db
      .prepare(
        `SELECT ${bucket} AS bucket, severity, MAX(total) AS n FROM (
           SELECT taken_at, severity, SUM(n) AS total FROM snapshots
           WHERE taken_at >= ? AND (? = 'all' OR zone_type = ?)
           GROUP BY taken_at, severity
         ) GROUP BY bucket, severity ORDER BY bucket`,
      )
      .all(since, zone, zone) as { bucket: string; severity: Severity; n: number }[];

    const byBucket = new Map<string, Snapshot>();
    for (const r of rows) {
      let snap = byBucket.get(r.bucket);
      if (!snap) {
        snap = { takenAt: r.bucket, Extreme: 0, Severe: 0, Moderate: 0, Minor: 0, Unknown: 0 };
        byBucket.set(r.bucket, snap);
      }
      snap[r.severity] = r.n;
    }
    return [...byBucket.values()];
  }

  /** Drop old history so the database stays small on a long-running instance. */
  prune(olderThan: string): void {
    this.#transaction(() => {
      this.#db.prepare("DELETE FROM alerts WHERE active = 0 AND ended_at < ?").run(olderThan);
      this.#db.prepare("DELETE FROM snapshots WHERE taken_at < ?").run(olderThan);
      this.#db.prepare("DELETE FROM poll_runs WHERE started_at < ?").run(olderThan);
    });
  }

  #transaction(fn: () => void): void {
    this.#db.exec("BEGIN");
    try {
      fn();
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }
}

/**
 * Pure diff between the previous state and a fresh feed.
 * NWS issues an *update* as a brand-new alert id that references the one it replaces, so a new id
 * pointing at an alert we already know is reported as "updated", not "added".
 */
export function diffAlerts(fetched: Alert[], activeBefore: Set<string>, knownIds: Set<string>): SyncChanges {
  const added: Alert[] = [];
  const updated: Alert[] = [];
  const fetchedIds = new Set<string>();

  for (const alert of fetched) {
    fetchedIds.add(alert.id);
    if (knownIds.has(alert.id)) continue;
    if (alert.references.some((ref) => knownIds.has(ref))) updated.push(alert);
    else added.push(alert);
  }

  const ended = [...activeBefore].filter((id) => !fetchedIds.has(id));
  return { added, updated, ended };
}

interface AlertRow {
  data: string;
  first_seen: string;
  last_seen: string;
  active: number;
  ended_at: string | null;
}

function fromRow(row: AlertRow): StoredAlert {
  return {
    ...(JSON.parse(row.data) as Alert),
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    active: row.active === 1,
    endedAt: row.ended_at,
  };
}

interface PollRunRow {
  started_at: string;
  duration_ms: number;
  status: PollRun["status"];
  error: string | null;
  fetched: number;
  added: number;
  updated: number;
  ended: number;
  notified: number;
}

function fromPollRow(r: PollRunRow): PollRun {
  return {
    startedAt: r.started_at,
    durationMs: r.duration_ms,
    status: r.status,
    error: r.error,
    fetched: r.fetched,
    added: r.added,
    updated: r.updated,
    ended: r.ended,
    notified: r.notified,
  };
}
