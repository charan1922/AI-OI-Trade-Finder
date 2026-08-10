/**
 * live_urgency_eod — permanent end-of-session copy of the /live "Live Urgency"
 * board, one row per (date, symbol). Captured automatically the first time a
 * post-market poll builds the closing snapshot for a session (see
 * app/api/live/_lib/closing-snapshot.ts) — same LiveUrgencyRow shape the page
 * already renders, just frozen instead of recomputed on every poll.
 *
 * Storage follows the repo's derived-table convention (see oi-intraday.ts):
 * raw CREATE TABLE IF NOT EXISTS via Prisma so it works without a migration,
 * mirrored by the LiveUrgencyEod model in schema.prisma so `db push` keeps it.
 * Writes use INSERT OR IGNORE on (date, symbol) — the FIRST capture each day
 * wins and is frozen forever. This matters because dayHigh/dayLow come from
 * fyers_candles, which only retains TODAY's rows; a later re-capture attempt
 * for an older date would see them as null and must never clobber the good
 * first write with an upsert.
 */

import { prisma } from '@/lib/db';
import type { BreakoutSignal } from '@/lib/breakout';
import type { LiveUrgencyRow, RFactorRowDetail } from '@/app/live/_lib/types';

let tableReady = false;

export async function ensureLiveUrgencyEodTable(): Promise<void> {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS live_urgency_eod (
      date               TEXT    NOT NULL,
      symbol             TEXT    NOT NULL,
      ltp                REAL    DEFAULT 0,
      changePctOpen      REAL,
      spreadPct          REAL,
      imbalance          REAL,
      futOi              REAL,
      oiLevel            REAL,
      turnover           REAL,
      dayHigh            REAL,
      dayLow             REAL,
      sessionOiChangePct REAL,
      oiVelocity         REAL,
      oiAccel            REAL,
      oiUrgency          REAL,
      sinceEntryPct      REAL,
      rFactor            REAL,
      rFactorBias        TEXT,
      rFactorConfidence  REAL,
      rFactorAfterEntry  INTEGER,
      rFactors           TEXT    DEFAULT '[]',
      breakout           TEXT,
      nseOiPct           REAL,
      nseOiSlope30m      REAL,
      capturedAt         TEXT    NOT NULL,
      PRIMARY KEY (date, symbol)
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_live_urgency_eod_date ON live_urgency_eod (date)`);
  // Migrate tables created before these columns existed (the frozen board must
  // persist the close's Breakout verdict + NSE OI% — both are live/same-evening
  // only and can't be recomputed for a past date once fyers_candles is pruned).
  // sinceEntryPct was computed at capture time from the very first version of
  // this table but never added to the schema/INSERT/read-back — a real bug
  // (found 2026-08-06): the live page showed it, but a reload of an already-
  // captured session, or /live/history, always saw it as missing.
  for (const col of [
    'breakout TEXT',
    'sinceEntryPct REAL',
    'nseOiPct REAL',
    'nseOiSlope30m REAL',
  ]) {
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE live_urgency_eod ADD COLUMN ${col}`);
    } catch {
      // column already exists — fine
    }
  }
  tableReady = true;
}

/** The row shape captured — the live board's fields plus the day's high/low
 *  (only available same-day, from fyers_candles, before the next session's
 *  first poll clears it). */
export interface EodRow extends LiveUrgencyRow {
  dayHigh: number | null;
  dayLow: number | null;
}

const COLS = 25;
const BATCH_ROWS = 39; // 25 cols × 39 rows = 975 params, under SQLite's 999 limit

/** Persist one session's rows. Idempotent: INSERT OR IGNORE on (date, symbol)
 *  — repeat calls (e.g. a retried capture) never overwrite an existing row. */
export async function insertEodRows(date: string, rows: EodRow[], nowMs: number = Date.now()): Promise<number> {
  const usable = rows.filter((r) => r.ltp != null && r.ltp > 0);
  if (usable.length === 0) return 0;
  await ensureLiveUrgencyEodTable();
  const capturedAt = new Date(nowMs).toISOString();

  for (let i = 0; i < usable.length; i += BATCH_ROWS) {
    const chunk = usable.slice(i, i + BATCH_ROWS);
    const placeholders = chunk.map(() => `(${Array(COLS).fill('?').join(',')})`).join(',');
    const params: unknown[] = [];
    for (const r of chunk) {
      params.push(
        date,
        r.symbol,
        r.ltp,
        r.changePctOpen,
        r.spreadPct,
        r.imbalance,
        r.futOi,
        r.oiLevel,
        r.turnover,
        r.dayHigh,
        r.dayLow,
        r.sessionOiChangePct,
        r.oiVelocity,
        r.oiAccel,
        r.oiUrgency,
        r.sinceEntryPct ?? null,
        r.rFactor,
        r.rFactorBias,
        r.rFactorConfidence,
        r.rFactorAfterEntry == null ? null : r.rFactorAfterEntry ? 1 : 0,
        JSON.stringify(r.rFactors ?? []),
        r.breakout ? JSON.stringify(r.breakout) : null,
        r.nseOiPct ?? null,
        r.nseOiSlope30m ?? null,
        capturedAt,
      );
    }
    // COLS, the placeholder count and the pushed params are three statements of
    // one number, and SQLite reports a mismatch only as an opaque bind error at
    // write time — post-market, in a fire-and-forget capture nobody is watching.
    // Removing the ten rFactorV2* columns (2026-08-11) left COLS at its old 35
    // while params dropped to 25, so this is not hypothetical.
    if (params.length !== chunk.length * COLS) {
      throw new Error(
        `live_urgency_eod column drift: ${params.length} params for ${chunk.length} rows × ${COLS} cols — ` +
          `update COLS to match the values pushed above.`,
      );
    }
    await prisma.$executeRawUnsafe(
      `INSERT OR IGNORE INTO live_urgency_eod
         (date, symbol, ltp, changePctOpen, spreadPct, imbalance, futOi, oiLevel, turnover,
          dayHigh, dayLow, sessionOiChangePct, oiVelocity, oiAccel, oiUrgency, sinceEntryPct,
          rFactor, rFactorBias, rFactorConfidence, rFactorAfterEntry, rFactors,
          breakout, nseOiPct, nseOiSlope30m, capturedAt)
       VALUES ${placeholders}`,
      ...params,
    );
  }
  return usable.length;
}

/** Session dates with a captured board, newest first. */
export async function getEodDates(): Promise<string[]> {
  await ensureLiveUrgencyEodTable();
  const rows = await prisma.$queryRawUnsafe<{ date: string }[]>(
    `SELECT DISTINCT date FROM live_urgency_eod ORDER BY date DESC`,
  );
  return rows.map((r) => r.date);
}

/** Whether `date` already has a captured board (used to skip re-capture work). */
export async function hasEodCapture(date: string): Promise<boolean> {
  await ensureLiveUrgencyEodTable();
  const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM live_urgency_eod WHERE date = ?`,
    date,
  );
  return (rows[0]?.n ?? 0) > 0;
}

/** The full captured board for one session, ranked by R-Factor (strongest first). */
export async function getEodForDate(date: string): Promise<EodRow[]> {
  await ensureLiveUrgencyEodTable();
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT * FROM live_urgency_eod WHERE date = ? ORDER BY rFactor DESC`,
    date,
  );
  return rows.map(rowToEod);
}

const toNumOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

function safeParseFactors(v: unknown): RFactorRowDetail[] | null {
  try {
    const parsed = JSON.parse(String(v ?? '[]'));
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as RFactorRowDetail[]) : null;
  } catch {
    return null;
  }
}


function safeParseBreakout(v: unknown): BreakoutSignal | null {
  if (v == null) return null;
  try {
    const parsed = JSON.parse(String(v));
    return parsed && typeof parsed === 'object' ? (parsed as BreakoutSignal) : null;
  } catch {
    return null;
  }
}

function rowToEod(r: Record<string, unknown>): EodRow {
  return {
    symbol: String(r.symbol),
    ltp: toNumOrNull(r.ltp),
    changePctOpen: toNumOrNull(r.changePctOpen),
    bid: null, // the order book no longer exists at EOD — never synthesized
    ask: null,
    spreadPct: toNumOrNull(r.spreadPct),
    imbalance: toNumOrNull(r.imbalance),
    futOi: toNumOrNull(r.futOi),
    oiLevel: toNumOrNull(r.oiLevel),
    turnover: toNumOrNull(r.turnover),
    hasDepth: false,
    sessionOiChangePct: toNumOrNull(r.sessionOiChangePct),
    oiVelocity: toNumOrNull(r.oiVelocity),
    oiAccel: toNumOrNull(r.oiAccel),
    oiUrgency: toNumOrNull(r.oiUrgency),
    sinceEntryPct: toNumOrNull(r.sinceEntryPct),
    rFactor: toNumOrNull(r.rFactor),
    rFactorBias: (r.rFactorBias as 'buy' | 'sell' | 'neutral' | null) ?? null,
    rFactorConfidence: toNumOrNull(r.rFactorConfidence),
    rFactorAfterEntry: r.rFactorAfterEntry == null ? null : Number(r.rFactorAfterEntry) === 1,
    rFactors: safeParseFactors(r.rFactors),
    breakout: safeParseBreakout(r.breakout),
    nseOiPct: toNumOrNull(r.nseOiPct),
    nseOiSlope30m: toNumOrNull(r.nseOiSlope30m),
    // Shadow R-Factor, frozen at the close. Null for sessions captured before
    // these columns existed — the board renders "—" for those, never a zero.
    dayHigh: toNumOrNull(r.dayHigh),
    dayLow: toNumOrNull(r.dayLow),
  };
}
