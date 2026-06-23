/**
 * R-Factor library — the orchestrator.
 *
 *  • DEFAULT_WEIGHTS — the blend (a reasoned starting point; see caveat below)
 *  • computeRFactor  — run every factor, blend strength, vote direction
 *
 * computeRFactor runs all factors, blends their [0,1] strengths into one score
 * (renormalized over only the AVAILABLE factors), and derives the directional bias
 * from the majority vote. Output strength is scaled to a TradeFinder-like 1.0–5.0.
 */

import { breakoutSignal } from './breakout';
import { smartMoneyAccumulationSignal, turnoverSignal, volumeSignal } from './flow';
import { majoritySignal } from './majority';
import { pctChange, round } from './math';
import { bidAskSpreadSignal } from './microstructure';
import { futuresOiSignal, oiDirectionSignal, oiVsTwentyDaySignal } from './oi';
import { callOptionOiSignal, pcrSignal, putOptionOiSignal } from './options';
import { isAfterEntryTime } from './timing';
import type { FactorScore, RFactorInput, RFactorResult, RFactorWeights } from './types';

/**
 * Default blend weights — a reasoned STARTING POINT, NOT fitted to TradeFinder
 * ground truth. They lean on the factors this project has found most predictive
 * (sustained OI level, smart-money accumulation, tight spread). Calibrate against
 * captured TF rankings before trusting them; override via `config.weights`.
 * Weights need not sum to 1 — the engine renormalizes over available factors.
 */
export const DEFAULT_WEIGHTS: RFactorWeights = {
  oiLevel: 0.18,
  smartMoney: 0.16,
  bidAskSpread: 0.14,
  futuresOi: 0.12,
  turnover: 0.12,
  oiDirection: 0.08,
  pcr: 0.06,
  callOi: 0.04,
  putOi: 0.04,
  breakout: 0.04,
  volume: 0.02,
};

export interface RFactorConfig {
  /** Override any subset of the default blend weights. */
  weights?: Partial<RFactorWeights>;
}

/** R-Factor strength is reported on this scale (echoes TradeFinder's 1–5 range). */
const RF_MIN = 1;
const RF_MAX = 5;

/** Compute the full R-Factor result for one symbol from supplied market data. */
export function computeRFactor(input: RFactorInput, config: RFactorConfig = {}): RFactorResult {
  const weights: RFactorWeights = { ...DEFAULT_WEIGHTS, ...config.weights };

  const oiChangePct =
    input.futOi !== undefined && input.futOiPrev !== undefined ? pctChange(input.futOi, input.futOiPrev) : 0;

  // Every factor runs; each reports available:false when its inputs are missing.
  const factors: FactorScore[] = [
    smartMoneyAccumulationSignal({
      priceChangePct: input.priceChangePct,
      oiChangePct,
      turnover: input.turnover,
      turnover20dAvg: input.turnover20dAvg,
      currentOi: input.futOi,
      oi20dAvg: input.futOi20dAvg,
    }),
    futuresOiSignal(input.futOi, input.futOiPrev),
    oiVsTwentyDaySignal(input.futOi, input.futOi20dAvg),
    oiDirectionSignal(input.priceChangePct, oiChangePct),
    callOptionOiSignal(input.callOi, input.callOiPrev),
    putOptionOiSignal(input.putOi, input.putOiPrev),
    pcrSignal(input.callOi, input.putOi),
    turnoverSignal(input.turnover, input.turnover20dAvg),
    volumeSignal(input.volume, input.volume20dAvg),
    bidAskSpreadSignal(input.bid, input.ask),
    breakoutSignal(input.ltp, input.breakoutHigh, input.breakoutLow),
  ];

  // Weighted strength, renormalized over AVAILABLE factors so missing data (e.g.
  // no option chain) neither inflates nor deflates the final score.
  let weightedSum = 0;
  let weightTotal = 0;
  for (const f of factors) {
    if (!f.available) continue;
    const w = weights[f.key] ?? 0;
    weightedSum += w * f.score;
    weightTotal += w;
  }
  const rawScore = weightTotal > 0 ? weightedSum / weightTotal : 0;
  const rFactor = round(RF_MIN + (RF_MAX - RF_MIN) * rawScore, 2);

  const majority = majoritySignal(factors, weights);
  const { marketOpen, afterEntryWindow, istTime } = isAfterEntryTime(input.now, input.entryTimeIST);

  const notes: string[] = [];
  const missing = factors.filter((f) => !f.available).map((f) => f.label);
  if (missing.length > 0) notes.push(`Missing inputs (excluded from blend): ${missing.join(', ')}.`);
  if (!marketOpen) {
    notes.push(`Market closed at ${istTime} IST — depth-based factors are stale.`);
  } else if (!afterEntryWindow) {
    notes.push(
      `Before the ${input.entryTimeIST ?? '09:45'} IST entry window (now ${istTime}) — may be opening-auction noise.`,
    );
  }

  return {
    symbol: input.symbol,
    rFactor,
    rawScore: round(rawScore, 4),
    bias: majority.bias,
    confidence: round(majority.confidence, 2),
    afterEntryWindow,
    marketOpen,
    factors,
    notes,
  };
}
