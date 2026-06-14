/**
 * F&O Options Commission Calculator
 *
 * Ported from ExpiryFlow's Python backtest_service.py → _calculate_charges()
 * Accurate for Indian NSE F&O options trading (Dhan broker).
 *
 * Components:
 * - Brokerage: ₹20 per order (flat rate)
 * - STT: 0.1% on sell side only (Securities Transaction Tax)
 * - Exchange Transaction: 0.03553% on total turnover
 * - GST: 18% on (brokerage + exchange txn + SEBI)
 * - SEBI: ₹10 per crore on total turnover
 * - Stamp Duty: 0.004% on buy side only
 */

export interface CommissionSlab {
  brokeragePerOrder: number;
  sttSellRate: number;
  exchangeTxnRate: number;
  gstRate: number;
  sebiPerCrore: number;
  stampDutyBuyRate: number;
}

export const DEFAULT_OPTION_SLAB: CommissionSlab = {
  brokeragePerOrder: 20,
  sttSellRate: 0.001, // 0.1%
  exchangeTxnRate: 0.0003553, // 0.03553%
  gstRate: 0.18, // 18%
  sebiPerCrore: 10, // ₹10 per crore
  stampDutyBuyRate: 0.00004, // 0.004%
};

export interface ChargesBreakdown {
  brokerage: number;
  stt: number;
  exchangeTxn: number;
  gst: number;
  sebi: number;
  stampDuty: number;
  total: number;
}

/**
 * Calculate all trading charges for an option round-trip (buy + sell).
 *
 * @param numOrders - Total orders (2 for a round-trip: 1 buy + 1 sell)
 * @param buyTurnover - Total value of buy side (premium × quantity)
 * @param sellTurnover - Total value of sell side (premium × quantity)
 * @param slab - Commission rates (defaults to standard Dhan rates)
 */
export function calculateOptionCharges(params: {
  numOrders: number;
  buyTurnover: number;
  sellTurnover: number;
  slab?: CommissionSlab;
}): ChargesBreakdown {
  const slab = params.slab ?? DEFAULT_OPTION_SLAB;
  const totalTurnover = params.buyTurnover + params.sellTurnover;

  const brokerage = params.numOrders * slab.brokeragePerOrder;
  const stt = params.sellTurnover * slab.sttSellRate;
  const exchangeTxn = totalTurnover * slab.exchangeTxnRate;
  const sebi = (totalTurnover * slab.sebiPerCrore) / 1e7;
  const gst = slab.gstRate * (brokerage + exchangeTxn + sebi);
  const stampDuty = params.buyTurnover * slab.stampDutyBuyRate;
  const total = brokerage + stt + exchangeTxn + gst + sebi + stampDuty;

  return {
    brokerage: Math.round(brokerage * 100) / 100,
    stt: Math.round(stt * 100) / 100,
    exchangeTxn: Math.round(exchangeTxn * 100) / 100,
    gst: Math.round(gst * 100) / 100,
    sebi: Math.round(sebi * 100) / 100,
    stampDuty: Math.round(stampDuty * 100) / 100,
    total: Math.round(total * 100) / 100,
  };
}

/**
 * Estimate charges for an option buy trade (entry only, before exit is known).
 * Uses entry premium for buy side, estimates exit at same premium for worst-case charges.
 */
export function estimateEntryCharges(entryPremium: number, quantity: number): ChargesBreakdown {
  const buyTurnover = entryPremium * quantity;
  // Estimate sell at same price (charges scale linearly, so this gives a good approximation)
  return calculateOptionCharges({
    numOrders: 2,
    buyTurnover,
    sellTurnover: buyTurnover,
  });
}
