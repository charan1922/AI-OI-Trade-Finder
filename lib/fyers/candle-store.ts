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
 * keeps it. The newest FYERS_CANDLE_RETENTION_SESSIONS sessions are retained —
 * pruneCandleHistory() runs each cycle; today serves /live, the trailing sessions
 * feed the replay benchmark (scripts/replay-lib.ts).
 *
 * Candle upserts deliberately use ON CONFLICT DO UPDATE that leaves `oi`
 * untouched (a plain INSERT OR REPLACE would zero previously-attached OI on
 * every full-day refetch); attachFutDepth() updates only the depth columns. Either write can
 * land first — the row converges to candle OHLCV + latest OI.
 */

import { prisma } from '@/lib/db';
import type { FyersBar } from '@/lib/fyers/client';
import { combinedOiSlope } from '@/lib/signals/combined-oi-slope';

/** Bars sit on this grid (seconds) — 5-minute candles, bar-START stamps. */
export { FYERS_BUCKET_SEC, fyersBucketFor } from './bucket';

export type FyersInstrument = 'EQ' | 'FUT';

let tableReady = false;

/** Depth-derived columns attached to the current FUT bucket (nullable — EQ
 *  rows and pre-recorder buckets stay NULL; values come straight from the
 *  depth response, never derived/fabricated). */
const DEPTH_COLUMNS = ['pdoi', 'oiPct', 'atp', 'dayVolume', 'buyQty', 'sellQty', 'futLtp', 'nseOiPct'] as const;

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
      pdoi       REAL,
      oiPct      REAL,
      atp        REAL,
      dayVolume  REAL,
      buyQty     REAL,
      sellQty    REAL,
      futLtp     REAL,
      nseOiPct   REAL,
      updatedAt  TEXT    NOT NULL,
      PRIMARY KEY (symbol, instrument, date, bucketTs)
    )
  `);
  // Pre-existing tables (created before the depth columns) get them ALTERed in;
  // "duplicate column" failures are the normal already-migrated case.
  for (const col of DEPTH_COLUMNS) {
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE fyers_candles ADD COLUMN ${col} REAL`);
    } catch {
      // column already exists
    }
  }
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_fyers_candles_date ON fyers_candles (date, symbol, instrument)`
  );
  tableReady = true;
}

/** Floor an epoch-ms wall clock to the 5-min bar-start (epoch seconds). */
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
  nowMs: number = Date.now()
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
      ...params
    );
  }
  return usable.length;
}

/** The depth-snapshot fields persisted alongside OI (see lib/fyers/client.ts). */
export interface FutDepthFields {
  oi: number;
  pdoi: number | null;
  oiPct: number | null;
  atp: number | null;
  dayVolume: number | null;
  buyQty: number | null;
  sellQty: number | null;
  futLtp: number | null;
  /** NSE's own combined OI %-change (futures + options, oi-spurts feed) —
   *  stored verbatim from NSE so the series matches /nse/movers exactly. */
  nseOiPct: number | null;
}

/**
 * Attach the live futures depth snapshot (OI + pdoi/VWAP/day volume/book
 * totals/LTP) to the current bucket's FUT row. Inserts a zero-OHLCV
 * placeholder if the history write hasn't created the bucket yet (the next
 * candle refresh fills OHLCV without touching these columns). Repeat attaches
 * within one bucket overwrite with the latest values.
 */
export async function attachFutDepth(
  symbol: string,
  date: string,
  bucketTs: number,
  d: FutDepthFields,
  nowMs: number = Date.now()
): Promise<void> {
  await ensureFyersCandlesTable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO fyers_candles
       (symbol, instrument, date, bucketTs, open, high, low, close, volume,
        oi, pdoi, oiPct, atp, dayVolume, buyQty, sellQty, futLtp, nseOiPct, updatedAt)
     VALUES (?, 'FUT', ?, ?, 0, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, instrument, date, bucketTs) DO UPDATE SET
       oi = excluded.oi,
       pdoi = excluded.pdoi,
       oiPct = excluded.oiPct,
       atp = excluded.atp,
       dayVolume = excluded.dayVolume,
       buyQty = excluded.buyQty,
       sellQty = excluded.sellQty,
       futLtp = excluded.futLtp,
       nseOiPct = excluded.nseOiPct,
       updatedAt = excluded.updatedAt`,
    symbol,
    date,
    bucketTs,
    d.oi,
    d.pdoi,
    d.oiPct,
    d.atp,
    d.dayVolume,
    d.buyQty,
    d.sellQty,
    d.futLtp,
    d.nseOiPct,
    new Date(nowMs).toISOString()
  );
}

/**
 * Sessions of 5-min candles retained. The local 2026-07-15 measurement was
 * ~4.8 MB/session including indexes at 166 symbols (~96 MB for 20 sessions).
 * This must be rechecked against production volume headroom after rollout. Today's
 * rows serve /live; the trailing sessions are the RAW MATERIAL of the replay
 * benchmark (scripts/replay-lib.ts) — a day without candles cannot be
 * replayed, and bhavcopy can't substitute (EOD only, no intraday shape).
 * Today-only retention made every past session unreplayable (2026-07-15:
 * exactly one replayable day existed, so no gate change could be validated).
 */
export const FYERS_CANDLE_RETENTION_SESSIONS = 20;

/** Retention: keep the newest N recorded sessions (today included once its
 *  rows land) — one DELETE handles both cleanup and day rollover. All readers
 *  filter by date, so multi-day retention never leaks into today's views. */
export async function pruneCandleHistory(): Promise<number> {
  await ensureFyersCandlesTable();
  return prisma.$executeRawUnsafe(
    `DELETE FROM fyers_candles WHERE date NOT IN (
       SELECT DISTINCT date FROM fyers_candles ORDER BY date DESC LIMIT ${FYERS_CANDLE_RETENTION_SESSIONS}
     )`
  );
}

/** Sessions still held after retention, oldest first — i.e. exactly the dates
 *  that can still be graded or replayed. Anything older is gone for good. */
export async function getRetainedCandleDates(): Promise<string[]> {
  await ensureFyersCandlesTable();
  const rows = await prisma.$queryRawUnsafe<{ date: string }[]>(
    `SELECT DISTINCT date FROM fyers_candles ORDER BY date ASC`
  );
  return rows.map((r) => r.date);
}

const toNum = (v: unknown): number => Number(v ?? 0);

export interface StoredFyersBar extends FyersBar {
  oi: number;
}

/** One symbol's series for `date`, ascending by time. */
export async function getFyersCandles(
  symbol: string,
  date: string,
  instrument: FyersInstrument = 'EQ'
): Promise<StoredFyersBar[]> {
  await ensureFyersCandlesTable();
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT bucketTs, open, high, low, close, volume, oi
       FROM fyers_candles WHERE symbol = ? AND instrument = ? AND date = ? ORDER BY bucketTs ASC`,
    symbol,
    instrument,
    date
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

/**
 * Status of ONE specific EQ bucket for a symbol on `date`: its start + the epoch
 * ms it was last written (`updatedAt`), or null when that bucket isn't stored.
 * The auto-trade freshness gate (lib/priority-refresh/freshness.ts) asks for the
 * REQUIRED completed bucket and proves it was written AT/AFTER its close time —
 * a bucket fetched while still forming has an earlier write time and reads stale.
 * Cheap PK point-read (no full-day scan).
 */
export async function getEqBucketStatus(
  symbol: string,
  date: string,
  bucketTs: number
): Promise<{ bucketTs: number; updatedAtMs: number } | null> {
  await ensureFyersCandlesTable();
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT bucketTs, updatedAt FROM fyers_candles
      WHERE symbol = ? AND instrument = 'EQ' AND date = ? AND bucketTs = ? AND open > 0`,
    symbol,
    date,
    bucketTs
  );
  const r = rows[0];
  if (!r) return null;
  const updatedAtMs = Date.parse(String(r.updatedAt));
  if (!Number.isFinite(updatedAtMs)) return null;
  return { bucketTs: toNum(r.bucketTs), updatedAtMs };
}

/** One symbol's per-5-min NSE combined OI %-change series for `date` (FUT
 *  rows' nseOiPct, attached each poller cycle), ascending — the input to
 *  lib/signals/combined-oi-slope.ts. Rows with no attach yet carry null. */
export async function getNseOiSeries(
  symbol: string,
  date: string
): Promise<{ bucketTs: number; nseOiPct: number | null }[]> {
  await ensureFyersCandlesTable();
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT bucketTs, nseOiPct FROM fyers_candles
      WHERE symbol = ? AND instrument = 'FUT' AND date = ? ORDER BY bucketTs ASC`,
    symbol,
    date
  );
  return rows.map((r) => ({
    bucketTs: toNum(r.bucketTs),
    nseOiPct: r.nseOiPct == null ? null : Number(r.nseOiPct),
  }));
}

/** Latest NSE combined-OI reading for one symbol (see getNseOiLatestForSymbols). */
export interface NseOiLatest {
  /** NSE's combined (futures+options) OI %-change vs the previous EOD — cumulative. */
  nseOiPct: number;
  /** Trailing ~30-min build in pct-points (combined-oi-slope); null when the series is too short. */
  slope30m: number | null;
  /**
   * Combined OI build in pct-points since OI_WINDOW_START_MIN (09:35 IST) — the
   * OI counterpart of the table's "Since 9:45" price column, answering "how much
   * of today's OI build happened AFTER the open settled" rather than "how much
   * has built since yesterday".
   *
   * Both ends are NSE's own cumulative-vs-previous-EOD figure, so subtracting
   * them yields the intraday build directly — nothing is recomputed from raw OI
   * (operator's point, 2026-08-11: the NSE feed already carries this). Null when
   * no bucket at/after 09:35 has been recorded yet, never 0 — an absent baseline
   * is "no evidence", not "no build".
   */
  sinceWindowPct: number | null;
}

/** IST minute-of-day the intraday OI baseline anchors to — 09:35. Deliberately
 *  NOT 09:30: the first minutes after the open are auction noise, and NSE's
 *  oi-spurts feed is itself still settling then. Chosen with the operator
 *  (2026-08-11) over both 09:30 and the price column's 09:45. */
export const OI_WINDOW_START_MIN = 9 * 60 + 35;

/** Epoch-SECONDS of OI_WINDOW_START_MIN on the given IST calendar date. The
 *  buckets stored in fyers_candles are epoch seconds, so the comparison has to
 *  happen in the same unit — and the IST offset is fixed (+05:30, no DST),
 *  which is why this can be a plain arithmetic conversion. */
export function oiWindowStartTs(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00+05:30`) / 1000) + OI_WINDOW_START_MIN * 60;
}

/**
 * Batched: the latest non-null nseOiPct per symbol for `date`, plus its 30-min
 * slope — ONE query for a whole watchlist (the /live quote route calls this per
 * poll; per-symbol getNseOiSeries would be N queries). Symbols never attached
 * (not in NSE's oi-spurts feed) are simply absent from the map — never faked.
 */
export async function getNseOiLatestForSymbols(symbols: string[], date: string): Promise<Map<string, NseOiLatest>> {
  const out = new Map<string, NseOiLatest>();
  if (symbols.length === 0) return out;
  await ensureFyersCandlesTable();
  const placeholders = symbols.map(() => '?').join(',');
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT symbol, bucketTs, nseOiPct FROM fyers_candles
      WHERE instrument = 'FUT' AND date = ? AND nseOiPct IS NOT NULL AND symbol IN (${placeholders})
      ORDER BY symbol, bucketTs ASC`,
    date,
    ...symbols
  );
  const bySymbol = new Map<string, { bucketTs: number; nseOiPct: number }[]>();
  for (const r of rows) {
    const s = String(r.symbol);
    const arr = bySymbol.get(s) ?? [];
    arr.push({ bucketTs: toNum(r.bucketTs), nseOiPct: Number(r.nseOiPct) });
    bySymbol.set(s, arr);
  }
  const windowStartTs = oiWindowStartTs(date);
  for (const [symbol, series] of bySymbol) {
    const latest = series[series.length - 1];
    // The FIRST reading at or after 09:35 is the baseline. `series` is already
    // ordered by bucketTs ASC from the query above, so find() takes the earliest
    // qualifying bucket. A symbol whose recording only started later simply has
    // no baseline and reports null rather than borrowing an earlier one.
    const baseline = series.find((p) => p.bucketTs >= windowStartTs);
    out.set(symbol, {
      nseOiPct: latest.nseOiPct,
      slope30m: combinedOiSlope(series, latest.bucketTs),
      sinceWindowPct: baseline ? latest.nseOiPct - baseline.nseOiPct : null,
    });
  }
  return out;
}

export interface FyersCoverageRow {
  symbol: string;
  instrument: string;
  bars: number;
  lastBucketTs: number;
  lastOi: number;
  /** Latest FUT depth snapshot (null on EQ rows / before the first attach). */
  pdoi: number | null;
  oiPct: number | null;
  atp: number | null;
  dayVolume: number | null;
  buyQty: number | null;
  sellQty: number | null;
  futLtp: number | null;
  /** NSE's combined OI %-change (futures + options) from the oi-spurts feed. */
  nseOiPct: number | null;
  /** DERIVED equity turnover: Σ(close × volume) over today's EQ bars (₹).
   *  An approximation from recorded 5-min bars, not a broker field. */
  eqTurnover: number | null;
  eqDayVolume: number | null;
}

const toNumOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

/** Per-symbol coverage summary for the /fyers status page. */
export async function getFyersCoverage(date: string): Promise<FyersCoverageRow[]> {
  await ensureFyersCandlesTable();
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT symbol, instrument, COUNT(*) AS bars, MAX(bucketTs) AS lastBucketTs, MAX(oi) AS lastOi
       FROM fyers_candles WHERE date = ?
      GROUP BY symbol, instrument
      ORDER BY symbol ASC, instrument ASC`,
    date
  );
  // Latest depth snapshot per FUT symbol (the newest bucket that has OI).
  const depthRows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT f.symbol, f.pdoi, f.oiPct, f.atp, f.dayVolume, f.buyQty, f.sellQty, f.futLtp, f.nseOiPct
       FROM fyers_candles f
      WHERE f.date = ? AND f.instrument = 'FUT' AND f.oi > 0
        AND f.bucketTs = (
          SELECT MAX(b.bucketTs) FROM fyers_candles b
           WHERE b.date = f.date AND b.symbol = f.symbol AND b.instrument = 'FUT' AND b.oi > 0
        )`,
    date
  );
  const depthBySymbol = new Map(depthRows.map((r) => [String(r.symbol), r]));

  // Derived equity turnover per symbol from today's recorded EQ bars.
  const eqTurnoverRows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT symbol, SUM(close * volume) AS eqTurnover, SUM(volume) AS eqDayVolume
       FROM fyers_candles WHERE date = ? AND instrument = 'EQ' AND volume > 0
      GROUP BY symbol`,
    date
  );
  const eqBySymbol = new Map(eqTurnoverRows.map((r) => [String(r.symbol), r]));

  return rows.map((r) => {
    const d = r.instrument === 'FUT' ? depthBySymbol.get(String(r.symbol)) : undefined;
    const eq = r.instrument === 'EQ' ? eqBySymbol.get(String(r.symbol)) : undefined;
    return {
      symbol: String(r.symbol ?? ''),
      instrument: String(r.instrument ?? ''),
      bars: toNum(r.bars),
      lastBucketTs: toNum(r.lastBucketTs),
      lastOi: toNum(r.lastOi),
      pdoi: toNumOrNull(d?.pdoi),
      oiPct: toNumOrNull(d?.oiPct),
      atp: toNumOrNull(d?.atp),
      dayVolume: toNumOrNull(d?.dayVolume),
      buyQty: toNumOrNull(d?.buyQty),
      sellQty: toNumOrNull(d?.sellQty),
      futLtp: toNumOrNull(d?.futLtp),
      nseOiPct: toNumOrNull(d?.nseOiPct),
      eqTurnover: toNumOrNull(eq?.eqTurnover),
      eqDayVolume: toNumOrNull(eq?.eqDayVolume),
    };
  });
}

/** Distinct symbols already recorded for `date` — reseeds the universe after a restart. */
export async function getRecordedSymbols(date: string): Promise<string[]> {
  await ensureFyersCandlesTable();
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT DISTINCT symbol FROM fyers_candles WHERE date = ? ORDER BY symbol ASC`,
    date
  );
  return rows.map((r) => String(r.symbol ?? '')).filter(Boolean);
}
