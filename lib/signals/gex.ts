/**
 * Experimental OI-weighted gamma imbalance proxy from a Dhan option chain.
 * Market-level context only - computed for NIFTY, never used as a trade gate.
 *
 * Public OI plus model gamma cannot identify who is long or short. The signs
 * below are a transparent call-minus-put convention, not dealer positioning
 * and not a range/trend prediction.
 *
 * Pure computation - no I/O, no API calls.
 */

export interface OptionChainStrike {
  strike: number;
  callGamma: number;
  callOi: number;
  putGamma: number;
  putOi: number;
}

export interface GexResult {
  /** Net result of the call-minus-put OI-weighted gamma convention. */
  netImbalance: number;
  /** Scale-free (call - put) / (call + put), in percentage points. */
  netSharePct: number;
  callWeight: number;
  putWeight: number;
  /** Proxy contribution by strike - useful for visualization. */
  byStrike: Map<number, { callGex: number; putGex: number; net: number }>;
  /** Strike with the largest absolute net proxy contribution. */
  concentrationStrike: number | null;
  /** Describes this proxy's sign only; it makes no dealer or price prediction. */
  balance: 'call-side-higher' | 'put-side-higher' | 'equal';
  label: string;
}

/**
 * Compute the OI-weighted gamma imbalance proxy from option-chain strikes.
 * @param rows Per-strike gamma + OI data from Dhan option chain
 * @param spot Current underlying spot price
 * @param lotMultiplier Index lot size for the expiry, from the security master
 */
export function computeGex(rows: OptionChainStrike[], spot: number, lotMultiplier: number): GexResult {
  const byStrike = new Map<number, { callGex: number; putGex: number; net: number }>();
  let netImbalance = 0;
  let callWeight = 0;
  let putWeight = 0;
  let concentrationStrike: number | null = null;
  let largestAbsoluteNet = 0;
  const multiplier = Number.isFinite(lotMultiplier) && lotMultiplier > 0 ? lotMultiplier : 1;

  for (const row of rows) {
    if (
      !Number.isFinite(row.strike) ||
      !Number.isFinite(row.callGamma) ||
      !Number.isFinite(row.callOi) ||
      !Number.isFinite(row.putGamma) ||
      !Number.isFinite(row.putOi) ||
      row.callGamma < 0 ||
      row.callOi < 0 ||
      row.putGamma < 0 ||
      row.putOi < 0
    ) {
      continue;
    }
    // Signed call-minus-put analytical convention. It is not dealer inventory.
    const callGex = row.callGamma * row.callOi * multiplier * spot * spot * 0.01;
    const putGex = row.putGamma * row.putOi * multiplier * spot * spot * 0.01;
    const net = callGex - putGex;

    byStrike.set(row.strike, { callGex, putGex, net });
    netImbalance += net;
    callWeight += callGex;
    putWeight += putGex;

    if (Math.abs(net) > largestAbsoluteNet) {
      largestAbsoluteNet = Math.abs(net);
      concentrationStrike = row.strike;
    }
  }

  const grossWeight = callWeight + putWeight;
  const netSharePct = grossWeight > 0 ? (netImbalance / grossWeight) * 100 : 0;
  const balance = netSharePct > 0 ? 'call-side-higher' : netSharePct < 0 ? 'put-side-higher' : 'equal';
  const label =
    `NIFTY public-OI gamma balance: ${netSharePct >= 0 ? '+' : ''}${netSharePct.toFixed(1)}% (call minus put, normalized)` +
    (concentrationStrike != null ? ` (largest net concentration @ ${concentrationStrike})` : '');

  return {
    netImbalance,
    netSharePct,
    callWeight,
    putWeight,
    byStrike,
    concentrationStrike,
    balance,
    label,
  };
}
