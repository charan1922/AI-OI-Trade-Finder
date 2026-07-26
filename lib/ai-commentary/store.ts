/**
 * trade_commentary — persisted AI narrations of the scan, so the
 * /trade-commentary page shows them (and history) even when nobody had the app
 * open. One row per generated narration.
 *
 * Raw CREATE TABLE IF NOT EXISTS per the repo's derived-table convention
 * (see oi-intraday.ts) — no migration needed; created lazily on first use.
 */
import { prisma } from '@/lib/db';
import type { StoredPick } from './picks';

let tableReady = false;

export async function ensureCommentaryTable(): Promise<void> {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS trade_commentary (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      date             TEXT    NOT NULL,
      asOf             TEXT    NOT NULL,
      windowActive     INTEGER NOT NULL DEFAULT 0,
      picksCount       INTEGER NOT NULL DEFAULT 0,
      model            TEXT    NOT NULL,
      text             TEXT    NOT NULL,
      picksJson        TEXT    DEFAULT '[]',
      promptTokens     INTEGER,
      completionTokens INTEGER,
      containsExecutionState INTEGER NOT NULL DEFAULT 0,
      createdAt        TEXT    NOT NULL
    )
  `);
  // Additive column for tables created before picksJson existed (SQLite has no
  // ADD COLUMN IF NOT EXISTS — a duplicate ALTER just throws and is ignored).
  try {
    await prisma.$executeRawUnsafe(`ALTER TABLE trade_commentary ADD COLUMN picksJson TEXT DEFAULT '[]'`);
  } catch {
    /* column already exists */
  }
  // Prompt-versioning stamp (lib/prompts): WHICH system prompt wrote this row
  // ('trade-commentary' standalone MiMo, 'auto-trader' merged pass) and its
  // version number in prompt_versions. Same additive-ALTER pattern.
  try {
    await prisma.$executeRawUnsafe(`ALTER TABLE trade_commentary ADD COLUMN promptKey TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    await prisma.$executeRawUnsafe(`ALTER TABLE trade_commentary ADD COLUMN promptVersion INTEGER`);
  } catch {
    /* column already exists */
  }
  // Deterministic privacy flag (PR#22 re-review): 1 when this narration was
  // generated with a real EXECUTION TRUTH line (an actual open/placing/closed
  // trade). Viewer redaction keys off THIS, not off promptKey — the standalone
  // fallback narrator also receives real position state but stores itself as an
  // ordinary 'trade-commentary' row, so a promptKey test let it through.
  try {
    await prisma.$executeRawUnsafe(
      // DEFAULT 1 backfills EXISTING rows as private: they were written before
      // the flag existed and may narrate a real position, so they must not be
      // published to viewers by the act of adding a column. Every new insert
      // passes an explicit value, so the default only ever touches legacy rows.
      `ALTER TABLE trade_commentary ADD COLUMN containsExecutionState INTEGER NOT NULL DEFAULT 1`
    );
  } catch {
    /* column already exists */
  }
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_trade_commentary_date ON trade_commentary (date, id)`);
  tableReady = true;
}

export interface CommentaryRow {
  id: number;
  date: string;
  asOf: string;
  windowActive: boolean;
  picksCount: number;
  model: string;
  text: string;
  picks: StoredPick[];
  promptTokens: number | null;
  completionTokens: number | null;
  /** Which system prompt wrote this row + its prompt_versions number (null on
   *  rows from before versioning existed). */
  promptKey: string | null;
  promptVersion: number | null;
  /** True when a real open/placing/closed trade was in the model's context.
   *  Drives viewer redaction; see commentaryForRole in lib/auth/trading-privacy. */
  containsExecutionState: boolean;
  createdAt: string;
}

export interface InsertCommentary {
  date: string;
  asOf: string;
  windowActive: boolean;
  picksCount: number;
  model: string;
  text: string;
  picks: StoredPick[];
  promptTokens: number | null;
  completionTokens: number | null;
  promptKey?: string | null;
  promptVersion?: number | null;
  /** True when a real open/placing/closed trade was in the model's context.
   *  OMITTING IT MEANS PRIVATE, not public — a writer that forgets to classify
   *  itself must not publish the operator's book to viewers. Every caller
   *  should still set it explicitly; the default is the backstop, not the API. */
  containsExecutionState?: boolean;
}

/**
 * Storage encoding for the viewer-visibility flag. An UNSET flag means the
 * writer did not classify itself, which must store PRIVATE — publishing the
 * operator's book because a caller forgot a field is the failure mode this
 * whole column exists to prevent. Exported (rather than inlined in the INSERT)
 * so the DB-free suite can assert the default without a database.
 */
export function executionStateFlag(containsExecutionState?: boolean): 0 | 1 {
  return (containsExecutionState ?? true) ? 1 : 0;
}

/** Inserts one narration; returns the new row's id (links cycle timelines). */
export async function insertCommentary(row: InsertCommentary): Promise<number> {
  await ensureCommentaryTable();
  const rows = (await prisma.$queryRawUnsafe(
    `INSERT INTO trade_commentary
       (date, asOf, windowActive, picksCount, model, text, picksJson, promptTokens, completionTokens, promptKey, promptVersion, containsExecutionState, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
    row.date,
    row.asOf,
    row.windowActive ? 1 : 0,
    row.picksCount,
    row.model,
    row.text,
    JSON.stringify(row.picks ?? []),
    row.promptTokens,
    row.completionTokens,
    row.promptKey ?? null,
    row.promptVersion ?? null,
    // Fail-private on omission. Matches the legacy-row backfill
    // (ALTER ... DEFAULT 1) and map()'s null handling, so "we don't know" reads
    // the same at every layer.
    executionStateFlag(row.containsExecutionState),
    new Date().toISOString(),
  )) as { id: number | bigint }[];
  return Number(rows[0]?.id ?? 0);
}

interface RawRow {
  id: number;
  date: string;
  asOf: string;
  windowActive: number;
  picksCount: number;
  model: string;
  text: string;
  picksJson: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  promptKey: string | null;
  promptVersion: number | null;
  /** SQLite stores 0/1; map() converts it, exactly like windowActive. */
  containsExecutionState: number | null;
  createdAt: string;
}

function map(r: RawRow): CommentaryRow {
  const { picksJson, windowActive, containsExecutionState, ...rest } = r;
  let picks: StoredPick[] = [];
  try {
    picks = picksJson ? (JSON.parse(picksJson) as StoredPick[]) : [];
  } catch {
    picks = [];
  }
  return {
    ...rest,
    windowActive: windowActive === 1,
    // Legacy rows predate the column and read null — treat them as PRIVATE.
    // A row written before the flag existed may still narrate a real position,
    // so defaulting to public would re-open the very leak this closes.
    containsExecutionState: containsExecutionState == null || containsExecutionState === 1,
    picks,
  };
}

/** The latest date that has any commentary (newest session). Null when empty. */
export async function getLatestCommentaryDate(): Promise<string | null> {
  await ensureCommentaryTable();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT date FROM trade_commentary ORDER BY date DESC LIMIT 1`,
  )) as { date: string }[];
  return rows[0]?.date ?? null;
}

/** Most recent narrations, newest first (optionally filtered to one date). */
export async function getCommentary(opts: { date?: string; limit?: number } = {}): Promise<CommentaryRow[]> {
  await ensureCommentaryTable();
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
  const rows = opts.date
    ? ((await prisma.$queryRawUnsafe(
        `SELECT * FROM trade_commentary WHERE date = ? ORDER BY id DESC LIMIT ?`,
        opts.date,
        limit,
      )) as RawRow[])
    : ((await prisma.$queryRawUnsafe(
        `SELECT * FROM trade_commentary ORDER BY id DESC LIMIT ?`,
        limit,
      )) as RawRow[]);
  return rows.map(map);
}
