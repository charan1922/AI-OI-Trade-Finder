import { getNumberSetting } from '@/lib/config/feature-toggles';
import { prisma } from '@/lib/db';
import { isMarketHours, todayIST } from '@/lib/market-data';
import { minuteOfDayIST } from '@/lib/ist';
import { getTfBoardsForDate, istMinutesNow, tfCandidatesAtMinute } from '@/lib/tf-live/race';
import { TF_RACE_MAX_RANK, WINDOW_END_MIN, WINDOW_START_MIN } from './config';

const TAG = '[TradeSuggest]';

/** Frozen candidate discovery for one poller cycle. */
export interface CandidateSnapshot {
  discoveredAt: number;
  /** Current, tradeable TF Running Race symbols. No legacy mover fallback. */
  sectorEntries: [symbol: string, sector: string][];
  /** Exact TF race symbols worth refreshing first through Fyers. */
  prioritySymbols: string[];
}

/** Loopback base for server-side self-fetches inside the Railway container. */
export function internalOrigin(): string {
  return `http://127.0.0.1:${process.env.PORT ?? '5001'}`;
}

export function internalAuthHeaders(): Record<string, string> {
  const pw = process.env.APP_PASSWORD;
  return pw ? { Authorization: `Basic ${Buffer.from(`x:${pw}`).toString('base64')}` } : {};
}

/** True when the autonomous pass will actually run the candidate scanner. */
export async function isCandidateScanDue(): Promise<boolean> {
  if (!isMarketHours()) return false;
  const [startMin, endMin] = await Promise.all([
    getNumberSetting('WINDOW_START_MIN', WINDOW_START_MIN),
    getNumberSetting('WINDOW_END_MIN', WINDOW_END_MIN),
  ]);
  const minute = minuteOfDayIST();
  const validWindow = startMin < endMin;
  const effectiveStart = validWindow ? startMin : WINDOW_START_MIN;
  const effectiveEnd = validWindow ? endMin : WINDOW_END_MIN;
  return minute >= effectiveStart && minute <= effectiveEnd;
}

/**
 * F&O names a TF candidate may be: not the 'avoid' lot band, not an index, with
 * a live stock future — symbol → sector. One query; shared by the poller's
 * candidate discovery, the trade engine and the /live TF Climbers card so all
 * three judge exactly the same names (operator rule: /live never shows 'avoid').
 */
export async function getTfEligibleSectors(): Promise<Map<string, string>> {
  const rows = await prisma.$queryRawUnsafe<{ symbol: string; sector: string | null }[]>(
    `SELECT f.symbol, f.sector
       FROM fno_stocks f
      WHERE f.isIndex = 0
        AND f.tradeBand != 'avoid'
        AND EXISTS (
          SELECT 1 FROM master_contracts m
           WHERE m.underlying = f.symbol
             AND m.instrument = 'FUTSTK'
             AND m.segment = 'NSE_FNO'
             AND m.expiryDate >= date('now')
        )`
  );
  return new Map(rows.map((row) => [row.symbol, row.sector ?? ''] as const));
}

/**
 * Discover the current TF candidates once and freeze them across the Fyers
 * priority download and subsequent scan: TF's top 20 by R-Factor that are
 * eligible (tfCandidatesAtMinute — no rank-climb filter since 2026-10-08). There
 * is deliberately no NSE-mover or full-universe fallback: if TF is unavailable,
 * candidate discovery is empty and the scanner's TF freshness check fails closed.
 */
export async function discoverCandidateSnapshot(): Promise<CandidateSnapshot> {
  const discoveredAt = Date.now();
  const sectorBySymbol = new Map<string, string>();
  try {
    const eligible = await getTfEligibleSectors();
    const boards = await getTfBoardsForDate(todayIST());
    const race = tfCandidatesAtMinute(boards, istMinutesNow(), TF_RACE_MAX_RANK, new Set(eligible.keys()));
    if (race.available) {
      for (const runner of race.runners) sectorBySymbol.set(runner.symbol, eligible.get(runner.symbol) ?? '');
    }
  } catch (err) {
    console.warn(`${TAG} TF candidate discovery failed (no entry candidates this pass): ${(err as Error).message}`);
  }

  return {
    discoveredAt,
    sectorEntries: [...sectorBySymbol],
    prioritySymbols: [...sectorBySymbol.keys()],
  };
}
