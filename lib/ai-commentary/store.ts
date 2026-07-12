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
}

export async function insertCommentary(row: InsertCommentary): Promise<void> {
  await ensureCommentaryTable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO trade_commentary
       (date, asOf, windowActive, picksCount, model, text, picksJson, promptTokens, completionTokens, promptKey, promptVersion, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    new Date().toISOString(),
  );
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
  createdAt: string;
}

function map(r: RawRow): CommentaryRow {
  const { picksJson, windowActive, ...rest } = r;
  let picks: StoredPick[] = [];
  try {
    picks = picksJson ? (JSON.parse(picksJson) as StoredPick[]) : [];
  } catch {
    picks = [];
  }
  return { ...rest, windowActive: windowActive === 1, picks };
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
