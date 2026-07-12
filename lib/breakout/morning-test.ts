/**
 * Check 1 — the morning test (accumulation signature).
 *
 * "If the low established in the first 5–15 minutes is never broken as the day
 * progresses, smart money buyers are in total control." The newer of the TF
 * trader's two stated windows (the entry-setups video said 30 min; the
 * breakout-secrets video refined it to 5–15, flexible to 20) — we use 15 min.
 *
 * Broken is STICKY for the day: per the strategy, a broken morning low after
 * entry is instant invalidation, and a later breakout from a broken-morning
 * name is the fakeout profile (TCS 18-May-2026). Recomputing from the full
 * day's bars keeps the stickiness for free.
 */

import type { SwingBar } from './swings';
import type { MorningTestState } from './types';

/** Session open, IST minute-of-day (9:15). */
const OPEN_MIN = 9 * 60 + 15;
/** Morning window length — the first 15 minutes (3 five-min bars). */
export const MORNING_WINDOW_MIN = 15;

/** IST minute-of-day for an epoch-second bar start (same math as session-context). */
export function istMinuteOfDay(bucketTs: number): number {
  const istSec = bucketTs + 5.5 * 3600;
  return Math.floor((((istSec % 86400) + 86400) % 86400) / 60);
}

/**
 * Derive the morning-test state from today's 5-min bars (chronological).
 *
 * `breakTolerancePct`: a later bar only counts as BREAKING the morning low
 * when it trades more than this % below it (mirror for the high) — filters
 * stop-hunt ticks a few paise through the level. 0 = strict (any tick).
 */
export function deriveMorningTest(
  bars: SwingBar[],
  windowMin: number = MORNING_WINDOW_MIN,
  breakTolerancePct = 0,
): MorningTestState {
  const windowEnd = OPEN_MIN + windowMin;
  const tol = 1 - breakTolerancePct / 100;
  const tolUp = 1 + breakTolerancePct / 100;
  let morningLow: number | null = null;
  let morningHigh: number | null = null;
  let complete = false;
  let lowBroken = false;
  let highBroken = false;
  let lowBrokenAtMin: number | null = null;
  let highBrokenAtMin: number | null = null;

  for (const b of bars) {
    if (!(b.high > 0) || !(b.low > 0)) continue;
    const m = istMinuteOfDay(b.bucketTs);
    if (m >= OPEN_MIN && m < windowEnd) {
      morningLow = morningLow === null ? b.low : Math.min(morningLow, b.low);
      morningHigh = morningHigh === null ? b.high : Math.max(morningHigh, b.high);
      continue;
    }
    if (m < OPEN_MIN) continue; // pre-open stray bar — ignore
    // At/after the window end: the window is final, later bars test it.
    complete = morningLow !== null;
    if (morningLow !== null && b.low < morningLow * tol && !lowBroken) {
      lowBroken = true;
      lowBrokenAtMin = m;
    }
    if (morningHigh !== null && b.high > morningHigh * tolUp && !highBroken) {
      highBroken = true;
      highBrokenAtMin = m;
    }
  }

  return { complete, morningLow, morningHigh, lowBroken, highBroken, lowBrokenAtMin, highBrokenAtMin };
}
