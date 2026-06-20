/**
 * NSE official index data via the public `allIndices` endpoint.
 *
 * GET https://www.nseindia.com/api/allIndices returns every NSE index (broad,
 * sectoral, thematic, strategy, fixed-income) with a pre-computed `percentChange`
 * vs the prior close. Unlike Dhan's IDX_I quote — which zeroes `net_change` once
 * the session ends — this carries `previousClose` and stays meaningful 24/7,
 * including weekends. No auth/token required.
 *
 * NSE blocks server-side calls that arrive without a session cookie, so we warm
 * up by visiting nseindia.com first (the same pattern the bhavcopy downloader
 * uses in lib/historify/bhavcopy-service.ts).
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
};
const intOrNull = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
};

/** Visit nseindia.com to obtain the session cookie NSE requires for its APIs. */
async function getNseCookie(): Promise<string> {
  try {
    const res = await fetch('https://www.nseindia.com/', {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    const cookies = res.headers.getSetCookie?.() ?? [];
    return cookies.map((c) => c.split(';')[0]).join('; ');
  } catch {
    return '';
  }
}

/** Fetch + normalize every NSE index. Throws on a non-OK response. */
export async function fetchNseAllIndices(): Promise<NseIndicesResult> {
  const cookie = await getNseCookie();
  const res = await fetch('https://www.nseindia.com/api/allIndices', {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://www.nseindia.com/',
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`NSE allIndices HTTP ${res.status} — ${res.statusText}`);
  }
  const json = (await res.json()) as { timestamp?: string; data?: Record<string, unknown>[] };

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
