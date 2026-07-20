/**
 * Scorecard for /trade-suggest calls (defaults to today; any retained date).
 *
 * For each of the date's persisted suggestions, replays the symbol's 5-min EQ
 * candles AFTER the suggestion time (from fyers_candles) and records, in SPOT
 * terms relative to spotAtSuggest:
 *   maxUpPct   — best upward excursion (favorable for CE)
 *   maxDownPct — worst downward excursion (favorable for PE)
 *   closePct   — where the last recorded bar closed
 *
 * fyers_candles retains the newest FYERS_CANDLE_RETENTION_SESSIONS (20) sessions
 * (candle-store.ts), so this can grade today live OR replay a retained past
 * session. The poller triggers it after 16:00; scripts/regrade-suggestions.ts
 * replays the retained history. Dates OLDER than the retention window can no
 * longer be graded (their candles are pruned).
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

/** Grade today's picks (poller / skill entry point). */
export async function reviewToday(): Promise<ReviewResult> {
  return reviewDate(todayIST());
}

/**
 * Grade one date's persisted picks against its retained 5-min candles. Same
 * logic for live (today) and replay (any of the newest ~20 retained sessions —
 * FYERS_CANDLE_RETENTION_SESSIONS). Idempotent: re-running overwrites the
 * outcome columns, so a bug fix can be re-applied to retained history via
 * scripts/regrade-suggestions.ts.
 */
export async function reviewDate(date: string): Promise<ReviewResult> {
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
    const bars = (await getFyersCandles(s.symbol, date, 'EQ'))
      .filter((b) => b.high > 0)
      .sort((a, b) => a.bucketTs - b.bucketTs);
    // Skip ONLY when there is genuinely nothing to grade (no candles at all / no
    // valid entry spot). A suggestion during the LAST candle still has bars, so
    // it is graded — the grader returns 'incomplete' (an unresolvable blind spot)
    // rather than being silently dropped as unreviewed (PR#4 review #3). That
    // way data-quality failures surface under `unresolvable`, not as gaps.
    if (bars.length === 0 || s.spotAtSuggest <= 0) {
      skipped++;
      continue;
    }
    const pct = (v: number) => Math.round(((v - s.spotAtSuggest) / s.spotAtSuggest) * 10000) / 100;
    // Honest path-dependent grade against the stored plan (stop-before-target =
    // loss even if it recovers; entry-candle / gap / truncation cases are marked
    // unresolvable and excluded from the win-rate). Null ONLY when the plan
    // lacked well-formed levels — then only the excursion figures are recorded.
    const grade = gradeSpotPath(s.optionType, s.spotAtSuggest, s.slSpot, s.targetSpot, bars, sinceSec, expectedLastBucketSec);
    // Profit-protection SHADOW (measurement only): only for a RESOLVED baseline,
    // so the counterfactual is compared like-for-like against a real R. Computed
    // at review time (same-day, or a replay of a retained session) — persisted as
    // a JSON blob { ruleName: R }.
    const protect =
      grade && RESOLVED.has(grade.outcome)
        ? simulateAllPresets(s.optionType, s.spotAtSuggest, s.slSpot, s.targetSpot, bars, sinceSec, expectedLastBucketSec)
        : null;
    // Excursion fallback window (used only when grade is null): bars from the
    // suggestion onward, or the whole day if none land after it.
    const fb = bars.filter((b) => b.bucketTs >= sinceSec);
    const fbBars = fb.length > 0 ? fb : bars;
    await recordOutcome(date, s.symbol, s.optionType, {
      maxUpPct: grade?.maxUpPct ?? pct(Math.max(...fbBars.map((b) => b.high))),
      maxDownPct: grade?.maxDownPct ?? pct(Math.min(...fbBars.map((b) => b.low))),
      closePct: grade?.closePct ?? pct(fbBars[fbBars.length - 1].close),
      spotOutcome: grade?.outcome ?? null,
      spotOutcomeR: grade?.outcomeR ?? null,
      protectShadow: protect && Object.keys(protect).length > 0 ? JSON.stringify(protect) : null,
    });
    reviewed++;
  }

  console.log(`${TAG} ${date}: reviewed ${reviewed}, skipped ${skipped}`);
  return { date, reviewed, skipped, suggestions: await getSuggestions(date) };
}
