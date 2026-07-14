/**
 * Gamma Exposure (GEX) computation from Dhan option chain data.
 * Market-level signal — computed for NIFTY/BANKNIFTY only, not per-stock.
 *
 * GEX predicts dealer hedging behavior:
 *   Positive GEX → dealers buy dips / sell rallies → mean-reverting market
 *   Negative GEX → dealers chase momentum → trending/volatile market
 *
 * Also identifies the "gamma wall" (strike with max positive GEX) which acts
 * as a price magnet / support-resistance level.
 *
 * Pure computation — no I/O, no API calls.
 */

export interface OptionChainStrike {
  strike: number;
  callGamma: number;
  callOi: number;
  putGamma: number;
  putOi: number;
}

export interface GexResult {
  /** Net GEX (positive = mean-reverting, negative = trending). */
  netGex: number;
  /** GEX by strike — for visualization. */
  byStrike: Map<number, { callGex: number; putGex: number; net: number }>;
  /** Strike with max positive GEX (gamma wall / magnet level). */
  gammaWall: number | null;
  /** Interpretation. */
  regime: 'positive' | 'negative' | 'neutral';
  label: string;
}

/**
 * Compute net GEX from option chain strikes.
 * @param rows  Per-strike gamma + OI data from Dhan option chain
 * @param spot  Current underlying spot price
 */
export function computeGex(rows: OptionChainStrike[], spot: number): GexResult {
  const byStrike = new Map<number, { callGex: number; putGex: number; net: number }>();
  let totalGex = 0;
  let maxPositiveStrike: number | null = null;
  let maxPositiveGex = 0;

  for (const row of rows) {
    // Call GEX positive (dealers short calls → buy dips)
    const callGex = row.callGamma * row.callOi * spot * spot * 0.01;
    // Put GEX negative (dealers short puts → sell rallies)
    const putGex = -(row.putGamma * row.putOi * spot * spot * 0.01);
    const net = callGex + putGex;

    byStrike.set(row.strike, { callGex, putGex, net });
    totalGex += net;

    if (callGex > maxPositiveGex) {
      maxPositiveGex = callGex;
      maxPositiveStrike = row.strike;
    }
  }

  const regime = totalGex > 0 ? 'positive' : totalGex < 0 ? 'negative' : 'neutral';
  const label =
    `GEX ${regime}: ${Math.abs(totalGex).toFixed(0)}/1%` +
    (maxPositiveStrike != null ? ` (wall @ ${maxPositiveStrike})` : '');

  return { netGex: totalGex, byStrike, gammaWall: maxPositiveStrike, regime, label };
}