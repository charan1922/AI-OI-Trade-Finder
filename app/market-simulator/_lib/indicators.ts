/**
 * Replay-chart indicators — computed ONLY on revealed bars, so they inherit the
 * simulator's fog-of-war (no future data ever reaches the client). Math mirrors
 * the historify day-chart route (`app/api/historify/day-chart/route.ts`).
 */

export interface IndicatorBar {
  time: number; // unix seconds (real, unshifted)
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Exponential moving average over a series; same length as input. */
export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

/** IST calendar day (YYYY-MM-DD) for a unix-seconds timestamp. */
function istDay(unixSeconds: number): string {
  return new Date((unixSeconds + 5.5 * 3600) * 1000).toISOString().slice(0, 10);
}

/**
 * Cumulative intraday VWAP that resets at each IST trading-day boundary.
 * Returns one value per bar (same order/length as input).
 */
export function vwapByDay(bars: IndicatorBar[]): number[] {
  const out: number[] = [];
  let day = '';
  let cumPV = 0;
  let cumVol = 0;
  for (const b of bars) {
    const d = istDay(b.time);
    if (d !== day) {
      day = d;
      cumPV = 0;
      cumVol = 0;
    }
    const typical = (b.high + b.low + b.close) / 3;
    cumPV += typical * b.volume;
    cumVol += b.volume;
    out.push(cumVol > 0 ? cumPV / cumVol : b.close);
  }
  return out;
}
