/**
 * Live 5-minute intraday candle store.
 *
 * Why this exists: the R-Factor (and a chart, or an AI agent) needs a stock's
 * intraday 5-min series available AT ANY TIME, at low latency, for MANY F&O names
 * — without per-symbol REST polling (which is rate-limited and high-latency across
 * a large universe). So candles are PERSISTED once and served from the DB / an
 * in-memory hot bar, never re-fetched on read.
 *
 * Two writers feed one table (`intraday_candles`, keyed (symbol, date, bucketTs)):
 *   1. `upsertLiveBar` — the cheap, scalable path. The /live quote route already
 *      polls every watched symbol's LTP every ~5s in ONE batched call; we fold each
 *      poll into the current 5-min bar (open kept, high=max, low=min, close=last).
 *      Zero extra Dhan calls, scales to the whole universe for free. OHLC only —
 *      volume stays 0 until a REST backfill fills it (we never fabricate volume).
 *   2. `recordBackfill` — authoritative Dhan `charts/intraday` bars (true OHLCV),
 *      used for the pre-open morning gap, on-demand single-stock requests, and to
 *      backfill volume for the top names. Overwrites aggregated bars.
 *
 * Storage follows this repo's derived-table convention (see oi-intraday.ts): a
 * lazy `CREATE TABLE IF NOT EXISTS` so it works without a migration, mirrored by
 * the `IntradayCandle` model in schema.prisma so `db push` keeps it.
 *
 * NOTE on latency ceiling: ~5s poll resolution is far finer than a 5-min bar needs
 * (~60 samples/bar). If sub-second / 1-min / tick precision is ever required, the
 * right upgrade is Dhan's WebSocket feed (one connection streams 5000 instruments)
 * feeding this same store — the read API below would not change.
 */

import { prisma } from '@/lib/db';

/** Bars are floored to this grid (seconds) — 5-minute candles. */
export const CANDLE_BUCKET_SEC = 300;

let tableReady = false;

/** Lazily create the table + index (idempotent, no migration required). */
export async function ensureIntradayCandlesTable(): Promise<void> {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS intraday_candles (
      symbol    TEXT    NOT NULL,
      date      TEXT    NOT NULL,
      bucketTs  INTEGER NOT NULL,
      open      REAL    DEFAULT 0,
      high      REAL    DEFAULT 0,
      low       REAL    DEFAULT 0,
      close     REAL    DEFAULT 0,
      volume    REAL    DEFAULT 0,
      source    TEXT    DEFAULT 'agg',
      updatedAt TEXT    NOT NULL,
      PRIMARY KEY (symbol, date, bucketTs)
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_intraday_candles_date ON intraday_candles (date, symbol)`,
  );
  tableReady = true;
}

/** Floor an epoch-ms wall clock to the 5-min bar-start (epoch seconds). */
export function candleBucketFor(nowMs: number): number {
  return Math.floor(nowMs / 1000 / CANDLE_BUCKET_SEC) * CANDLE_BUCKET_SEC;
}

export interface Candle {
  bucketTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: 'rest' | 'agg';
}

/**
 * Fold a poll's price samples into the current 5-min bar for many symbols at once
 * (one batched UPSERT). For each symbol's bucket: first write sets open=high=low=
 * close=price; later writes expand high/low and set close to the latest price
 * (open untouched). Best-effort — callers must not let a storage hiccup break the
 * live response. OHLC only; volume stays 0 here (filled by REST backfill).
 */
export async function upsertLiveBars(
  date: string,
  samples: { symbol: string; price: number }[],
  nowMs: number = Date.now(),
): Promise<void> {
  const usable = samples.filter((s) => s.price > 0);
  if (usable.length === 0) return;
  await ensureIntradayCandlesTable();
  const bucketTs = candleBucketFor(nowMs);
  const at = new Date(nowMs).toISOString();
  const COLS = 10;
  const BATCH = 80;
  for (let i = 0; i < usable.length; i += BATCH) {
    const chunk = usable.slice(i, i + BATCH);
    const placeholders = chunk.map(() => `(${Array(COLS).fill('?').join(',')})`).join(',');
    const params: unknown[] = [];
    for (const s of chunk) {
      params.push(s.symbol, date, bucketTs, s.price, s.price, s.price, s.price, 0, 'agg', at);
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO intraday_candles (symbol, date, bucketTs, open, high, low, close, volume, source, updatedAt)
       VALUES ${placeholders}
       ON CONFLICT(symbol, date, bucketTs) DO UPDATE SET
         high = MAX(high, excluded.high),
         low  = MIN(low,  excluded.low),
         close = excluded.close,
         updatedAt = excluded.updatedAt`,
      ...params,
    );
  }
}

/**
 * Persist authoritative Dhan bars (true OHLCV). INSERT OR REPLACE — these override
 * aggregated bars for the same bucket. Skips the still-forming current bucket so a
 * partial REST bar can't clobber a live one (the live path keeps that one fresh).
 */
export async function recordBackfill(
  symbol: string,
  date: string,
  bars: Omit<Candle, 'source'>[],
  nowMs: number = Date.now(),
): Promise<number> {
  if (bars.length === 0) return 0;
  await ensureIntradayCandlesTable();
  const currentBucket = candleBucketFor(nowMs);
  const at = new Date(nowMs).toISOString();
  const final = bars.filter((b) => b.bucketTs < currentBucket && b.open > 0);
  if (final.length === 0) return 0;

  const COLS = 10;
  const BATCH = 80;
  for (let i = 0; i < final.length; i += BATCH) {
    const chunk = final.slice(i, i + BATCH);
    const placeholders = chunk.map(() => `(${Array(COLS).fill('?').join(',')})`).join(',');
    const params: unknown[] = [];
    for (const b of chunk) {
      params.push(symbol, date, b.bucketTs, b.open, b.high, b.low, b.close, b.volume, 'rest', at);
    }
    await prisma.$executeRawUnsafe(
      `INSERT OR REPLACE INTO intraday_candles
         (symbol, date, bucketTs, open, high, low, close, volume, source, updatedAt)
       VALUES ${placeholders}`,
      ...params,
    );
  }
  return final.length;
}

const toNum = (v: unknown): number => Number(v ?? 0);

/** Read one symbol's full 5-min series for `date`, ascending by time. */
export async function getIntradayCandles(symbol: string, date: string): Promise<Candle[]> {
  await ensureIntradayCandlesTable();
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT bucketTs, open, high, low, close, volume, source
       FROM intraday_candles WHERE symbol = ? AND date = ? ORDER BY bucketTs ASC`,
    symbol,
    date,
  );
  return rows.map((r) => ({
    bucketTs: toNum(r.bucketTs),
    open: toNum(r.open),
    high: toNum(r.high),
    low: toNum(r.low),
    close: toNum(r.close),
    volume: toNum(r.volume),
    source: (r.source === 'rest' ? 'rest' : 'agg') as 'rest' | 'agg',
  }));
}

/** IST minute-of-day for an epoch-second bar start (Dhan timestamps are UTC). */
function istMinuteOfDay(bucketTs: number): number {
  const istSec = bucketTs + 5.5 * 3600;
  return Math.floor((((istSec % 86400) + 86400) % 86400) / 60);
}

/** Opening-range (9:15–9:45 IST) high/low + session high/low — the R-Factor breakout reference. */
export interface SessionContext {
  openRangeHigh: number | null;
  openRangeLow: number | null;
  openRangeComplete: boolean;
  dayHigh: number | null;
  dayLow: number | null;
}

const OPEN_MIN = 9 * 60 + 15; // 555
const ENTRY_MIN = 9 * 60 + 45; // 585

/** Derive the opening range + day high/low from a stored/loaded 5-min series. */
export function deriveSessionContext(bars: Candle[]): SessionContext {
  let orH: number | null = null;
  let orL: number | null = null;
  let dH: number | null = null;
  let dL: number | null = null;
  let lastMinute = -1;
  for (const b of bars) {
    if (!(b.high > 0) || !(b.low > 0)) continue;
    dH = dH === null ? b.high : Math.max(dH, b.high);
    dL = dL === null ? b.low : Math.min(dL, b.low);
    const m = istMinuteOfDay(b.bucketTs);
    if (m >= OPEN_MIN && m < ENTRY_MIN) {
      orH = orH === null ? b.high : Math.max(orH, b.high);
      orL = orL === null ? b.low : Math.min(orL, b.low);
    }
    if (m > lastMinute) lastMinute = m;
  }
  // The last opening-range bar starts at 9:40 (minute 580); seeing it ⇒ range final.
  const openRangeComplete = lastMinute >= ENTRY_MIN - 5 && orH !== null;
  return { openRangeHigh: orH, openRangeLow: orL, openRangeComplete, dayHigh: dH, dayLow: dL };
}

/** Retention: drop candles older than `beforeDate` (YYYY-MM-DD). Returns rows deleted. */
export async function pruneIntradayCandles(beforeDate: string): Promise<number> {
  await ensureIntradayCandlesTable();
  return prisma.$executeRawUnsafe(`DELETE FROM intraday_candles WHERE date < ?`, beforeDate);
}
