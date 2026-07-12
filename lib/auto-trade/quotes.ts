/**
 * Fresh market reads for the auto-trader — option premium via the same batched
 * Dhan quote the scanner uses (rate-gated inside dhanMarketFeed), spot via the
 * fyers_candles table the poller keeps current (latest 5-min EQ close, ≤5 min
 * old during market hours). REAL numbers only — every field is null when the
 * source has nothing, never fabricated.
 */

import { bestBidAsk, dhanMarketFeed } from '@/lib/dhan/market-feed';
import { prisma } from '@/lib/db';

export interface OptionQuote {
  ltp: number;
  bid: number | null;
  ask: number | null;
  spreadPct: number | null;
}

/** Live quote of one option contract. Null when the feed has no price. */
export async function fetchOptionQuote(optSecurityId: string): Promise<OptionQuote | null> {
  const id = Number(optSecurityId);
  if (!Number.isFinite(id) || id <= 0) return null;
  try {
    const q = await dhanMarketFeed('quote', { NSE_FNO: [id] });
    const oq = q.NSE_FNO?.[String(id)];
    const ltp = oq?.last_price ?? 0;
    if (!oq || ltp <= 0) return null;
    const book = bestBidAsk(oq);
    return {
      ltp,
      bid: book?.bid ?? null,
      ask: book?.ask ?? null,
      spreadPct: book == null ? null : Math.round(book.spreadPct * 100) / 100,
    };
  } catch {
    return null;
  }
}

/** Latest recorded 5-min equity close for a symbol today (the poller's
 *  fyers_candles table). Null when the symbol has no bars yet. */
export async function latestSpot(symbol: string, date: string): Promise<number | null> {
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT close FROM fyers_candles
        WHERE symbol = ? AND instrument = 'EQ' AND date = ?
        ORDER BY bucketTs DESC LIMIT 1`,
      symbol,
      date,
    )) as { close: number }[];
    const close = Number(rows[0]?.close ?? 0);
    return close > 0 ? close : null;
  } catch {
    return null;
  }
}
