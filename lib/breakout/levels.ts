/**
 * Check 3 — the named-level ladder (multi-level aggression).
 *
 * "The strongest breakouts shatter several resistances at once" — TECHM's
 * winning surge cleared the morning high, a prior swing high AND the prev-day
 * high simultaneously; PERSISTENT cleared only two → valid but weaker.
 *
 * Levels, bullish side (mirrored for bearish):
 *   • OR high         — the 9:15–9:45 opening range (codebase convention for
 *                       "morning high"; only once the range is complete)
 *   • prev-day high   — bhavcopy eqHigh of the most recent session
 *   • 5d / 20d high   — multi-day base tops (the ADANIENSOL-style base
 *                       breakout futures OI misses); skipped when they're the
 *                       same physical candle as prev-day high
 *   • swing highs     — today's completed intraday pivots formed AFTER the OR
 *                       window (a pivot inside the OR is the OR high itself)
 *
 * Distinct structural levels that happen to sit at the same price are counted
 * SEPARATELY (that coincidence is exactly what makes a breakout aggressive —
 * TECHM's three levels sat on one line). Only same-source duplicates are
 * dropped (5d high == prev-day high, or a swing within 0.1% of a named level).
 */

import { detectSwings, type SwingBar } from './swings';
import { istMinuteOfDay } from './morning-test';
import type { BreakoutLevel } from './types';

/** Swings closer than this (%) to an already-named level are the same structure. */
const LEVEL_DUP_PCT = 0.1;
/** Keep at most this many swing levels per side (the most recent ones). */
const MAX_SWING_LEVELS = 3;
/** End of the opening range, IST minute-of-day (9:45). */
const OR_END_MIN = 9 * 60 + 45;

export interface LevelInputs {
  /** Opening range (9:15–9:45), only when complete. */
  openRangeHigh: number | null;
  openRangeLow: number | null;
  openRangeComplete: boolean;
  /** Prev-session and multi-day extremes from bhavcopy (null when not synced). */
  priorDayHigh: number | null;
  priorDayLow: number | null;
  high5d: number | null;
  low5d: number | null;
  high20d: number | null;
  low20d: number | null;
}

const near = (a: number, b: number): boolean => Math.abs(a - b) / b * 100 < LEVEL_DUP_PCT;

/** Build the named resistance/support ladders from bars + EOD inputs. */
export function buildLevels(bars: SwingBar[], inp: LevelInputs): { resistances: BreakoutLevel[]; supports: BreakoutLevel[] } {
  const resistances: BreakoutLevel[] = [];
  const supports: BreakoutLevel[] = [];

  if (inp.openRangeComplete && inp.openRangeHigh != null && inp.openRangeHigh > 0) {
    resistances.push({ name: 'OR high', kind: 'open-range', price: inp.openRangeHigh });
  }
  if (inp.openRangeComplete && inp.openRangeLow != null && inp.openRangeLow > 0) {
    supports.push({ name: 'OR low', kind: 'open-range', price: inp.openRangeLow });
  }
  if (inp.priorDayHigh != null && inp.priorDayHigh > 0) {
    resistances.push({ name: 'prev-day high', kind: 'prev-day', price: inp.priorDayHigh });
  }
  if (inp.priorDayLow != null && inp.priorDayLow > 0) {
    supports.push({ name: 'prev-day low', kind: 'prev-day', price: inp.priorDayLow });
  }
  // Multi-day base tops/bottoms — only when they're a DIFFERENT candle than
  // prev-day's (equal price = same physical level, not extra aggression).
  if (inp.high5d != null && inp.high5d > 0 && !(inp.priorDayHigh != null && inp.high5d <= inp.priorDayHigh)) {
    resistances.push({ name: '5d high', kind: 'multi-day', price: inp.high5d });
  }
  if (inp.low5d != null && inp.low5d > 0 && !(inp.priorDayLow != null && inp.low5d >= inp.priorDayLow)) {
    supports.push({ name: '5d low', kind: 'multi-day', price: inp.low5d });
  }
  if (inp.high20d != null && inp.high20d > 0 && !(inp.high5d != null && inp.high20d <= inp.high5d) && !(inp.priorDayHigh != null && inp.high20d <= inp.priorDayHigh)) {
    resistances.push({ name: '20d high', kind: 'multi-day', price: inp.high20d });
  }
  if (inp.low20d != null && inp.low20d > 0 && !(inp.low5d != null && inp.low20d >= inp.low5d) && !(inp.priorDayLow != null && inp.low20d >= inp.priorDayLow)) {
    supports.push({ name: '20d low', kind: 'multi-day', price: inp.low20d });
  }

  // Today's completed swings formed after the opening range. Skip pivots that
  // are the same structure as an already-named level.
  const swings = detectSwings(bars);
  const named = [...resistances, ...supports];
  const freshHighs = swings.highs
    .filter((s) => istMinuteOfDay(s.bucketTs) >= OR_END_MIN)
    .filter((s) => !named.some((l) => near(s.price, l.price)))
    .slice(-MAX_SWING_LEVELS);
  const freshLows = swings.lows
    .filter((s) => istMinuteOfDay(s.bucketTs) >= OR_END_MIN)
    .filter((s) => !named.some((l) => near(s.price, l.price)))
    .slice(-MAX_SWING_LEVELS);
  for (const s of freshHighs) resistances.push({ name: 'swing high', kind: 'swing', price: s.price });
  for (const s of freshLows) supports.push({ name: 'swing low', kind: 'swing', price: s.price });

  resistances.sort((a, b) => a.price - b.price);
  supports.sort((a, b) => b.price - a.price);
  return { resistances, supports };
}
