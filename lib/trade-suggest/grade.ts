/**
 * Honest, PATH-DEPENDENT spot grading for /trade-suggest calls
 * (backtest-trustworthiness — Layer A of #7; hardened per PR#3 + PR#4 review).
 *
 * The old scorecard scored a "hit" as `maxUpPct >= 1%` over the WHOLE day —
 * path-independent and blind to the plan's stop. This walks the 5-min bars in
 * TIME and records which of the plan's stop / target is reached FIRST, so a
 * stop-out stays a stop-out even if the name recovers afterwards.
 *
 * PURE and replayable: no I/O, no clocks; the caller supplies bars + the
 * suggestion time — same discipline as scoring.ts, so it grades identically
 * live and in replay.
 *
 * HONEST about what 5-min OHLC can and cannot resolve (PR#3 review):
 *  - the ENTRY candle straddles the suggestion, so its high/low mixes pre- and
 *    post-suggestion movement. When the suggestion lands mid-candle AND that
 *    candle touched a level, the timing is unknowable → 'entry-ambiguous';
 *  - a MISSING candle (recorder gap, or the session truncated early) could hide
 *    EITHER level, so any outcome that sits behind a gap — target, stop, or
 *    timeout — is downgraded to 'incomplete' rather than credited (symmetric:
 *    a −1R stop is never counted across a gap either);
 *  - 'entry-ambiguous' and 'incomplete' carry a null R and are EXCLUDED from the
 *    honest win-rate / expectancy — never counted as clean wins or losses.
 */
import type { StoredFyersBar } from '@/lib/fyers/candle-store';

/** Resolvable outcomes carry an R; the two unresolvable ones do not. */
export type SpotOutcome = 'target' | 'stop' | 'timeout' | 'entry-ambiguous' | 'incomplete';

export interface SpotGrade {
  outcome: SpotOutcome;
  /** Realised R vs the plan's own risk for RESOLVED outcomes (stop −1, target
   *  +plannedRR, timeout close-based); null for entry-ambiguous / incomplete. */
  outcomeR: number | null;
  /** Context excursions over the graded (post-suggestion) window, spot % vs entry. */
  maxUpPct: number;
  maxDownPct: number;
  closePct: number;
}

const BUCKET = 300; // 5-min candle, seconds
const round2 = (n: number) => Math.round(n * 100) / 100;
const pctOf = (v: number, entry: number) => Math.round(((v - entry) / entry) * 10000) / 100;

export function gradeSpotPath(
  optionType: 'CE' | 'PE',
  entry: number,
  stop: number | null,
  target: number | null,
  bars: Pick<StoredFyersBar, 'bucketTs' | 'high' | 'low' | 'close'>[],
  sinceSec: number,
  /** Expected LAST 5-min bucket of the session (e.g. 15:25 IST). When given, a
   *  'timeout' whose data ends before it is downgraded to 'incomplete' (the
   *  recorder died early; a late stop could be hidden). */
  expectedLastBucketSec?: number,
): SpotGrade | null {
  const all = bars.filter((b) => b.high > 0 && b.low > 0).sort((a, b) => a.bucketTs - b.bucketTs);
  if (all.length === 0 || !(entry > 0) || stop == null || target == null || !(sinceSec > 0)) return null;

  const bull = optionType === 'CE';
  // Plan must be well-formed for the direction (stop on the risk side, target on
  // the reward side, real risk) — else it can't be honestly graded.
  const risk = bull ? entry - stop : stop - entry;
  const reward = bull ? target - entry : entry - target;
  if (!(risk > 0) || !(reward > 0)) return null;
  const plannedRR = round2(reward / risk);

  const touchesStop = (b: { high: number; low: number }) => (bull ? b.low <= stop : b.high >= stop);
  const touchesTarget = (b: { high: number; low: number }) => (bull ? b.high >= target : b.low <= target);

  const entryBucket = Math.floor(sinceSec / BUCKET) * BUCKET;
  const midCandle = sinceSec > entryBucket; // suggestion lands INSIDE the entry candle
  const entryBar = all.find((b) => b.bucketTs === entryBucket) ?? null;

  // Post-suggestion bars: strictly AFTER the entry candle when the suggestion is
  // mid-candle; from the entry candle itself when it sits on the bucket boundary
  // (the whole candle is then post-suggestion).
  const pathBars = all.filter((b) => (midCandle ? b.bucketTs > entryBucket : b.bucketTs >= entryBucket));

  const ctx = pathBars.length > 0 ? pathBars : all;
  const base = {
    maxUpPct: pctOf(Math.max(...ctx.map((b) => b.high)), entry),
    maxDownPct: pctOf(Math.min(...ctx.map((b) => b.low)), entry),
    closePct: pctOf(ctx[ctx.length - 1].close, entry),
  };

  // Entry-candle blind spot: mid-candle suggestion whose entry candle touched a
  // level — can't tell if it happened before or after entry.
  if (midCandle && entryBar && (touchesStop(entryBar) || touchesTarget(entryBar))) {
    return { outcome: 'entry-ambiguous', outcomeR: null, ...base };
  }
  // Missing entry period (mid-candle but no entry candle recorded), or nothing
  // to grade after entry → a stop could have hit unseen. Unresolvable.
  if ((midCandle && !entryBar) || pathBars.length === 0) {
    return { outcome: 'incomplete', outcomeR: null, ...base };
  }

  // Walk the post-entry path in time. A MISSING candle before EITHER level is
  // reached hides a possible stop AND a possible target, so the order can't be
  // known — return 'incomplete' the moment a gap appears, symmetrically. (The
  // old code set a flag but still let a later candle resolve as a −1R stop
  // across the gap, biasing expectancy pessimistically — PR#4 review #2.)
  let prevTs = midCandle ? entryBucket : entryBucket - BUCKET; // bucket expected just before the first pathBar
  for (const b of pathBars) {
    if (b.bucketTs - prevTs > BUCKET) return { outcome: 'incomplete', outcomeR: null, ...base };
    prevTs = b.bucketTs;
    if (touchesStop(b)) return { outcome: 'stop', outcomeR: -1, ...base }; // stop wins a same-candle tie
    if (touchesTarget(b)) return { outcome: 'target', outcomeR: plannedRR, ...base };
  }

  // Neither level reached across a fully contiguous path. If the data ended
  // before the session's expected last candle, a late stop/target could be
  // hidden → incomplete. `lastTs < expectedLast` catches a session missing only
  // its last bucket (that candle could hold the stop/target) — `lastTs + BUCKET
  // < expectedLast` (off by one, PR#4 review #1) would miss it.
  const lastTs = pathBars[pathBars.length - 1].bucketTs;
  const truncated = expectedLastBucketSec != null && lastTs < expectedLastBucketSec;
  if (truncated) return { outcome: 'incomplete', outcomeR: null, ...base };

  const close = pathBars[pathBars.length - 1].close;
  const timeoutR = round2((bull ? close - entry : entry - close) / risk);
  return { outcome: 'timeout', outcomeR: timeoutR, ...base };
}
