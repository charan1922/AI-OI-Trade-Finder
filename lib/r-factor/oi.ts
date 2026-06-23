/**
 * R-Factor library — futures open-interest factors.
 *
 *  • futuresOiSignal      — intensity of fresh OI (magnitude only; not directional)
 *  • oiDirectionSignal    — price+OI four-quadrant read (the directional vote)
 *  • oiVsTwentyDaySignal  — current OI vs its 20-session average (sustained level)
 */

import { direction, isPos, pctChange, round, scoreFromMagnitude, scoreFromRatio } from './math';
import type { FactorScore } from './types';

/** A daily OI change of this % counts as maximal "fresh positioning" intensity. */
const OI_CHANGE_CAP_PCT = 10;
/** OI at (1 + this)× its 20-day average scores 1.0 — i.e. 1.5× average = max. */
const OI_LEVEL_CAP_EXCESS = 0.5;
/** Price/OI moves smaller than this (%) are treated as flat. */
const DEADBAND_PCT = 0.1;

/**
 * #4 Futures OI — how much fresh positioning piled on vs the previous session.
 * Intensity ONLY (vote stays neutral); which side is winning is oiDirectionSignal's
 * job, because OI alone is one long per short and says nothing about direction.
 */
export function futuresOiSignal(currentOi?: number, prevOi?: number): FactorScore {
  const base = { key: 'futuresOi' as const, label: 'Futures OI (fresh positioning)' };
  if (!isPos(currentOi) || !isPos(prevOi)) {
    return { ...base, score: 0, vote: 'neutral', available: false, detail: 'futures OI unavailable' };
  }
  const changePct = pctChange(currentOi, prevOi);
  return {
    ...base,
    score: scoreFromMagnitude(changePct, OI_CHANGE_CAP_PCT),
    vote: 'neutral',
    available: true,
    detail: `OI ${changePct >= 0 ? '+' : ''}${round(changePct, 1)}% vs prev session (intensity only)`,
  };
}

/**
 * #9 OI direction — the four-quadrant framework. Reads PRICE alongside OI to turn
 * "fresh positions opened" into a side. Buildups are conviction-strong; covering /
 * unwinding are exits (weaker).
 */
export function oiDirectionSignal(priceChangePct: number, oiChangePct: number): FactorScore {
  const base = { key: 'oiDirection' as const, label: 'Price + OI direction' };
  const p = direction(priceChangePct, DEADBAND_PCT);
  const o = direction(oiChangePct, DEADBAND_PCT);

  if (p === 'flat' || o === 'flat') {
    return { ...base, score: 0, vote: 'neutral', available: true, detail: 'flat price or OI — no clear buildup' };
  }
  if (o === 'up' && p === 'up') {
    return { ...base, score: 0.85, vote: 'buy', available: true, detail: 'long buildup (price↑ + OI↑) — bullish conviction' };
  }
  if (o === 'up' && p === 'down') {
    return { ...base, score: 0.85, vote: 'sell', available: true, detail: 'short buildup (price↓ + OI↑) — bearish conviction' };
  }
  if (o === 'down' && p === 'up') {
    return { ...base, score: 0.4, vote: 'buy', available: true, detail: 'short covering (price↑ + OI↓) — bullish but weak' };
  }
  return { ...base, score: 0.4, vote: 'sell', available: true, detail: 'long unwinding (price↓ + OI↓) — bearish but weak' };
}

/**
 * #11 Compare last 20 days OI — the sustained-accumulation level (oi_level). A
 * level well above the 20-session average is the institutional-buildup signal that
 * a single-day OI change misses.
 */
export function oiVsTwentyDaySignal(currentOi?: number, oi20dAvg?: number): FactorScore {
  const base = { key: 'oiLevel' as const, label: 'OI vs 20-day average' };
  if (!isPos(currentOi) || !isPos(oi20dAvg)) {
    return { ...base, score: 0, vote: 'neutral', available: false, detail: 'OI or 20-day average unavailable' };
  }
  const level = currentOi / oi20dAvg;
  return {
    ...base,
    score: scoreFromRatio(currentOi, oi20dAvg, OI_LEVEL_CAP_EXCESS),
    vote: 'neutral',
    available: true,
    detail: `OI level ${round(level, 2)}× the 20-day average (sustained accumulation)`,
  };
}
