/**
 * R-Factor library — breakout factor.
 *
 *  • breakoutSignal — is price breaking out of its reference range?
 *
 * The reference levels are supplied by the caller (e.g. prior-day high/low, or the
 * 9:15–9:45 opening range). A clean break above resistance is bullish; below
 * support, bearish. Inside the range scores 0 (neutral) — no breakout yet.
 */

import { clamp, isPos, round } from './math';
import type { FactorScore } from './types';

/** Price this fraction beyond the level (2%) scores 1.0 — a decisive break. */
const BREAKOUT_CAP_EXCESS = 0.02;

/** #12 Breakout — LTP relative to the supplied resistance / support levels. */
export function breakoutSignal(ltp: number, breakoutHigh?: number, breakoutLow?: number): FactorScore {
  const base = { key: 'breakout' as const, label: 'Breakout' };
  if (!isPos(ltp) || (!isPos(breakoutHigh) && !isPos(breakoutLow))) {
    return { ...base, score: 0, vote: 'neutral', available: false, detail: 'no breakout reference levels' };
  }
  if (isPos(breakoutHigh) && ltp > breakoutHigh) {
    const excess = ltp / breakoutHigh - 1;
    return {
      ...base,
      score: clamp(excess / BREAKOUT_CAP_EXCESS, 0, 1),
      vote: 'buy',
      available: true,
      detail: `LTP ${round(excess * 100, 2)}% above resistance ${round(breakoutHigh, 2)} — upside breakout`,
    };
  }
  if (isPos(breakoutLow) && ltp < breakoutLow) {
    const excess = 1 - ltp / breakoutLow;
    return {
      ...base,
      score: clamp(excess / BREAKOUT_CAP_EXCESS, 0, 1),
      vote: 'sell',
      available: true,
      detail: `LTP ${round(excess * 100, 2)}% below support ${round(breakoutLow, 2)} — downside breakdown`,
    };
  }
  return { ...base, score: 0, vote: 'neutral', available: true, detail: 'inside the reference range — no breakout' };
}
