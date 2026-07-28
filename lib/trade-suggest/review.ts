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
import { getFyersCandles, getRetainedCandleDates } from '@/lib/fyers/candle-store';
import { gradeSpotPath } from '@/lib/trade-suggest/grade';
import { simulateAllPresets } from '@/lib/trade-suggest/profit-protect';
import { getDatesWithUngradedPicks, getSuggestions, recordOutcome } from '@/lib/trade-suggest/store';
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

export interface BacklogResult {
  /** Dates graded this run, oldest first (today included when it has picks). */
  dates: string[];
  reviewed: number;
  skipped: number;
  /** Dates that hold ungraded picks but whose candles are already pruned —
   *  permanently ungradeable. Surfaced so the loss is visible, not silent. */
  expired: string[];
}

/**
 * Grade every retained session that still holds UNGRADED picks — today plus any
 * evening the grader never ran.
 *
 * Why this exists: the poller only ever called reviewToday(), so a session
 * missed for any reason (box restart, deploy, the feature not existing yet)
 * was never revisited, even though its candles stay for 20 sessions. Measured
 * 2026-07-28: 87 of 176 recorded picks had no outcome, and everything before
 * 21 Jul had aged past the candle window while still ungraded — the sample that
 * every "is this toggle working?" question depends on was quietly expiring.
 *
 * Idempotent and cheap: local candle reads only, no broker/AI call. Already-
 * graded dates are skipped, so a normal evening does today and nothing else.
 * A grader BUG FIX still needs scripts/regrade-suggestions.ts, which re-grades
 * retained history whether or not it already has outcomes.
 */
export async function reviewUngradedBacklog(): Promise<BacklogResult> {
  const pending = await getDatesWithUngradedPicks();
  const gradeable = new Set(await getRetainedCandleDates());
  const dates = pending.filter((d) => gradeable.has(d)).sort();
  const expired = pending.filter((d) => !gradeable.has(d)).sort();

  let reviewed = 0;
  let skipped = 0;
  const done: string[] = [];
  for (const date of dates) {
    try {
      const r = await reviewDate(date);
      reviewed += r.reviewed;
      skipped += r.skipped;
      done.push(date);
    } catch (err) {
      // One bad session must never stop the rest of the backlog.
      console.warn(`${TAG} backlog grade failed for ${date}: ${(err as Error).message}`);
    }
  }
  if (expired.length > 0) {
    // Bounded on purpose: this set only ever GROWS (every session that ages out
    // with an ungraded pick joins it forever), so listing it in full would make
    // one nightly log line longer every week. Count + range says the same thing.
    const range = expired.length === 1 ? expired[0] : `${expired[0]}..${expired[expired.length - 1]}`;
    console.warn(
      `${TAG} ${expired.length} session(s) hold ungraded picks whose candles are already pruned — permanently ungradeable (${range})`,
    );
  }
  return { dates: done, reviewed, skipped, expired };
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
      // Persist only when at least one RULE resolved (the blob always carries a
      // `_v` metadata stamp, so count non-`_` keys — never store a rules-less blob).
      protectShadow:
        protect && Object.keys(protect).some((k) => !k.startsWith('_')) ? JSON.stringify(protect) : null,
    });
    reviewed++;
  }

  console.log(`${TAG} ${date}: reviewed ${reviewed}, skipped ${skipped}`);
  return { date, reviewed, skipped, suggestions: await getSuggestions(date) };
}
