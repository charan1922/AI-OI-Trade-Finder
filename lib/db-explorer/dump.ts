/**
 * In-process builder for a trimmed (or full) copy of the live SQLite DB, used by
 * POST /api/db-explorer/dump so `pnpm db:pull-prod` can pull prod data down over
 * HTTPS — no SSH, no shell. (Replaced the old ssh-into-the-box transport, which
 * broke whenever the laptop's IP changed or the box was powered off overnight;
 * 443 is always open and authenticated.)
 *
 * Runs entirely on the server that owns the DB: opens a fresh better-sqlite3
 * connection on a temp file, ATTACHes the live DB, and copies tables into it.
 * The live DB is only ever READ (SELECT) — never written — and WAL mode lets
 * these reads run concurrently with the app's own writes. The temp file is the
 * caller's to stream out and delete.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

/** Tables copied in FULL for the curated subset (small, needed by /live + scanner). */
const FULL_TABLES = [
  'fno_stocks',
  'master_contracts',
  'bhavcopy_days',
  'live_urgency_eod',
  'fno_expiry_calendar',
  'market_holidays',
  'feature_toggles',
  'trade_band_ranges',
  'band_overrides',
] as const;

/** Tables trimmed to their latest snapshot date only (these grow every 5 min;
 *  locally we only need the freshest day). Value = the date column to filter on. */
const LATEST_DATE_TABLES: Record<string, string> = {
  oi_intraday: 'date',
  fyers_candles: 'date',
  rank_snapshots: 'date',
};

/** Absolute path to this server's live DB (mirrors lib/db.ts). */
function liveDbPath(): string {
  return process.env.VERCEL === '1' ? '/tmp/project-r.db' : path.join(process.cwd(), 'data', 'project-r.db');
}

/**
 * Build the copy and return its temp-file path. `full` = every user table +
 * indexes/triggers/views; otherwise the curated subset above. Caller deletes it.
 */
export function buildDumpFile(full: boolean): string {
  const prodPath = liveDbPath();
  const tmpPath = path.join(os.tmpdir(), `pr-dump-${process.pid}-${Date.now()}.db`);
  try {
    fs.unlinkSync(tmpPath);
  } catch {
    // no stale temp — fine
  }

  const db = new Database(tmpPath);
  try {
    db.pragma('busy_timeout = 60000'); // the app holds the live DB open (WAL); wait it out
    db.exec(`ATTACH DATABASE '${prodPath.replace(/'/g, "''")}' AS prod`);

    const exists = (name: string): boolean =>
      Boolean(db.prepare("SELECT 1 FROM prod.sqlite_master WHERE type='table' AND name=?").get(name));
    const create = (name: string): boolean => {
      const row = db.prepare("SELECT sql FROM prod.sqlite_master WHERE type='table' AND name=?").get(name) as
        | { sql?: string }
        | undefined;
      if (!row?.sql) return false;
      db.exec(row.sql);
      return true;
    };
    const copyFull = (name: string): void => {
      create(name);
      db.exec(`INSERT INTO main."${name}" SELECT * FROM prod."${name}"`);
    };

    if (full) {
      // Every user table. sqlite_% internals are recreated implicitly (sequence
      // by AUTOINCREMENT, stat* by ANALYZE) — never copied.
      const tables = db
        .prepare("SELECT name FROM prod.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[];
      for (const { name } of tables) copyFull(name);
      // Indexes / triggers / views last — they reference the tables just created.
      const objs = db
        .prepare(
          "SELECT type, name, sql FROM prod.sqlite_master WHERE type IN ('index','trigger','view') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
        )
        .all() as { type: string; name: string; sql: string }[];
      for (const o of objs) {
        try {
          db.exec(o.sql);
        } catch {
          // a dependent object may already exist / be redundant — skip it
        }
      }
    } else {
      for (const t of FULL_TABLES) {
        if (exists(t)) copyFull(t);
      }
      for (const [t, col] of Object.entries(LATEST_DATE_TABLES)) {
        if (!exists(t)) continue;
        create(t);
        db.exec(
          `INSERT INTO main."${t}" SELECT * FROM prod."${t}" WHERE ${col} = (SELECT MAX(${col}) FROM prod."${t}")`
        );
      }
    }

    db.exec('VACUUM'); // compact the temp copy before it's streamed
  } finally {
    db.close();
  }
  return tmpPath;
}
