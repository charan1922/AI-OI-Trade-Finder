/**
 * Server-side inputs for the market-sideways gate (lib/tf-live/market-sideways.ts).
 *
 * - F&O stocks: today's recorded EQ 5-min bars (fyers_candles), ONE query, only
 *   bars COMPLETED before the decision minute (no lookahead); "yesterday's close"
 *   = the previous recorded session's last close.
 * - NIFTY: not recorded by the poller, so it comes from Fyers history
 *   (NSE:NIFTY50-INDEX) through the official rate-limit gate, CACHED per date +
 *   5-min bucket — /live polls every 30 s, and must not multiply broker calls.
 *
 * Any failure degrades to "unknown" (stuck = null), which never blocks: a broken
 * NIFTY fetch must not silently stop every entry.
 */

import { prisma } from '@/lib/db';
import { fetchHistory5m } from '@/lib/fyers/client';
import { classifyMarketSideways, type MarketSideways, type SidewaysStock } from '@/lib/tf-live/market-sideways';

const NIFTY_SYMBOL = 'NSE:NIFTY50-INDEX';

interface Bar {
  bucketTs: number;
  high: number;
  low: number;
  close: number;
}

/** IST minute-of-day for a 5-min bucket (seconds). IST is a fixed +05:30 — no DST. */
const istMin = (sec: number) => Math.floor(((sec + 19800) % 86400) / 60);

/** The full 30-min opening range (09:15–09:45), or null until all six bars exist. */
function openRange(bars: Bar[]): { high: number; low: number } | null {
  const or = bars.filter((b) => b.high > 0 && istMin(b.bucketTs) >= 9 * 60 + 15 && istMin(b.bucketTs) < 9 * 60 + 45);
  if (or.length < 6) return null;
  return { high: Math.max(...or.map((b) => b.high)), low: Math.min(...or.map((b) => b.low)) };
}

const g = globalThis as unknown as { __niftySidewaysBars?: { key: string; bars: Bar[] } };

async function niftyBars(date: string, asOfMinute: number): Promise<Bar[]> {
  const key = `${date}|${Math.floor(asOfMinute / 5)}`;
  if (g.__niftySidewaysBars?.key === key) return g.__niftySidewaysBars.bars;
  let bars: Bar[] = [];
  try {
    bars = (await fetchHistory5m(NIFTY_SYMBOL, date)).map((b) => ({
      bucketTs: Number(b.bucketTs),
      high: b.high,
      low: b.low,
      close: b.close,
    }));
  } catch (error) {
    console.warn(`[MarketSideways] NIFTY bars unavailable: ${(error as Error).message}`);
  }
  // Cache even an empty answer for this bucket: one failed call per 5 min, not one per /live poll.
  g.__niftySidewaysBars = { key, bars };
  return bars;
}

export async function loadMarketSideways(date: string, asOfMinute: number): Promise<MarketSideways> {
  const completed = <T extends { bucketTs: number }>(bars: T[]) => bars.filter((b) => istMin(b.bucketTs) + 5 <= asOfMinute);
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT symbol, bucketTs, high, low, close FROM fyers_candles
        WHERE date = ? AND instrument = 'EQ' ORDER BY symbol, bucketTs`,
      date
    )) as { symbol: string; bucketTs: number | bigint; high: number; low: number; close: number }[];
    const prev = (await prisma.$queryRawUnsafe(
      `SELECT f.symbol, f.close FROM fyers_candles f
        WHERE f.instrument = 'EQ'
          AND f.date = (SELECT MAX(date) FROM fyers_candles WHERE instrument = 'EQ' AND date < ?)
          AND f.bucketTs = (SELECT MAX(bucketTs) FROM fyers_candles x
                             WHERE x.instrument = 'EQ' AND x.symbol = f.symbol AND x.date = f.date)`,
      date
    )) as { symbol: string; close: number }[];
    const prevClose = new Map(prev.map((p) => [p.symbol, Number(p.close)]));

    const bySym = new Map<string, Bar[]>();
    for (const r of rows) {
      const list = bySym.get(r.symbol) ?? [];
      list.push({ bucketTs: Number(r.bucketTs), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
      bySym.set(r.symbol, list);
    }
    const stocks: SidewaysStock[] = [...bySym].map(([symbol, bars]) => {
      const prior = completed(bars);
      const or = openRange(prior);
      const last = prior[prior.length - 1]?.close ?? null;
      const pc = prevClose.get(symbol) ?? null;
      return {
        insideOwnRange: or == null || last == null ? null : last <= or.high && last >= or.low,
        dayChangePct: pc == null || !(pc > 0) || last == null ? null : ((last - pc) / pc) * 100,
      };
    });

    const nPrior = completed(await niftyBars(date, asOfMinute));
    return classifyMarketSideways({
      niftyRange: openRange(nPrior),
      niftyLast: nPrior[nPrior.length - 1]?.close ?? null,
      stocks,
    });
  } catch (error) {
    console.warn(`[MarketSideways] inputs unreadable: ${(error as Error).message}`);
    return classifyMarketSideways({ niftyRange: null, niftyLast: null, stocks: [] });
  }
}
