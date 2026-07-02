/**
 * Fyers downloader universe + symbol mapping.
 *
 * Universe = F&O stocks on the /nse/movers page — the NSE variations feed's
 * FOSec group from gainers + losers (~20 each), fetched through the shared 30s
 * pulse cache so this module never adds NSE load on top of the movers page.
 *
 * The universe ACCUMULATES for the trading day: once a symbol makes the movers
 * list it stays tracked until the IST date changes (its candle series must not
 * stop just because it slipped off the top-20). A restart mid-day reseeds from
 * the rows already written to fyers_candles, so nothing is lost. NSE feed
 * failures never shrink the set — they just skip that cycle's refresh.
 *
 * Fyers symbol formats: equity "NSE:RELIANCE-EQ"; current-month stock future
 * "NSE:RELIANCE26JULFUT", with the expiry month resolved from master_contracts
 * (nearest non-expired FUTSTK row — same DB-driven approach as
 * app/api/live/quote/route.ts, no last-Thursday math).
 */

import { prisma } from '@/lib/db';
import { getRecordedSymbols } from '@/lib/fyers/candle-store';
import type { MoverStock } from '@/lib/nse/pulse';
import { getPulseFeed } from '@/lib/nse/pulse-cache';

const TAG = '[FyersSymbols]';
const MONTH_CODES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

type MoversFeed = Record<string, MoverStock[]>;

const g = globalThis as unknown as {
  __fyersUniverse?: { date: string; symbols: Set<string> };
  __fyersFutCache?: { date: string; map: Map<string, string | null> };
};

/** FOSec symbols from one movers feed; [] on failure (caller keeps the accumulated set). */
async function fetchFeedSymbols(feed: 'gainers' | 'losers'): Promise<string[]> {
  try {
    const res = await getPulseFeed<MoversFeed>(feed);
    return (res.data.FOSec ?? []).map((s) => s.symbol).filter(Boolean);
  } catch (err) {
    console.warn(`${TAG} ${feed} feed unavailable: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Today's tracked universe: reseed from DB on day change, then merge the
 * current movers FOSec lists. Only ever grows within a day.
 */
export async function getTrackedUniverse(today: string): Promise<string[]> {
  if (!g.__fyersUniverse || g.__fyersUniverse.date !== today) {
    const seeded = await getRecordedSymbols(today);
    g.__fyersUniverse = { date: today, symbols: new Set(seeded) };
    if (seeded.length > 0) console.log(`${TAG} Reseeded universe from DB: ${seeded.length} symbols`);
  }
  const universe = g.__fyersUniverse.symbols;

  const [gainers, losers] = [await fetchFeedSymbols('gainers'), await fetchFeedSymbols('losers')];
  const fresh = [...gainers, ...losers].filter((s) => !universe.has(s));
  for (const s of fresh) universe.add(s);
  if (gainers.length === 0 && losers.length === 0) {
    console.warn(`${TAG} universe-refresh-failed — continuing with ${universe.size} accumulated symbols`);
  }

  return [...universe].sort();
}

/** Current accumulated universe without refreshing it (status page / poller). */
export function peekUniverse(): { date: string; symbols: string[] } | null {
  if (!g.__fyersUniverse) return null;
  return { date: g.__fyersUniverse.date, symbols: [...g.__fyersUniverse.symbols].sort() };
}

/** Fyers equity symbol for an NSE underlying. */
export function toEqSymbol(symbol: string): string {
  return `NSE:${symbol}-EQ`;
}

/**
 * Fyers current-month stock-future symbol, e.g. "NSE:RELIANCE26JULFUT" —
 * nearest non-expired FUTSTK contract from master_contracts. Null when the
 * underlying has no live future (caller skips FUT + OI for it). Resolutions
 * are cached per day (expiries only change at rollover).
 */
export async function resolveFutSymbol(symbol: string, today: string): Promise<string | null> {
  if (!g.__fyersFutCache || g.__fyersFutCache.date !== today) {
    g.__fyersFutCache = { date: today, map: new Map() };
  }
  const cache = g.__fyersFutCache.map;
  if (cache.has(symbol)) return cache.get(symbol) ?? null;

  const row = await prisma.masterContract.findFirst({
    where: {
      underlying: symbol,
      instrument: 'FUTSTK',
      segment: 'NSE_FNO',
      expiryDate: { gte: new Date() },
    },
    orderBy: { expiryDate: 'asc' },
    select: { expiryDate: true },
  });

  let fut: string | null = null;
  if (row?.expiryDate) {
    const exp = row.expiryDate;
    fut = `NSE:${symbol}${String(exp.getFullYear() % 100).padStart(2, '0')}${MONTH_CODES[exp.getMonth()]}FUT`;
  } else {
    console.warn(`${TAG} No live FUTSTK contract for ${symbol} — recording EQ candles only`);
  }
  cache.set(symbol, fut);
  return fut;
}
