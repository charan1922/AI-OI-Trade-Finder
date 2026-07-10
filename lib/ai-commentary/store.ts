/**
 * trade_commentary — persisted AI narrations of the scan, so the
 * /trade-commentary page shows them (and history) even when nobody had the app
 * open. One row per generated narration.
 *
 * Raw CREATE TABLE IF NOT EXISTS per the repo's derived-table convention
 * (see oi-intraday.ts) — no migration needed; created lazily on first use.
 */
import { prisma } from '@/lib/db';

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
      promptTokens     INTEGER,
      completionTokens INTEGER,
      createdAt        TEXT    NOT NULL
    )
  `);
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
  promptTokens: number | null;
  completionTokens: number | null;
  createdAt: string;
}

export interface InsertCommentary {
  date: string;
  asOf: string;
  windowActive: boolean;
  picksCount: number;
  model: string;
  text: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

export async function insertCommentary(row: InsertCommentary): Promise<void> {
  await ensureCommentaryTable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO trade_commentary
       (date, asOf, windowActive, picksCount, model, text, promptTokens, completionTokens, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.date,
    row.asOf,
    row.windowActive ? 1 : 0,
    row.picksCount,
    row.model,
    row.text,
    row.promptTokens,
    row.completionTokens,
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
  promptTokens: number | null;
  completionTokens: number | null;
  createdAt: string;
}

function map(r: RawRow): CommentaryRow {
  return { ...r, windowActive: r.windowActive === 1 };
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
