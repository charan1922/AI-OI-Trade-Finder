/**
 * Market regime — "is the whole market stuck?" (MiMo's request, 2026-10-29).
 *
 * The TF selector judges one stock at a time; it cannot tell a sideways market
 * from a trending one, so on chop days it fires into noise. This classifies the
 * market at the decision minute from three reads, all computable from data the
 * app already has (NIFTY 5-min bars from Fyers history; the F&O stocks' own
 * recorded 5-min bars):
 *
 *   1. NIFTY is INSIDE its 30-min opening range (09:15–09:45) and that range is
 *      NARROW (< niftyMaxRangePct of the index);
 *   2. breadth is SPLIT — the share of F&O gainers (vs yesterday's close) sits
 *      between breadthLow and breadthHigh, so no side is in charge;
 *   3. CHOP — more than minInsideShare of F&O stocks are still inside their OWN
 *      30-min opening range.
 *
 * STUCK only when all three are POSITIVELY true. A missing input makes the
 * verdict `null` (unknown) and never blocks — a failed NIFTY fetch must not
 * silently stop every entry; the reason says what was missing.
 *
 * PURE (no I/O, no clock) — the live scanner, the /live card and
 * scripts/measure-market-regime.ts all call this one definition.
 */

export interface MarketRegimeRule {
  /** NIFTY's 30-min range, as % of the index, below which it counts as narrow. */
  niftyMaxRangePct: number;
  /** Gainer share (0–1) inside [breadthLow, breadthHigh] = no side in charge. */
  breadthLow: number;
  breadthHigh: number;
  /** Share (0–1) of F&O stocks still inside their own 30-min range above which the market is chop. */
  minInsideShare: number;
  /** Fewer readable stocks than this → breadth / chop are unknown, not computed on a sliver. */
  minStocks: number;
}

/** MiMo's starting thresholds (2026-10-29), not fitted — re-check with scripts/measure-market-regime.ts. */
export const DEFAULT_MARKET_REGIME_RULE: MarketRegimeRule = {
  niftyMaxRangePct: 0.4,
  breadthLow: 0.4,
  breadthHigh: 0.6,
  minInsideShare: 0.65,
  minStocks: 50,
};

export interface RegimeStock {
  /** Last completed close inside the stock's own 30-min opening range. Null = range/price unknown. */
  insideOwnRange: boolean | null;
  /** % change vs yesterday's close at the last completed bar. Null = unknown. */
  dayChangePct: number | null;
}

export interface MarketRegime {
  /** true = all three say stuck (block entries); false = at least one says not; null = cannot tell. */
  stuck: boolean | null;
  niftyRangePct: number | null;
  niftyInside: boolean | null;
  gainerShare: number | null;
  insideShare: number | null;
  /** One plain-English line — what the scanner and the card show. */
  reason: string;
}

export function classifyMarketRegime(
  input: {
    niftyRange: { high: number; low: number } | null;
    niftyLast: number | null;
    stocks: RegimeStock[];
  },
  rule: MarketRegimeRule = DEFAULT_MARKET_REGIME_RULE
): MarketRegime {
  const { niftyRange, niftyLast } = input;
  const niftyRangePct =
    niftyRange && niftyLast != null && niftyLast > 0 && niftyRange.high >= niftyRange.low
      ? ((niftyRange.high - niftyRange.low) / niftyLast) * 100
      : null;
  const niftyInside =
    niftyRange && niftyLast != null ? niftyLast <= niftyRange.high && niftyLast >= niftyRange.low : null;

  const moved = input.stocks.filter((s) => s.dayChangePct != null && s.dayChangePct !== 0);
  const gainerShare =
    moved.length >= rule.minStocks ? moved.filter((s) => (s.dayChangePct as number) > 0).length / moved.length : null;
  const known = input.stocks.filter((s) => s.insideOwnRange != null);
  const insideShare = known.length >= rule.minStocks ? known.filter((s) => s.insideOwnRange).length / known.length : null;

  const c1 = niftyRangePct == null || niftyInside == null ? null : niftyInside && niftyRangePct < rule.niftyMaxRangePct;
  const c2 = gainerShare == null ? null : gainerShare >= rule.breadthLow && gainerShare <= rule.breadthHigh;
  const c3 = insideShare == null ? null : insideShare > rule.minInsideShare;

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const parts = [
    niftyRangePct == null || niftyInside == null
      ? 'NIFTY range unknown'
      : `NIFTY ${niftyInside ? 'inside' : 'outside'} its ${niftyRangePct.toFixed(2)}% opening range`,
    gainerShare == null ? 'breadth unknown' : `${pct(gainerShare)} of F&O stocks up`,
    insideShare == null ? 'chop unknown' : `${pct(insideShare)} still inside their own opening range`,
  ].join(', ');

  const stuck = c1 === false || c2 === false || c3 === false ? false : c1 && c2 && c3 ? true : null;
  return {
    stuck,
    niftyRangePct: niftyRangePct == null ? null : Math.round(niftyRangePct * 100) / 100,
    niftyInside,
    gainerShare: gainerShare == null ? null : Math.round(gainerShare * 1000) / 1000,
    insideShare: insideShare == null ? null : Math.round(insideShare * 1000) / 1000,
    reason:
      stuck === true
        ? `no trade — sideways market (${parts})`
        : stuck === false
          ? `market not stuck (${parts})`
          : `market regime unknown — not blocking (${parts})`,
  };
}
