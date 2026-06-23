/**
 * R-Factor library — money-flow factors.
 *
 *  • turnoverSignal                — futures turnover vs its 20-day average
 *  • volumeSignal                  — volume vs its 20-day average (supporting)
 *  • smartMoneyAccumulationSignal  — composite "institutional conviction" proxy
 *
 * Note: smart-money accumulation deliberately overlaps turnover + OI level — it is
 * the headline summary read. The engine weights it modestly so it doesn't double-
 * count its own components. There is no delivery-% input (that NSE feed is empty in
 * this project), so accumulation is proxied from OI build + turnover, not delivery.
 */

import { clamp, direction, isPos, round, scoreFromRatio } from './math';
import type { FactorScore, Vote } from './types';

/** Turnover/volume at (1 + this)× the 20-day average scores 1.0 — i.e. 3× = max. */
const TURNOVER_CAP_EXCESS = 2;
const VOLUME_CAP_EXCESS = 2;
/** OI at (1 + this)× its 20-day average is maximal level (matches oi.ts). */
const OI_LEVEL_CAP_EXCESS = 0.5;
/** Price/OI moves smaller than this (%) are treated as flat. */
const DEADBAND_PCT = 0.1;

/** #5 Turnover — real-money participation vs the 20-session baseline. */
export function turnoverSignal(turnover?: number, turnover20dAvg?: number): FactorScore {
  const base = { key: 'turnover' as const, label: 'Turnover vs 20-day average' };
  if (!isPos(turnover) || !isPos(turnover20dAvg)) {
    return { ...base, score: 0, vote: 'neutral', available: false, detail: 'turnover or baseline unavailable' };
  }
  const ratio = turnover / turnover20dAvg;
  return {
    ...base,
    score: scoreFromRatio(turnover, turnover20dAvg, TURNOVER_CAP_EXCESS),
    vote: 'neutral',
    available: true,
    detail: `turnover ${round(ratio, 2)}× the 20-day average (real-money participation)`,
  };
}

/** #7 Volume — supporting confirmation vs the 20-session baseline. */
export function volumeSignal(volume?: number, volume20dAvg?: number): FactorScore {
  const base = { key: 'volume' as const, label: 'Volume vs 20-day average' };
  if (!isPos(volume) || !isPos(volume20dAvg)) {
    return { ...base, score: 0, vote: 'neutral', available: false, detail: 'volume or baseline unavailable' };
  }
  const ratio = volume / volume20dAvg;
  return {
    ...base,
    score: scoreFromRatio(volume, volume20dAvg, VOLUME_CAP_EXCESS),
    vote: 'neutral',
    available: true,
    detail: `volume ${round(ratio, 2)}× the 20-day average`,
  };
}

/**
 * #1 Smart-money accumulation — a composite "institutional conviction" read:
 * elevated turnover and a high sustained OI level, but only counted as genuine
 * ACCUMULATION when OI is actually building this session (otherwise the same
 * activity is churn). Direction comes from the price side of the build.
 */
export function smartMoneyAccumulationSignal(args: {
  priceChangePct: number;
  oiChangePct: number;
  turnover?: number;
  turnover20dAvg?: number;
  currentOi?: number;
  oi20dAvg?: number;
}): FactorScore {
  const base = { key: 'smartMoney' as const, label: 'Smart-money accumulation' };
  const { priceChangePct, oiChangePct, turnover, turnover20dAvg, currentOi, oi20dAvg } = args;

  const turnRatio = isPos(turnover) && isPos(turnover20dAvg) ? turnover / turnover20dAvg : null;
  const levelRatio = isPos(currentOi) && isPos(oi20dAvg) ? currentOi / oi20dAvg : null;
  if (turnRatio === null && levelRatio === null) {
    return { ...base, score: 0, vote: 'neutral', available: false, detail: 'needs turnover and/or OI-level inputs' };
  }

  const turnScore = turnRatio === null ? null : clamp((turnRatio - 1) / TURNOVER_CAP_EXCESS, 0, 1);
  const levelScore = levelRatio === null ? null : clamp((levelRatio - 1) / OI_LEVEL_CAP_EXCESS, 0, 1);
  const comps = [turnScore, levelScore].filter((x): x is number => x !== null);
  const strength = comps.reduce((a, b) => a + b, 0) / comps.length;

  const oiBuilding = direction(oiChangePct, DEADBAND_PCT) === 'up';
  const priceDir = direction(priceChangePct, DEADBAND_PCT);
  // Accumulation is only "fresh" when OI is building; otherwise discount and stay neutral.
  const score = oiBuilding ? strength : strength * 0.3;
  const vote: Vote = oiBuilding && priceDir === 'up' ? 'buy' : oiBuilding && priceDir === 'down' ? 'sell' : 'neutral';

  const bits: string[] = [];
  if (turnRatio !== null) bits.push(`${round(turnRatio, 2)}× turnover`);
  if (levelRatio !== null) bits.push(`OI level ${round(levelRatio, 2)}×`);
  const detail = oiBuilding
    ? `OI building, ${bits.join(', ')} (${vote === 'buy' ? 'bullish' : vote === 'sell' ? 'bearish' : 'flat'} conviction)`
    : `OI not building — ${bits.join(', ')} reads as churn, not fresh accumulation`;
  return { ...base, score, vote, available: true, detail };
}
