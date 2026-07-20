/**
 * Same-day scorecard for /trade-suggest calls.
 *
 * For each of today's persisted suggestions, replays the symbol's 5-min EQ
 * candles AFTER the suggestion time (from fyers_candles) and records, in SPOT
 * terms relative to spotAtSuggest:
 *   maxUpPct   — best upward excursion (favorable for CE)
 *   maxDownPct — worst downward excursion (favorable for PE)
 *   closePct   — where the last recorded bar closed
 *
 * MUST run the same day — fyers_candles keeps only today and clears at the
 * next session's first poll. The skill triggers this after 15:30 (or on the
 * loop's last pass).
 */

import { todayIST } from '@/lib/dhan/market-feed';
import { getFyersCandles } from '@/lib/fyers/candle-store';
import { gradeSpotPath } from '@/lib/trade-suggest/grade';
import { simulateAllPresets } from '@/lib/trade-suggest/profit-protect';
import { getSuggestions, recordOutcome } from '@/lib/trade-suggest/store';
import type { StoredSuggestion } from '@/lib/trade-suggest/types';

/** Baseline outcomes that carry a real R — the only ones a profit-protection
 *  counterfactual can be compared against like-for-like. */
const RESOLVED = new Set(['target', 'stop', 'timeout']);

const TAG = '[TradeSuggestReview]';

export interface ReviewResult {
  date: string;
  reviewed: number;
  skipped: number;
  suggestions: StoredSuggestion[];
}

export async function reviewToday(): Promise<ReviewResult> {
  const date = todayIST();
  const suggestions = await getSuggestions(date);
  let reviewed = 0;
  let skipped = 0;

  // Last 5-min candle of the NSE session for this date: 15:25 IST (covers
  // 15:25–15:30). grade.ts uses it to flag a 'timeout' whose data ended early.
  const expectedLastBucketSec = Math.floor(Date.parse(`${date}T15:25:00+05:30`) / 1000);

  for (const s of suggestions) {
    const sinceSec = Math.floor(Date.parse(s.suggestedAt) / 1000);
    // Pass the WHOLE day's bars (not pre-filtered to >= suggestion): the grader
    // needs the entry candle itself to detect the entry-candle blind spot.
    const bars = (await getFyersCandles(s.symbol, date, 'EQ')).filter((b) => b.high > 0);
    const postBars = bars.filter((b) => b.bucketTs >= sinceSec).sort((a, b) => a.bucketTs - b.bucketTs);
    if (postBars.length === 0 || s.spotAtSuggest <= 0) {
      skipped++;
      continue;
    }
    const pct = (v: number) => Math.round(((v - s.spotAtSuggest) / s.spotAtSuggest) * 10000) / 100;
    // Honest path-dependent grade against the stored plan (stop-before-target =
    // loss even if it recovers; entry-candle & gap cases are marked unresolvable
    // and excluded from the win-rate). Null only when the plan lacked levels —
    // then the excursion figures are recorded, as before.
    const grade = gradeSpotPath(s.optionType, s.spotAtSuggest, s.slSpot, s.targetSpot, bars, sinceSec, expectedLastBucketSec);
    // Profit-protection SHADOW (measurement only): only for a RESOLVED baseline,
    // so the counterfactual is compared like-for-like against a real R. Computed
    // now because fyers_candles clears at the next session — this is the sole
    // chance to grade today's paths. Persisted as a JSON blob { ruleName: R }.
    const protect =
      grade && RESOLVED.has(grade.outcome)
        ? simulateAllPresets(s.optionType, s.spotAtSuggest, s.slSpot, s.targetSpot, bars, sinceSec, expectedLastBucketSec)
        : null;
    await recordOutcome(date, s.symbol, s.optionType, {
      maxUpPct: grade?.maxUpPct ?? pct(Math.max(...postBars.map((b) => b.high))),
      maxDownPct: grade?.maxDownPct ?? pct(Math.min(...postBars.map((b) => b.low))),
      closePct: grade?.closePct ?? pct(postBars[postBars.length - 1].close),
      spotOutcome: grade?.outcome ?? null,
      spotOutcomeR: grade?.outcomeR ?? null,
      protectShadow: protect && Object.keys(protect).length > 0 ? JSON.stringify(protect) : null,
    });
    reviewed++;
  }

  console.log(`${TAG} ${date}: reviewed ${reviewed}, skipped ${skipped}`);
  return { date, reviewed, skipped, suggestions: await getSuggestions(date) };
}
