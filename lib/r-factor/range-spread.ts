/**
 * R-Factor library — range-expansion "spread" factor.
 *
 *  • rangeSpreadSignal — today's (High−Low)/Close vs its 20-day average.
 *
 * This is the "spread" TradeFinder's R-Factor is dominated by — a daily-RANGE
 * expansion measure, NOT the bid-ask spread (that's `bidAskSpread`, a separate
 * liquidity factor). Calibration against TF ground truth showed this is the single
 * best predictor of TF's score, via the parent project's reverse-engineered
 * quadratic `R ≈ 2.45 − 1.86·s + 0.95·s²` (s = the range ratio).
 *
 * The quadratic is U-shaped: a stock trading in an unusually TIGHT range (coiled,
 * s≪1) OR an unusually WIDE one (breaking out, s≫1) both score high; a normal
 * range (s≈1) scores low. It is a non-directional intensity signal (vote neutral)
 * — which way it resolves comes from the directional factors.
 *
 * ⚠ The relationship is DATE-DEPENDENT (strong on some sessions, weak on others),
 * so the blend weight for this factor is provisional until calibrated across many
 * TF capture days. See the README calibration note.
 */

import { clamp, isPos, round } from './math';
import type { FactorScore } from './types';

/** Range ratios above this are clipped before the quadratic (avoids blow-ups). */
const RATIO_CAP = 4;

/**
 * @param high          session high (intraday so far on the live path; EOD on bhavcopy)
 * @param low           session low
 * @param close         close / LTP (the ratio denominator)
 * @param ratio20dAvg   20-day average of (High−Low)/Close — the baseline ratio
 */
export function rangeSpreadSignal(
  high?: number,
  low?: number,
  close?: number,
  ratio20dAvg?: number,
): FactorScore {
  const base = { key: 'rangeSpread' as const, label: 'Range expansion ((H-L)/close vs 20d)' };
  if (!isPos(high) || !isPos(low) || !isPos(close) || !isPos(ratio20dAvg) || high < low) {
    return { ...base, score: 0, vote: 'neutral', available: false, detail: 'range or 20-day baseline unavailable' };
  }
  const todayRatio = (high - low) / close;
  const ratio = todayRatio / ratio20dAvg;
  const s = clamp(ratio, 0, RATIO_CAP);
  const quad = 2.45 - 1.86 * s + 0.95 * s * s; // ≈ [1.5 .. 5.5]
  const score = clamp((quad - 1) / 4, 0, 1); // map onto the 1–5 → [0,1] convention
  const shape = ratio < 0.7 ? 'contracted (coiled)' : ratio > 1.5 ? 'expanded (breaking out)' : 'normal range';
  return { ...base, score, vote: 'neutral', available: true, detail: `range ${round(ratio, 2)}× the 20-day average — ${shape}` };
}
