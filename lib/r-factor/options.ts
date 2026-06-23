/**
 * R-Factor library — option open-interest factors.
 *
 *  • callOptionOiSignal — call OI build-up (reads as resistance / bearish lean)
 *  • putOptionOiSignal  — put OI build-up  (reads as support / bullish lean)
 *  • pcrSignal          — put/call OI ratio
 *
 * Caveat baked into the labels: rising option OI is ambiguous without premium
 * direction (call OI up = call BUYING-bullish OR call WRITING-bearish). These use
 * the standard PCR-style WRITER interpretation (rising call OI = resistance,
 * rising put OI = support); treat them as a lean, not a verdict.
 */

import { clamp, isPos, pctChange, round } from './math';
import type { FactorScore, Vote } from './types';

/** An option-OI change of this % is maximal build-up intensity. */
const OPT_OI_CHANGE_CAP_PCT = 15;
/** PCR thresholds for a directional lean (between = balanced/neutral). */
const PCR_BULL = 1.2;
const PCR_BEAR = 0.8;
/** PCR of this (or its reciprocal) scores 1.0 — log-symmetric around 1. */
const PCR_SCORE_CAP = 2;

/** #2 Call Option OI — build-up reads as fresh resistance (bearish lean). */
export function callOptionOiSignal(currentCallOi?: number, prevCallOi?: number): FactorScore {
  const base = { key: 'callOi' as const, label: 'Call OI build-up' };
  if (!isPos(currentCallOi) || !isPos(prevCallOi)) {
    return { ...base, score: 0, vote: 'neutral', available: false, detail: 'call OI unavailable' };
  }
  const changePct = pctChange(currentCallOi, prevCallOi);
  const score = clamp(Math.abs(changePct) / OPT_OI_CHANGE_CAP_PCT, 0, 1);
  // Only the BUILD-UP carries a lean; unwinding is left neutral.
  const vote: Vote = changePct > 0 ? 'sell' : 'neutral';
  return {
    ...base,
    score,
    vote,
    available: true,
    detail: `Call OI ${changePct >= 0 ? '+' : ''}${round(changePct, 1)}%${vote === 'sell' ? ' — resistance building (bearish lean)' : ''}`,
  };
}

/** #3 Put Option OI — build-up reads as fresh support (bullish lean). */
export function putOptionOiSignal(currentPutOi?: number, prevPutOi?: number): FactorScore {
  const base = { key: 'putOi' as const, label: 'Put OI build-up' };
  if (!isPos(currentPutOi) || !isPos(prevPutOi)) {
    return { ...base, score: 0, vote: 'neutral', available: false, detail: 'put OI unavailable' };
  }
  const changePct = pctChange(currentPutOi, prevPutOi);
  const score = clamp(Math.abs(changePct) / OPT_OI_CHANGE_CAP_PCT, 0, 1);
  const vote: Vote = changePct > 0 ? 'buy' : 'neutral';
  return {
    ...base,
    score,
    vote,
    available: true,
    detail: `Put OI ${changePct >= 0 ? '+' : ''}${round(changePct, 1)}%${vote === 'buy' ? ' — support building (bullish lean)' : ''}`,
  };
}

/** Put-Call OI ratio: > 1.2 put-heavy (bullish lean), < 0.8 call-heavy (bearish). */
export function pcrSignal(callOi?: number, putOi?: number): FactorScore {
  const base = { key: 'pcr' as const, label: 'Put-Call OI ratio' };
  if (!isPos(callOi) || !isPos(putOi)) {
    return { ...base, score: 0, vote: 'neutral', available: false, detail: 'PCR needs both call & put OI' };
  }
  const pcr = putOi / callOi;
  const vote: Vote = pcr > PCR_BULL ? 'buy' : pcr < PCR_BEAR ? 'sell' : 'neutral';
  // Distance from parity, symmetric: PCR = cap or 1/cap → score 1.
  const score = clamp(Math.abs(Math.log(pcr)) / Math.log(PCR_SCORE_CAP), 0, 1);
  const lean = vote === 'buy' ? 'put-heavy → bullish' : vote === 'sell' ? 'call-heavy → bearish' : 'balanced';
  return { ...base, score, vote, available: true, detail: `PCR ${round(pcr, 2)} (${lean})` };
}
