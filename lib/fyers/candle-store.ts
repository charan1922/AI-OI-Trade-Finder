/**
 * fyers_candles — live 5-min candle store for the Fyers F&O downloader.
 *
 * One row per (symbol, instrument, date, bucketTs): 'EQ' rows are the
 * underlying equity's OHLCV, 'FUT' rows the current-month stock future's
 * OHLCV plus live open interest attached to whichever bucket was current when
 * the poller sampled the depth API (Fyers history carries no OI).
 *
 * Storage follows the repo's derived-table convention (intraday-candles.ts /
 * oi-intraday.ts): raw CREATE TABLE IF NOT EXISTS so it works without a
 * migration, mirrored by the FyersCandle model in schema.prisma so `db push`
 * keeps it. Only TODAY's rows are retained — pruneToDate() runs each cycle,
 * so the previous session clears itself on the first poll of a new day.
 *
 * Candle upserts deliberately use ON CONFLICT DO UPDATE that leaves `oi`
 * untouched (a plain INSERT OR REPLACE would zero previously-attached OI on
 * every full-day refetch); attachFutOi() updates only `oi`. Either write can
 * land first — the row converges to candle OHLCV + latest OI.
 */

import { prisma } from '@/lib/db';
import type { FyersBar } from '@/lib/fyers/client';

/** Bars sit on this grid (seconds) — 5-minute candles, bar-START stamps. */
export const FYERS_BUCKET_SEC = 300;

export type FyersInstrument = 'EQ' | 'FUT';

let tableReady = false;

/** Lazily create the table + index (idempotent, no migration required). */
export async function ensureFyersCandlesTable(): Promise<void> {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS fyers_candles (
      symbol     TEXT    NOT NULL,
      instrument TEXT    NOT NULL,
      date       TEXT    NOT NULL,
      bucketTs   INTEGER NOT NULL,
      open       REAL    DEFAULT 0,
      high       REAL    DEFAULT 0,
      low        REAL    DEFAULT 0,
      close      REAL    DEFAULT 0,
      volume     REAL    DEFAULT 0,
      oi         REAL    DEFAULT 0,
      updatedAt  TEXT    NOT NULL,
      PRIMARY KEY (symbol, instrument, date, bucketTs)
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_fyers_candles_date ON fyers_candles (date, symbol, instrument)`,
  );
  tableReady = true;
}

/** Floor an epoch-ms wall clock to the 5-min bar-start (epoch seconds). */
export function fyersBucketFor(nowMs: number): number {
  return Math.floor(nowMs / 1000 / FYERS_BUCKET_SEC) * FYERS_BUCKET_SEC;
}

/**
 * Upsert one symbol+instrument's full-day bar set. Idempotent: the PK dedupes,
 * completed bars overwrite with identical values, and the still-forming current
 * bar just gets fresher OHLCV each cycle. Returns rows written.
 */
export async function upsertCandles(
  symbol: string,
  instrument: FyersInstrument,
  date: string,
  bars: FyersBar[],
  nowMs: number = Date.now(),
): Promise<number> {
  const usable = bars.filter((b) => b.open > 0);
  if (usable.length === 0) return 0;
  await ensureFyersCandlesTable();
  const at = new Date(nowMs).toISOString();

  const COLS = 11;
  const BATCH = 80; // 11 cols × 80 rows = 880 params, under SQLite's 999 limit
  for (let i = 0; i < usable.length; i += BATCH) {
    const chunk = usable.slice(i, i + BATCH);
    const placeholders = chunk.map(() => `(${Array(COLS).fill('?').join(',')})`).join(',');
    const params: unknown[] = [];
    for (const b of chunk) {
      params.push(symbol, instrument, date, b.bucketTs, b.open, b.high, b.low, b.close, b.volume, 0, at);
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO fyers_candles (symbol, instrument, date, bucketTs, open, high, low, close, volume, oi, updatedAt)
       VALUES ${placeholders}
       ON CONFLICT(symbol, instrument, date, bucketTs) DO UPDATE SET
         open = excluded.open,
         high = excluded.high,
         low  = excluded.low,
         close = excluded.close,
         volume = excluded.volume,
         updatedAt = excluded.updatedAt`,
      ...params,
    );
  }
  return usable.length;
}

/**
 * Attach live futures OI to the current bucket's FUT row. Inserts a zero-OHLCV
 * placeholder if the history write hasn't created the bucket yet (the next
 * candle refresh fills OHLCV without touching oi). Repeat attaches within one
 * bucket overwrite with the latest value.
 */
export async function attachFutOi(
  symbol: string,
  date: string,
  bucketTs: number,
  oi: number,
  nowMs: number = Date.now(),
): Promise<void> {
  await ensureFyersCandlesTable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO fyers_candles (symbol, instrument, date, bucketTs, open, high, low, close, volume, oi, updatedAt)
     VALUES (?, 'FUT', ?, ?, 0, 0, 0, 0, 0, ?, ?)
     ON CONFLICT(symbol, instrument, date, bucketTs) DO UPDATE SET
       oi = excluded.oi,
       updatedAt = excluded.updatedAt`,
    symbol,
    date,
    bucketTs,
    oi,
    new Date(nowMs).toISOString(),
  );
}

/** Retention: keep only `today` — one DELETE handles both cleanup and day rollover. */
export async function pruneToDate(today: string): Promise<number> {
  await ensureFyersCandlesTable();
  return prisma.$executeRawUnsafe(`DELETE FROM fyers_candles WHERE date != ?`, today);
}

const toNum = (v: unknown): number => Number(v ?? 0);

export interface StoredFyersBar extends FyersBar {
  oi: number;
}

/** One symbol's series for `date`, ascending by time. */
export async function getFyersCandles(
  symbol: string,
  date: string,
  instrument: FyersInstrument = 'EQ',
): Promise<StoredFyersBar[]> {
  await ensureFyersCandlesTable();
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT bucketTs, open, high, low, close, volume, oi
       FROM fyers_candles WHERE symbol = ? AND instrument = ? AND date = ? ORDER BY bucketTs ASC`,
    symbol,
    instrument,
    date,
  );
  return rows.map((r) => ({
    bucketTs: toNum(r.bucketTs),
    open: toNum(r.open),
    high: toNum(r.high),
    low: toNum(r.low),
    close: toNum(r.close),
    volume: toNum(r.volume),
    oi: toNum(r.oi),
  }));
}

export interface FyersCoverageRow {
  symbol: string;
  instrument: string;
  bars: number;
  lastBucketTs: number;
  lastOi: number;
}

/** Per-symbol coverage summary for the /fyers status page. */
export async function getFyersCoverage(date: string): Promise<FyersCoverageRow[]> {
  await ensureFyersCandlesTable();
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT symbol, instrument, COUNT(*) AS bars, MAX(bucketTs) AS lastBucketTs, MAX(oi) AS lastOi
       FROM fyers_candles WHERE date = ?
      GROUP BY symbol, instrument
      ORDER BY symbol ASC, instrument ASC`,
    date,
  );
  return rows.map((r) => ({
    symbol: String(r.symbol ?? ''),
    instrument: String(r.instrument ?? ''),
    bars: toNum(r.bars),
    lastBucketTs: toNum(r.lastBucketTs),
    lastOi: toNum(r.lastOi),
  }));
}

/** Distinct symbols already recorded for `date` — reseeds the universe after a restart. */
export async function getRecordedSymbols(date: string): Promise<string[]> {
  await ensureFyersCandlesTable();
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT DISTINCT symbol FROM fyers_candles WHERE date = ? ORDER BY symbol ASC`,
    date,
  );
  return rows.map((r) => String(r.symbol ?? '')).filter(Boolean);
}
