import type { SectorLeadersResponse } from '@/app/live/_lib/types';
import { getNumberSetting, getToggle } from '@/lib/config/feature-toggles';
import { prisma } from '@/lib/db';
import { isMarketHours } from '@/lib/dhan/market-feed';
import { minuteOfDayIST } from '@/lib/ist';
import { CANDIDATE_SOURCES, SCAN_FULL_UNIVERSE, SCAN_OUTSIDE_WINDOW, WINDOW_END_MIN, WINDOW_START_MIN } from './config';

const TAG = '[TradeSuggest]';

/** Frozen candidate discovery for one poller cycle. */
export interface CandidateSnapshot {
  discoveredAt: number;
  fullUniverse: boolean;
  /** All symbols the scan evaluates, including the optional full-universe tail. */
  sectorEntries: [symbol: string, sector: string][];
  /** Top OI-list membership used as scan evidence. */
  oiSpurtSymbols: string[];
  /** Exact /live mover slices worth refreshing first through Fyers. */
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
 * Discover candidates once and freeze them across the Fyers priority download
 * and the subsequent scan. This prevents the 30s NSE cache from producing a
 * different candidate set after the roughly 80s priority batch.
 */
export async function discoverCandidateSnapshot(): Promise<CandidateSnapshot> {
  const origin = internalOrigin();
  const fullUniverse = await getToggle('SCAN_FULL_UNIVERSE', SCAN_FULL_UNIVERSE);
  const sectorBySymbol = new Map<string, string>();
  const oiSpurtSymbols = new Set<string>();
  const prioritySymbols = new Set<string>();

  // Sequential by design: NSE throttles bursts. Each route applies the exact
  // F&O/non-avoid/live-future filters and display caps used by /live.
  for (const source of CANDIDATE_SOURCES) {
    try {
      const res = await fetch(`${origin}/api/live/nse-watchlist?source=${source}`, {
        cache: 'no-store',
        headers: internalAuthHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as SectorLeadersResponse;
      const picks = (body.picks ?? []).filter((p) => p.symbol);
      for (const pick of picks) {
        prioritySymbols.add(pick.symbol);
        if (!sectorBySymbol.has(pick.symbol)) sectorBySymbol.set(pick.symbol, pick.sector ?? '');
        if (source === 'nse-oi') oiSpurtSymbols.add(pick.symbol);
      }
    } catch (err) {
      console.warn(`${TAG} watchlist source ${source} failed: ${(err as Error).message}`);
    }
  }

  // Full-universe mode still prioritizes the urgent mover slices. Its tail is
  // scanned with fresh Dhan prices and the previous cycle's slow candle context
  // while Fyers refreshes those names in the background.
  if (fullUniverse) {
    try {
      const rows = await prisma.$queryRawUnsafe<{ symbol: string; sector: string | null }[]>(
        `SELECT symbol, sector FROM fno_stocks WHERE isIndex = 0 AND tradeBand != 'avoid'`
      );
      for (const row of rows) {
        if (row.symbol && !sectorBySymbol.has(row.symbol)) sectorBySymbol.set(row.symbol, row.sector ?? '');
      }
    } catch (err) {
      console.warn(`${TAG} full-universe merge failed (movers-only pool this pass): ${(err as Error).message}`);
    }
  }

  return {
    discoveredAt: Date.now(),
    fullUniverse,
    sectorEntries: [...sectorBySymbol],
    oiSpurtSymbols: [...oiSpurtSymbols],
    prioritySymbols: [...prioritySymbols],
  };
}
