/**
 * Intraday Open-Interest tracking — the "live urgency" time-series.
 *
 * The live quote endpoint already reads each watchlist name's futures OI on every
 * poll, but until now it kept only the latest value: you could see the OI LEVEL
 * (futOi ÷ 20-session average) but never how fast OI was building RIGHT NOW. That
 * rate-of-change is the real urgency signal a TradeFinder-style trader watches —
 * fresh positions piling on within the session, not a static level.
 *
 * This module persists a per-trading-day OI snapshot series into one
 * date-partitioned table (`oi_intraday`) and derives an urgency score (velocity +
 * acceleration of OI build) from the trailing points. One table keyed by
 * (symbol, date, bucketTs) — NOT a physical table per day — so cross-day queries,
 * retention (a single DELETE), and the simulator/backtest replay stay simple.
 *
 * Storage follows this repo's derived-table convention (see backtest-store.ts):
 * raw `CREATE TABLE IF NOT EXISTS` via Prisma so it works without a migration,
 * mirrored by the `OiIntraday` model in schema.prisma so `db push` keeps it.
 * Writes use INSERT OR IGNORE on the bucketed key, so concurrent tabs / pollers
 * collapse to one row per minute and never duplicate.
 */

import { prisma } from '@/lib/db';

/** Snapshots are floored to this grid (seconds) — one row per symbol per minute. */
export const BUCKET_SEC = 60;
/** Minimum trailing points before urgency is meaningful (else early-session noise). */
export const MIN_URGENCY_POINTS = 3;

let tableReady = false;

/** Lazily create the table + indexes (idempotent, no migration required). */
export async function ensureOiIntradayTable(): Promise<void> {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS oi_intraday (
      symbol        TEXT    NOT NULL,
      date          TEXT    NOT NULL,
      bucketTs      INTEGER NOT NULL,
      capturedAt    TEXT    NOT NULL,
      ltp           REAL    DEFAULT 0,
      futOi         REAL    DEFAULT 0,
      futOiAvg20d   REAL    DEFAULT 0,
      oiLevel       REAL    DEFAULT 0,
      futTurnover   REAL    DEFAULT 0,
      changePctOpen REAL,
      spreadPct     REAL,
      imbalance     REAL,
      PRIMARY KEY (symbol, date, bucketTs)
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_oi_intraday_date ON oi_intraday (date, symbol)`);
  tableReady = true;
}

/** Floor an epoch-ms wall clock to the bucket grid (epoch seconds). */
export function bucketTsFor(nowMs: number): number {
  return Math.floor(nowMs / 1000 / BUCKET_SEC) * BUCKET_SEC;
}

/** One snapshot to persist (a single watchlist row at one poll). */
export interface OiSnapshotInput {
  symbol: string;
  ltp: number | null;
  futOi: number | null;
  futOiAvg20d: number | null;
  oiLevel: number | null;
  futTurnover: number | null;
  changePctOpen: number | null;
  spreadPct: number | null;
  imbalance: number | null;
}

/** A stored point read back for urgency computation, ascending by time. */
export interface OiPoint {
  bucketTs: number;
  ltp: number;
  futOi: number;
  oiLevel: number;
  futTurnover: number;
  changePctOpen: number | null;
  spreadPct: number | null;
  imbalance: number | null;
}

const COLS = 12; // columns per inserted row (keep batches under SQLite's 999-var limit)
const BATCH_ROWS = 60;

/**
 * Append the current poll's snapshots for `date`. Best-effort and idempotent:
 * rows with futOi <= 0 are skipped (a zero-OI row would corrupt velocity), and
 * INSERT OR IGNORE on (symbol, date, bucketTs) dedupes repeat polls within the
 * same minute. Returns how many rows were attempted (not necessarily inserted).
 */
export async function recordIntradayOi(
  date: string,
  snapshots: OiSnapshotInput[],
  nowMs: number = Date.now(),
): Promise<number> {
  const usable = snapshots.filter((s) => (s.futOi ?? 0) > 0);
  if (usable.length === 0) return 0;
  await ensureOiIntradayTable();

  const bucketTs = bucketTsFor(nowMs);
  const capturedAt = new Date(nowMs).toISOString();

  for (let i = 0; i < usable.length; i += BATCH_ROWS) {
    const chunk = usable.slice(i, i + BATCH_ROWS);
    const placeholders = chunk.map(() => `(${Array(COLS).fill('?').join(',')})`).join(',');
    const params: unknown[] = [];
    for (const s of chunk) {
      params.push(
        s.symbol,
        date,
        bucketTs,
        capturedAt,
        s.ltp ?? 0,
        s.futOi ?? 0,
        s.futOiAvg20d ?? 0,
        s.oiLevel ?? 0,
        s.futTurnover ?? 0,
        s.changePctOpen,
        s.spreadPct,
        s.imbalance,
      );
    }
    await prisma.$executeRawUnsafe(
      `INSERT OR IGNORE INTO oi_intraday
         (symbol, date, bucketTs, capturedAt, ltp, futOi, futOiAvg20d, oiLevel, futTurnover, changePctOpen, spreadPct, imbalance)
       VALUES ${placeholders}`,
      ...params,
    );
  }
  return usable.length;
}

const toNum = (v: unknown): number => Number(v ?? 0);
const toNumOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

/** Most recent session date present in the table (rows persist across days). */
export async function getLatestSnapshotDate(): Promise<string | null> {
  await ensureOiIntradayTable();
  const rows = await prisma.$queryRawUnsafe<{ d: string | null }[]>(`SELECT MAX(date) AS d FROM oi_intraday`);
  return rows[0]?.d ?? null;
}

/** Read the full intraday series for one symbol on `date`, ascending by time. */
export async function getIntradaySeries(symbol: string, date: string): Promise<OiPoint[]> {
  await ensureOiIntradayTable();
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT bucketTs, ltp, futOi, oiLevel, futTurnover, changePctOpen, spreadPct, imbalance
       FROM oi_intraday WHERE symbol = ? AND date = ? ORDER BY bucketTs ASC`,
    symbol,
    date,
  );
  return rows.map(rowToPoint);
}

/** Batch variant: series for many symbols in one query, grouped by symbol. */
export async function getIntradaySeriesForSymbols(date: string, symbols: string[]): Promise<Map<string, OiPoint[]>> {
  const out = new Map<string, OiPoint[]>();
  if (symbols.length === 0) return out;
  await ensureOiIntradayTable();
  const placeholders = symbols.map(() => '?').join(',');
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT symbol, bucketTs, ltp, futOi, oiLevel, futTurnover, changePctOpen, spreadPct, imbalance
       FROM oi_intraday WHERE date = ? AND symbol IN (${placeholders}) ORDER BY symbol, bucketTs ASC`,
    date,
    ...symbols,
  );
  for (const r of rows) {
    const sym = String(r.symbol);
    const arr = out.get(sym) ?? [];
    arr.push(rowToPoint(r));
    out.set(sym, arr);
  }
  return out;
}

function rowToPoint(r: Record<string, unknown>): OiPoint {
  return {
    bucketTs: toNum(r.bucketTs),
    ltp: toNum(r.ltp),
    futOi: toNum(r.futOi),
    oiLevel: toNum(r.oiLevel),
    futTurnover: toNum(r.futTurnover),
    changePctOpen: toNumOrNull(r.changePctOpen),
    spreadPct: toNumOrNull(r.spreadPct),
    imbalance: toNumOrNull(r.imbalance),
  };
}

/** Derived urgency from the trailing OI series. */
export interface OiUrgency {
  /** True once >= MIN_URGENCY_POINTS positive-OI points exist. */
  ok: boolean;
  reason?: string;
  /** OI at the session's first captured snapshot. */
  dayOpenOi: number;
  latestOi: number;
  /** (latest − open) / open × 100 — total OI build so far today. */
  sessionOiChangePct: number;
  /** Latest-step OI rate, in ‰ of day-open OI per minute, clamped [−5, +5]. */
  oiVelocity: number;
  /** Change in velocity (is the build itself speeding up), clamped [−3, +3]. */
  oiAccel: number;
  /** Composite 0–10: fast + accelerating + already-significant OI build = urgent. */
  urgencyScore: number;
  /** Number of points used. */
  points: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Pure urgency math from an intraday OI series (ascending). Unit-safe: ΔOI is
 * normalized by the day's OPEN OI (same series, same unit), so it is comparable
 * across small- and large-OI names and does not depend on lot size. Urgency is
 * one-sided — only OI BUILDING (positive) raises the score; unwinding reads zero.
 *
 * Distinct from `oiLevel` (futOi ÷ 20-day avg = a sustained LEVEL): this is the
 * rate-of-change happening NOW. A name can be high-level / low-urgency (already
 * built up) or low-level / high-urgency (igniting this session).
 */
export function computeOiUrgency(series: OiPoint[]): OiUrgency {
  const pts = series.filter((p) => p.futOi > 0).sort((a, b) => a.bucketTs - b.bucketTs);
  const blank: OiUrgency = {
    ok: false,
    dayOpenOi: pts[0]?.futOi ?? 0,
    latestOi: pts[pts.length - 1]?.futOi ?? 0,
    sessionOiChangePct: 0,
    oiVelocity: 0,
    oiAccel: 0,
    urgencyScore: 0,
    points: pts.length,
  };
  if (pts.length < MIN_URGENCY_POINTS) {
    return { ...blank, reason: `only ${pts.length} intraday OI points (need ${MIN_URGENCY_POINTS}+)` };
  }

  const n = pts.length;
  const dayOpenOi = pts[0].futOi;
  const latestOi = pts[n - 1].futOi;
  const ref = Math.max(dayOpenOi, 1);
  const sessionOiChangePct = ((latestOi - dayOpenOi) / ref) * 100;

  // ‰ of day-open OI per minute between two points, clamped.
  const velAt = (i: number): number => {
    const dtMin = Math.max((pts[i].bucketTs - pts[i - 1].bucketTs) / 60, 1);
    return clamp((((pts[i].futOi - pts[i - 1].futOi) / dtMin) / ref) * 1000, -5, 5);
  };
  const oiVelocity = velAt(n - 1);
  const oiVelocityPrev = velAt(n - 2);
  const dtLast = Math.max((pts[n - 1].bucketTs - pts[n - 2].bucketTs) / 60, 1);
  const oiAccel = clamp((oiVelocity - oiVelocityPrev) / dtLast, -3, 3);

  const urgencyScore = clamp(
    2.0 * Math.max(oiVelocity, 0) + 1.5 * Math.max(oiAccel, 0) + 0.5 * clamp(sessionOiChangePct, 0, 6),
    0,
    10,
  );

  return { ok: true, dayOpenOi, latestOi, sessionOiChangePct, oiVelocity, oiAccel, urgencyScore, points: n };
}

/** Retention: drop snapshots older than `beforeDate` (YYYY-MM-DD). Returns rows deleted. */
export async function pruneOiIntraday(beforeDate: string): Promise<number> {
  await ensureOiIntradayTable();
  return prisma.$executeRawUnsafe(`DELETE FROM oi_intraday WHERE date < ?`, beforeDate);
}
