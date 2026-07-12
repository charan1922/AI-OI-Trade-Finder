/**
 * Fractal swing detection on today's 5-min bars.
 *
 * A swing high is a bar whose high exceeds the highs of the K bars on each
 * side (mirror for swing lows) — the "previous swing high" the TF trader
 * counts as one of the levels a strong surge shatters. Only today's bars are
 * available (fyers_candles keeps today only), so these are intraday swings;
 * multi-day structure comes from bhavcopy levels instead (levels.ts).
 */

export interface SwingBar {
  /** Bar-START epoch seconds. */
  bucketTs: number;
  high: number;
  low: number;
}

export interface SwingPoint {
  price: number;
  /** Bar-start epoch seconds of the pivot bar. */
  bucketTs: number;
}

/** Bars on each side that must be strictly lower (highs) / higher (lows). */
export const SWING_K = 2;

/**
 * Detect completed swing highs/lows in chronological order. The last K bars
 * can't confirm a pivot yet (future side unknown) — by design: a swing only
 * counts once price has moved away from it.
 */
export function detectSwings(bars: SwingBar[], k: number = SWING_K): { highs: SwingPoint[]; lows: SwingPoint[] } {
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];
  for (let i = k; i < bars.length - k; i++) {
    const b = bars[i];
    if (!(b.high > 0) || !(b.low > 0)) continue;
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      const o = bars[j];
      if (!(o.high > 0) || !(o.low > 0)) {
        isHigh = false;
        isLow = false;
        break;
      }
      if (o.high >= b.high) isHigh = false;
      if (o.low <= b.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ price: b.high, bucketTs: b.bucketTs });
    if (isLow) lows.push({ price: b.low, bucketTs: b.bucketTs });
  }
  return { highs, lows };
}
