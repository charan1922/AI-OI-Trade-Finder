/**
 * Option premium pricing for the scanner — one batched Dhan quote for the
 * picked contracts, priced with the quant-standard fallback chain:
 *
 *   1. last traded price (ltp) when the contract has printed today, UNLESS it
 *      sits outside the live bid-ask book (a stale print — the book is newer);
 *   2. bid-ask mid when there is no usable ltp but a live two-sided book
 *      exists (a resting-order mid is a REAL price, not a fabrication — this
 *      is what rescues quiet-but-tradeable contracts like ABB 7350CE that
 *      never printed, which used to come back null);
 *   3. null when neither exists (off-hours / dead contract) — never invented.
 *
 * Every unpriced or mid-priced contract is logged with its reason so a null
 * premium is diagnosable from the logs instead of DB archaeology
 * (ABB/PAYTM incident, 2026-07-16).
 *
 * Derived plan numbers (per-lot cost, premium SL, premium target) all come
 * from the same resolved price, so the stop math is never split across two
 * different price sources.
 */

import { bestBidAsk, dhanMarketFeed } from '@/lib/dhan/market-feed';
import {
  MAX_OPT_SPREAD_PCT,
  MAX_RISK_PER_LOT_RUPEES,
  OPTION_STOP_PCT,
  TF_LOT_TARGET_RUPEES,
} from '@/lib/trade-suggest/config';
import type { OptionPlan, OptionPremium } from '@/lib/trade-suggest/types';

const TAG = '[TradeSuggest]';

/** Resolved price + where it came from (audit trail for the pick record). */
export interface ResolvedOptionPrice {
  price: number;
  source: 'ltp' | 'mid';
  /** Set when ltp existed but sat outside the live book (stale print). */
  staleLtp: boolean;
}

/**
 * Pick the honest tradeable price out of a quote: fresh ltp → ltp; stale or
 * missing ltp with a live book → mid; nothing → null. Pure, unit-testable.
 */
export function resolveOptionPrice(
  ltp: number,
  book: { bid: number; ask: number; mid: number } | null
): ResolvedOptionPrice | null {
  const hasLtp = ltp > 0;
  // A print outside the current book is older than the resting orders —
  // trust the book. (Tolerance-free on purpose: options tick inside the book.)
  const staleLtp = hasLtp && book != null && (ltp < book.bid || ltp > book.ask);
  if (hasLtp && !staleLtp) return { price: ltp, source: 'ltp', staleLtp: false };
  if (book != null) return { price: book.mid, source: 'mid', staleLtp };
  if (hasLtp) return { price: ltp, source: 'ltp', staleLtp: false }; // stale but the only real price we have
  return null;
}

/** The stop/risk policy the displayed plan should reflect. Passed in by the
 *  engine from the EFFECTIVE auto-trade settings so the suggested stop is the
 *  one that will actually fire — the compile-time constants are only the
 *  fallback for callers with no runtime context (PR#18 review found the scanner
 *  hard-coded 25% / ₹2,500 while auto-trade honoured the runtime values). */
export interface PremiumPolicy {
  stopPct: number;
  maxRiskPerLot: number;
}

const DEFAULT_PREMIUM_POLICY: PremiumPolicy = {
  stopPct: OPTION_STOP_PCT,
  maxRiskPerLot: MAX_RISK_PER_LOT_RUPEES,
};

/** Guard the injected policy: a corrupt runtime value must fall back to the
 *  coded default rather than produce a nonsense stop on a real plan. */
function safePolicy(policy?: PremiumPolicy): PremiumPolicy {
  const stopPct =
    policy != null && Number.isFinite(policy.stopPct) && policy.stopPct > 0 && policy.stopPct < 100
      ? policy.stopPct
      : DEFAULT_PREMIUM_POLICY.stopPct;
  const maxRiskPerLot =
    policy != null && Number.isFinite(policy.maxRiskPerLot) && policy.maxRiskPerLot > 0
      ? policy.maxRiskPerLot
      : DEFAULT_PREMIUM_POLICY.maxRiskPerLot;
  return { stopPct, maxRiskPerLot };
}

/**
 * One batched Dhan quote for the picked option contracts → live premium,
 * option-book spread, volume/OI, per-lot cost, the premium stop (a flat
 * `policy.stopPct` of the contract's own price) and the ₹TF_LOT_TARGET_RUPEES/lot
 * premium target. Mutates each plan's `premium`; leaves it null (never
 * fabricated) when no price of any kind comes back — and says so in the log.
 */
export async function attachPremiums(options: OptionPlan[], policy?: PremiumPolicy): Promise<void> {
  const { stopPct, maxRiskPerLot } = safePolicy(policy);
  const ids = options.map((o) => Number(o.optSecurityId)).filter((n) => n > 0);
  if (ids.length === 0) return;
  const unpriced: string[] = [];
  let midPriced = 0;
  try {
    const q = await dhanMarketFeed('quote', { NSE_FNO: ids });
    const seg = q.NSE_FNO ?? {};
    for (const o of options) {
      const oq = seg[String(o.optSecurityId)];
      if (!oq) {
        unpriced.push(`${o.optSymbol ?? o.optSecurityId}: not in quote response`);
        continue;
      }
      const book = bestBidAsk(oq);
      const resolved = resolveOptionPrice(oq.last_price ?? 0, book);
      if (resolved == null) {
        unpriced.push(`${o.optSymbol ?? o.optSecurityId}: no last trade and no order book`);
        continue;
      }
      if (resolved.source === 'mid') midPriced++;
      const { price } = resolved;
      const volume = oq.volume ?? null;
      const oi = oq.oi ?? null;
      const warnings: string[] = [];
      if (book == null) warnings.push('no option order book');
      else if (book.spreadPct > MAX_OPT_SPREAD_PCT)
        warnings.push(`option spread ${book.spreadPct.toFixed(1)}% of premium — slippage risk`);
      if (!volume) warnings.push('no traded volume yet in this contract');
      if (resolved.source === 'mid')
        warnings.push(
          resolved.staleLtp
            ? 'last trade is stale (outside the live book) — priced off the bid-ask mid'
            : 'no trade printed yet — priced off the bid-ask mid'
        );
      // The contract is priceable but too big for the per-lot risk budget: at the
      // fixed OPTION_STOP_PCT stop it would put more than MAX_RISK_PER_LOT_RUPEES
      // behind that stop. Auto-trade REFUSES this outright (risk/gates.ts); the
      // scanner only warns, so a manual trader still sees the pick and the reason.
      // Priced off the ASK when there is a book — that is the executable market-BUY
      // price the gate itself sizes against, so the warning and the refusal agree
      // (PR#18 review). Falls back to the resolved mark when no ask is quoted.
      const riskBasis = book?.ask ?? price;
      const riskAtStop = ((riskBasis * stopPct) / 100) * o.lotSize;
      if (riskAtStop > maxRiskPerLot)
        warnings.push(
          `lot risks ₹${Math.round(riskAtStop).toLocaleString('en-IN')} at the ${stopPct}% premium stop (off the ₹${Math.round(riskBasis * 100) / 100} ${book?.ask != null ? 'ask' : 'mark'}) — above the ₹${maxRiskPerLot.toLocaleString('en-IN')} per-lot budget`
        );
      const premium: OptionPremium = {
        ltp: Math.round(price * 100) / 100,
        priceSource: resolved.source,
        bid: book?.bid ?? null,
        ask: book?.ask ?? null,
        spreadPct: book == null ? null : Math.round(book.spreadPct * 100) / 100,
        volume,
        oi,
        perLotCost: Math.round(price * o.lotSize * 100) / 100,
        // Stop premium = a straight OPTION_STOP_PCT of the contract's own price.
        // It is deliberately NOT squeezed to fit a rupee budget: dividing a flat
        // ₹/lot cap by lot sizes that range 75–700 produced stops of 7.7%–23.8%
        // that nobody chose, and every one under ~12% lost (2026-07-23 review).
        // The rupee budget is enforced instead by refusing an over-sized lot —
        // surfaced here as a warning, blocked for real in risk/gates.ts.
        slPremium: Math.round(Math.max(0.05, price * (1 - stopPct / 100)) * 100) / 100,
        targetPremium: Math.round((price + TF_LOT_TARGET_RUPEES / o.lotSize) * 100) / 100,
        liquidityWarning: warnings.length > 0 ? warnings.join('; ') : null,
      };
      o.premium = premium;
    }
  } catch (err) {
    console.warn(`${TAG} option premium quote failed: ${(err as Error).message}`);
    return;
  }
  if (midPriced > 0) console.log(`${TAG} ${midPriced}/${options.length} contract(s) priced off the bid-ask mid`);
  if (unpriced.length > 0) console.warn(`${TAG} unpriceable contract(s) dropped: ${unpriced.join(' · ')}`);
}
