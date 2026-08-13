import { getNumberSetting, getToggle } from '@/lib/config/feature-toggles';
import { prisma } from '@/lib/db';
import { isMarketHours, todayIST } from '@/lib/dhan/market-feed';
import { minuteOfDayIST } from '@/lib/ist';
import { getTfBoardsForDate, istMinutesNow, raceAtMinute } from '@/lib/tf-live/race';
import { SCAN_OUTSIDE_WINDOW, TF_RACE_MAX_RANK, WINDOW_END_MIN, WINDOW_START_MIN } from './config';

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
  const [startMin, endMin, scanOutsideWindow] = await Promise.all([
    getNumberSetting('WINDOW_START_MIN', WINDOW_START_MIN),
    getNumberSetting('WINDOW_END_MIN', WINDOW_END_MIN),
    getToggle('SCAN_OUTSIDE_WINDOW', SCAN_OUTSIDE_WINDOW),
  ]);
  const minute = minuteOfDayIST();
  const validWindow = startMin < endMin;
  const effectiveStart = validWindow ? startMin : WINDOW_START_MIN;
  const effectiveEnd = validWindow ? endMin : WINDOW_END_MIN;
  return scanOutsideWindow || (minute >= effectiveStart && minute <= effectiveEnd);
}

/**
 * Discover the current TF Running Race once and freeze it across the Fyers
 * priority download and subsequent scan. There is deliberately no NSE-mover or
 * full-universe fallback: if TF is unavailable, candidate discovery is empty
 * and the scanner's independent TF freshness check fails closed.
 */
export async function discoverCandidateSnapshot(): Promise<CandidateSnapshot> {
  const discoveredAt = Date.now();
  let raceSymbols: string[] = [];
  try {
    const boards = await getTfBoardsForDate(todayIST());
    const race = raceAtMinute(boards, istMinutesNow(), TF_RACE_MAX_RANK);
    if (race.available) raceSymbols = race.runners.map((runner) => runner.symbol);
  } catch (err) {
    console.warn(`${TAG} TF race discovery failed (no entry candidates this pass): ${(err as Error).message}`);
  }

  const sectorBySymbol = new Map<string, string>();
  if (raceSymbols.length > 0) {
    try {
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
      const sector = new Map(rows.map((row) => [row.symbol, row.sector ?? ''] as const));
      for (const symbol of raceSymbols) {
        if (sector.has(symbol)) sectorBySymbol.set(symbol, sector.get(symbol) ?? '');
      }
    } catch (err) {
      console.warn(`${TAG} TF F&O eligibility lookup failed (no entry candidates this pass): ${(err as Error).message}`);
    }
  }

  return {
    discoveredAt,
    sectorEntries: [...sectorBySymbol],
    prioritySymbols: [...sectorBySymbol.keys()],
  };
}
