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
  /** Displayed size at the best bid/ask. Null when there is no book at all.
   *  The PROFIT TARGET requires the bid to actually hold the whole position —
   *  a ₹120 bid for 5 units is not a ₹120 exit for 500. Stops deliberately
   *  ignore this: capital protection must not wait for depth to appear. */
  bidQty: number | null;
  askQty: number | null;
  spreadPct: number | null;
}

/** Health of one batched quote request — the guard uses this to know when it
 *  has gone BLIND (a swallowed quote error is indistinguishable from "no stop
 *  hit"; AT-005 made that distinction mandatory). */
export interface QuoteBatchResult {
  quotes: Map<string, OptionQuote>;
  /** True when the Dhan request itself succeeded (individual contracts can
   *  still be unpriceable — those are listed in missingIds). */
  sourceOk: boolean;
  error: string | null;
  missingIds: string[];
}

/**
 * Live quotes for many option contracts in ONE Dhan request, WITH health.
 * Dhan accepts up to 1000 instruments per quote call, while auto-trade allows
 * at most four open lots, so the guard never needs one request per position.
 */
export async function fetchOptionQuotesWithHealth(optSecurityIds: readonly string[]): Promise<QuoteBatchResult> {
  const ids = [...new Set(optSecurityIds.map(Number).filter((id) => Number.isFinite(id) && id > 0))];
  const out: QuoteBatchResult = { quotes: new Map(), sourceOk: true, error: null, missingIds: [] };
  if (ids.length === 0) return out;
  try {
    const q = await dhanMarketFeed('quote', { NSE_FNO: ids });
    const unpriced: string[] = [];
    for (const id of ids) {
      const oq = q.NSE_FNO?.[String(id)];
      if (!oq) {
        unpriced.push(`${id}: not in quote response`);
        out.missingIds.push(String(id));
        continue;
      }
      const book = bestBidAsk(oq);
      const resolved = resolveOptionPrice(oq.last_price ?? 0, book);
      if (resolved == null) {
        unpriced.push(`${id}: no last trade and no order book`);
        out.missingIds.push(String(id));
        continue;
      }
      // Size at the touch, straight from the same depth ladder bestBidAsk()
      // reads its prices from — so price and size always describe one book.
      const topBid = oq.depth?.buy?.[0];
      const topAsk = oq.depth?.sell?.[0];
      out.quotes.set(String(id), {
        ltp: Math.round(resolved.price * 100) / 100,
        priceSource: resolved.source,
        bid: book?.bid ?? null,
        ask: book?.ask ?? null,
        bidQty: book == null || topBid?.quantity == null ? null : Number(topBid.quantity),
        askQty: book == null || topAsk?.quantity == null ? null : Number(topAsk.quantity),
        spreadPct: book == null ? null : Math.round(book.spreadPct * 100) / 100,
      });
    }
    if (unpriced.length > 0) console.warn(`[AutoTrade] unpriceable option quote(s): ${unpriced.join(' · ')}`);
  } catch (err) {
    // The request itself failed — callers holding positions must treat this as
    // GUARD BLINDNESS, not as "no stop hit". Spot-level checks continue.
    out.sourceOk = false;
    out.error = (err as Error).message;
    out.missingIds = ids.map(String);
  }
  return out;
}

/** Back-compat map-only wrapper (context building, paper fills). The position
 *  guard uses fetchOptionQuotesWithHealth so failures are never silent. */
export async function fetchOptionQuotes(optSecurityIds: readonly string[]): Promise<Map<string, OptionQuote>> {
  return (await fetchOptionQuotesWithHealth(optSecurityIds)).quotes;
}

/** Live quote of one option contract. Null when the feed has no price. */
export async function fetchOptionQuote(optSecurityId: string): Promise<OptionQuote | null> {
  const id = Number(optSecurityId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return (await fetchOptionQuotes([optSecurityId])).get(String(id)) ?? null;
}

/** A recorded spot close is trusted for stop decisions only while its bar
 *  START is at most this old. Healthy recorder cadence: the latest completed
 *  5-min bar's start is ≤ ~10 min old, so 15 min flags a stalled poller within
 *  about one missed cycle without false alarms (AT-005: the "recent close"
 *  comment used to be an unchecked assumption). */
export const SPOT_FRESH_MAX_AGE_MS = 15 * 60_000;

export interface SpotRead {
  price: number;
  /** Bar-START epoch seconds (Fyers native). */
  bucketTs: number;
  ageMs: number;
  /** ageMs ≤ SPOT_FRESH_MAX_AGE_MS — stale reads must not drive stop logic
   *  during market hours (a stalled poller would freeze the spot forever). */
  fresh: boolean;
}

/** Latest recorded 5-min equity close WITH its timestamp — the guard validates
 *  freshness instead of assuming it. Null when the symbol has no bars yet. */
export async function latestSpotRead(symbol: string, date: string): Promise<SpotRead | null> {
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT close, bucketTs FROM fyers_candles
        WHERE symbol = ? AND instrument = 'EQ' AND date = ?
        ORDER BY bucketTs DESC LIMIT 1`,
      symbol,
      date
    )) as { close: number; bucketTs: number }[];
    const close = Number(rows[0]?.close ?? 0);
    const bucketTs = Number(rows[0]?.bucketTs ?? 0);
    if (!(close > 0) || !(bucketTs > 0)) return null;
    const ageMs = Date.now() - bucketTs * 1000;
    return { price: close, bucketTs, ageMs, fresh: ageMs <= SPOT_FRESH_MAX_AGE_MS };
  } catch {
    return null;
  }
}

/** Latest recorded 5-min equity close for a symbol today (the poller's
 *  fyers_candles table). Null when the symbol has no bars yet. Display/context
 *  use — stop decisions go through latestSpotRead for the freshness check. */
export async function latestSpot(symbol: string, date: string): Promise<number | null> {
  return (await latestSpotRead(symbol, date))?.price ?? null;
}
