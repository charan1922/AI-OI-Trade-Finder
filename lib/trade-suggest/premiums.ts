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

import { bestBidAsk, marketFeed } from '@/lib/market-data';
import {
  OPTION_WARN_SPREAD_PCT,
  MAX_RISK_PER_LOT_RUPEES,
  OPTION_STOP_PCT,
  TF_LOT_TARGET_RUPEES,
} from '@/lib/trade-suggest/config';
import type { OptionPlan, OptionPremium } from '@/lib/trade-suggest/types';
import { backstopStopPct, istEpochMs, spotStopRiskPerLot } from '@/lib/auto-trade/risk/option-model';

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
  /** Forced square-off minute (IST) — the chart-stop risk counts decay to it. */
  squareOffMin?: number;
}

/** 15:12 IST — the coded square-off, for callers with no runtime settings. */
const DEFAULT_SQUARE_OFF_MIN = 15 * 60 + 12;

const DEFAULT_PREMIUM_POLICY: Required<PremiumPolicy> = {
  stopPct: OPTION_STOP_PCT,
  maxRiskPerLot: MAX_RISK_PER_LOT_RUPEES,
  squareOffMin: DEFAULT_SQUARE_OFF_MIN,
};

/** Guard the injected policy: a corrupt runtime value must fall back to the
 *  coded default rather than produce a nonsense stop on a real plan. */
function safePolicy(policy?: PremiumPolicy): Required<PremiumPolicy> {
  const stopPct =
    policy != null && Number.isFinite(policy.stopPct) && policy.stopPct > 0 && policy.stopPct < 100
      ? policy.stopPct
      : DEFAULT_PREMIUM_POLICY.stopPct;
  const maxRiskPerLot =
    policy != null && Number.isFinite(policy.maxRiskPerLot) && policy.maxRiskPerLot > 0
      ? policy.maxRiskPerLot
      : DEFAULT_PREMIUM_POLICY.maxRiskPerLot;
  const squareOffMin =
    policy?.squareOffMin != null && Number.isFinite(policy.squareOffMin) && policy.squareOffMin > 0
      ? policy.squareOffMin
      : DEFAULT_PREMIUM_POLICY.squareOffMin;
  return { stopPct, maxRiskPerLot, squareOffMin };
}

/**
 * One batched Dhan quote for the picked option contracts → live premium,
 * option-book spread, volume/OI, per-lot cost, the premium stop (a flat
 * `policy.stopPct` of the contract's own price) and the ₹TF_LOT_TARGET_RUPEES/lot
 * premium target. Mutates each plan's `premium`; leaves it null (never
 * fabricated) when no price of any kind comes back — and says so in the log.
 */
export async function attachPremiums(options: OptionPlan[], policy?: PremiumPolicy): Promise<void> {
  const { stopPct } = safePolicy(policy);
  const ids = options.map((o) => Number(o.optSecurityId)).filter((n) => n > 0);
  if (ids.length === 0) return;
  const unpriced: string[] = [];
  let midPriced = 0;
  try {
    const q = await marketFeed('quote', { NSE_FNO: ids });
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
      else if (book.spreadPct > OPTION_WARN_SPREAD_PCT)
        warnings.push(`option spread ${book.spreadPct.toFixed(1)}% of premium — slippage risk`);
      if (!volume) warnings.push('no traded volume yet in this contract');
      if (resolved.source === 'mid')
        warnings.push(
          resolved.staleLtp
            ? 'last trade is stale (outside the live book) — priced off the bid-ask mid'
            : 'no trade printed yet — priced off the bid-ask mid'
        );
      // The executable price a market BUY actually lifts: the ASK when there is a
      // book, else the resolved mark. The per-lot COST (affordability) is sized
      // off this so the scanner's "fits the budget" agrees with auto-trade's
      // ask-based capital gate (PR#18 review + re-review). The per-lot RISK needs
      // the chart stop, which is known only once the spot plan is built — see
      // applyChartStopRisk.
      const executablePrice = book?.ask ?? price;
      const premium: OptionPremium = {
        ltp: Math.round(price * 100) / 100,
        priceSource: resolved.source,
        bid: book?.bid ?? null,
        ask: book?.ask ?? null,
        spreadPct: book == null ? null : Math.round(book.spreadPct * 100) / 100,
        volume,
        oi,
        // Affordability = the EXECUTABLE cost (ask × lot), not the ltp/mid mark ×
        // lot — the engine skips a pick when this exceeds the capital budget, and
        // it must agree with auto-trade's ask-based capital gate. `ltp` above
        // keeps the mark for display/analytics (PR#18 re-review).
        perLotCost: Math.round(executablePrice * o.lotSize * 100) / 100,
        // Provisional premium backstop = the policy's minimum width; widened by
        // applyChartStopRisk once the chart stop is known. Never squeezed to fit
        // a rupee budget (2026-07-23 review) — over-budget lots are refused.
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

/**
 * Once the spot plan exists: measure the per-lot risk at the CHART stop (the
 * same model auto-trade's entry gate enforces — risk/option-model.ts), warn when
 * it is over budget, and widen the premium backstop to
 * max(stopPct, 1.5 × modelled drop) so the displayed stop is the one that will
 * actually be set. The scanner only WARNS; risk/gates.ts refuses for real.
 */
export function applyChartStopRisk(
  option: OptionPlan,
  at: { spot: number; slSpot: number | null; tradeDate: string; nowMs: number },
  policy?: PremiumPolicy
): void {
  const p = option.premium;
  if (!p) return;
  const { stopPct, maxRiskPerLot, squareOffMin } = safePolicy(policy);
  const ask = p.ask ?? p.ltp;
  const warnings = p.liquidityWarning ? [p.liquidityWarning] : [];
  if (at.slSpot == null) {
    warnings.push('no chart stop — per-lot risk cannot be measured');
  } else {
    const r = spotStopRiskPerLot({
      optionType: option.optionType,
      ask,
      spot: at.spot,
      slSpot: at.slSpot,
      strike: option.strike,
      expiryDate: option.expiryDate,
      lotSize: option.lotSize,
      nowMs: at.nowMs,
      evalAtMs: istEpochMs(at.tradeDate, squareOffMin),
    });
    if (!r.ok) {
      warnings.push(`risk at the chart stop cannot be modelled (${r.reason})`);
    } else {
      if (r.riskPerLot > maxRiskPerLot)
        warnings.push(
          `lot risks ₹${r.riskPerLot.toLocaleString('en-IN')} if the stock reaches its ₹${at.slSpot} chart stop — above the ₹${maxRiskPerLot.toLocaleString('en-IN')} per-lot budget`
        );
      const width = backstopStopPct(stopPct, r.dropPct);
      p.slPremium = Math.round(Math.max(0.05, p.ltp * (1 - width / 100)) * 100) / 100;
    }
  }
  p.liquidityWarning = warnings.length > 0 ? warnings.join('; ') : null;
}
