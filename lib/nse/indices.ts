/**
 * NSE official index data via the public `allIndices` endpoint.
 *
 * GET https://www.nseindia.com/api/allIndices returns every NSE index (broad,
 * sectoral, thematic, strategy, fixed-income) with a pre-computed `percentChange`
 * vs the prior close. Unlike Dhan's IDX_I quote — which zeroes `net_change` once
 * the session ends — this carries `previousClose` and stays meaningful 24/7,
 * including weekends. No auth/token required.
 */

import { intOrNull, nseApiGet, num } from '@/lib/nse/client';

export interface NseIndex {
  /** indexSymbol, e.g. "NIFTY IT". */
  symbol: string;
  /** Display name (usually identical to symbol). */
  name: string;
  /** NSE's grouping ("key"), e.g. "SECTORAL INDICES", "BROAD MARKET INDICES". */
  category: string;
  last: number;
  previousClose: number;
  /** % change vs previousClose — pre-computed by NSE. */
  percentChange: number;
  /** Absolute points change. */
  variation: number;
  advances: number | null;
  declines: number | null;
  unchanged: number | null;
}

export interface NseIndicesResult {
  /** NSE's own "as of" stamp, e.g. "19-Jun-2026 15:30". */
  timestamp: string | null;
  indices: NseIndex[];
}

/** Fetch + normalize every NSE index. Throws on a non-OK response. */
export async function fetchNseAllIndices(): Promise<NseIndicesResult> {
  const json = await nseApiGet<{ timestamp?: string; data?: Record<string, unknown>[] }>(
    '/api/allIndices',
    { referer: 'https://www.nseindia.com/market-data/live-market-indices', timeoutMs: 7000 },
  );

  const indices: NseIndex[] = (json.data ?? [])
    .map((d) => ({
      symbol: String(d.indexSymbol ?? ''),
      name: String(d.index ?? d.indexSymbol ?? ''),
      category: String(d.key ?? 'OTHER'),
      last: num(d.last),
      previousClose: num(d.previousClose),
      percentChange: num(d.percentChange),
      variation: num(d.variation),
      advances: intOrNull(d.advances),
      declines: intOrNull(d.declines),
      unchanged: intOrNull(d.unchanged),
    }))
    .filter((d) => d.symbol && d.previousClose > 0);

  return { timestamp: json.timestamp ?? null, indices };
}
