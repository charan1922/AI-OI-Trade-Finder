/**
 * Fresh market reads for the auto-trader — option premium via the same batched
 * Dhan quote the scanner uses (rate-gated inside dhanMarketFeed), spot via the
 * fyers_candles table the poller keeps current (latest 5-min EQ close, ≤5 min
 * old during market hours). REAL numbers only — every field is null when the
 * source has nothing, never fabricated.
 *
 * Pricing follows the shared resolveOptionPrice chain (one policy with the
 * scanner): fresh in-book last trade → else bid-ask mid → else no quote. This
 * matters most for the position guard: a held contract with no fresh print
 * used to return NO quote at all, leaving the premium stop/target blind until
 * the next trade printed — the live book always exists, so the guard now
 * keeps a real price to protect the position with.
 */

import { bestBidAsk, dhanMarketFeed } from '@/lib/dhan/market-feed';
import { prisma } from '@/lib/db';
import { resolveOptionPrice } from '@/lib/trade-suggest/premiums';

export interface OptionQuote {
  /** Resolved premium: last trade when fresh, bid-ask mid otherwise (see priceSource). */
  ltp: number;
  /** 'ltp' = a real trade print, 'mid' = bid-ask mid of live resting orders. */
  priceSource: 'ltp' | 'mid';
  bid: number | null;
  ask: number | null;
  spreadPct: number | null;
}

/**
 * Live quotes for many option contracts in ONE Dhan request. Dhan accepts up
 * to 1000 instruments per quote call, while auto-trade allows at most four
 * open lots, so the guard never needs one request per position.
 */
export async function fetchOptionQuotes(optSecurityIds: readonly string[]): Promise<Map<string, OptionQuote>> {
  const ids = [...new Set(optSecurityIds.map(Number).filter((id) => Number.isFinite(id) && id > 0))];
  const out = new Map<string, OptionQuote>();
  if (ids.length === 0) return out;
  try {
    const q = await dhanMarketFeed('quote', { NSE_FNO: ids });
    const unpriced: string[] = [];
    for (const id of ids) {
      const oq = q.NSE_FNO?.[String(id)];
      if (!oq) {
        unpriced.push(`${id}: not in quote response`);
        continue;
      }
      const book = bestBidAsk(oq);
      const resolved = resolveOptionPrice(oq.last_price ?? 0, book);
      if (resolved == null) {
        unpriced.push(`${id}: no last trade and no order book`);
        continue;
      }
      out.set(String(id), {
        ltp: Math.round(resolved.price * 100) / 100,
        priceSource: resolved.source,
        bid: book?.bid ?? null,
        ask: book?.ask ?? null,
        spreadPct: book == null ? null : Math.round(book.spreadPct * 100) / 100,
      });
    }
    if (unpriced.length > 0) console.warn(`[AutoTrade] unpriceable option quote(s): ${unpriced.join(' · ')}`);
  } catch {
    // A missing live quote must never stop deterministic spot-level checks.
  }
  return out;
}

/** Live quote of one option contract. Null when the feed has no price. */
export async function fetchOptionQuote(optSecurityId: string): Promise<OptionQuote | null> {
  const id = Number(optSecurityId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return (await fetchOptionQuotes([optSecurityId])).get(String(id)) ?? null;
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
      date
    )) as { close: number }[];
    const close = Number(rows[0]?.close ?? 0);
    return close > 0 ? close : null;
  } catch {
    return null;
  }
}
