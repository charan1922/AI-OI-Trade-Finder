/**
 * Batched price snapshots for F&O names OUTSIDE the priority set (Fyers
 * Standard plan, 2026-11-17): one quotes call per 50 symbols per cycle instead
 * of 3 calls per symbol. Kept in their OWN table — a snapshot is a point
 * reading (day open/high/low so far + last price), never a 5-min candle, so it
 * is never written into fyers_candles.
 */
import { prisma } from '@/lib/db';
import { FYERS_CANDLE_RETENTION_SESSIONS } from './candle-store';

export interface QuoteSnapshot {
  symbol: string;
  tsMs: number;
  ltp: number;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  volume: number | null;
}

let ready = false;

async function ensureTable(): Promise<void> {
  if (ready) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS fyers_quote_snapshots (
      symbol    TEXT    NOT NULL,
      date      TEXT    NOT NULL,
      tsMs      INTEGER NOT NULL,
      ltp       REAL    NOT NULL,
      open      REAL,
      high      REAL,
      low       REAL,
      prevClose REAL,
      volume    REAL,
      PRIMARY KEY (symbol, date, tsMs)
    )`);
  ready = true;
}

export async function recordQuoteSnapshots(date: string, rows: QuoteSnapshot[]): Promise<number> {
  if (rows.length === 0) return 0;
  await ensureTable();
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    await prisma.$executeRawUnsafe(
      `INSERT OR REPLACE INTO fyers_quote_snapshots (symbol, date, tsMs, ltp, open, high, low, prevClose, volume)
       VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      ...chunk.flatMap((r) => [r.symbol, date, r.tsMs, r.ltp, r.open, r.high, r.low, r.prevClose, r.volume])
    );
  }
  return rows.length;
}

export async function getLatestQuoteSnapshots(symbols: string[], date: string): Promise<Map<string, QuoteSnapshot>> {
  const out = new Map<string, QuoteSnapshot>();
  if (symbols.length === 0) return out;
  await ensureTable();
  const placeholders = symbols.map(() => '?').join(',');
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT s.* FROM fyers_quote_snapshots s
       JOIN (SELECT symbol, MAX(tsMs) AS tsMs FROM fyers_quote_snapshots
              WHERE date = ? AND symbol IN (${placeholders}) GROUP BY symbol) latest
         ON latest.symbol = s.symbol AND latest.tsMs = s.tsMs
      WHERE s.date = ?`,
    date,
    ...symbols,
    date
  );
  const num = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  for (const r of rows) {
    out.set(String(r.symbol), {
      symbol: String(r.symbol),
      tsMs: Number(r.tsMs),
      ltp: Number(r.ltp),
      open: num(r.open),
      high: num(r.high),
      low: num(r.low),
      prevClose: num(r.prevClose),
      volume: num(r.volume),
    });
  }
  return out;
}

export async function pruneQuoteSnapshotHistory(): Promise<number> {
  await ensureTable();
  return prisma.$executeRawUnsafe(
    `DELETE FROM fyers_quote_snapshots WHERE date NOT IN (
       SELECT DISTINCT date FROM fyers_quote_snapshots ORDER BY date DESC LIMIT ${FYERS_CANDLE_RETENTION_SESSIONS}
     )`
  );
}
