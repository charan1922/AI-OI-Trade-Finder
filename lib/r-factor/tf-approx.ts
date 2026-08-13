/**
 * Display-only approximation of TradeFinder's R-Factor from App factor scores.
 *
 * Fitted on 27,060 point-in-time pairs from 2026-08-10..13. Each pair used the
 * latest App market snapshot at or before the corresponding TF board capture.
 * Leave-one-session-out validation: MAE 0.312, RMSE 0.429, Pearson r 0.589.
 * The previous 1-10 raw presentation measured MAE 2.623 and r 0.383.
 *
 * Four positive coefficients were retained for stability and interpretability;
 * a wider eight-factor ridge fit did not improve held-out accuracy. This is an
 * approximation for the /live display, never a scanner gate or order signal.
 * Reproduce with: pnpm exec tsx scripts/calibrate-app-rfactor.ts
 */
import { clamp, round } from './math';
import type { FactorKey, FactorScore } from './types';

export const TF_APPROX_CALIBRATION = {
  intercept: 0.3549,
  coefficients: {
    oiDirection: 0.1131,
    turnover: 0.7956,
    rangeSpread: 0.9748,
    breakout: 0.7963,
  } satisfies Partial<Record<FactorKey, number>>,
} as const;

/** Approximate TF R-Factor on its observed 0-10 board scale. */
export function approximateTfRFactor(factors: FactorScore[]): number {
  let estimate = TF_APPROX_CALIBRATION.intercept;
  const byKey = new Map(factors.map((factor) => [factor.key, factor]));
  for (const [key, coefficient] of Object.entries(TF_APPROX_CALIBRATION.coefficients)) {
    const factor = byKey.get(key as FactorKey);
    if (factor?.available) estimate += coefficient * factor.score;
  }
  return round(clamp(estimate, 0, 10), 2);
}
