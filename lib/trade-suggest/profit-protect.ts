/**
 * Profit-protection SHADOW simulator (strategy investigation follow-up).
 *
 * The honest scorecard (grade.ts) showed the scanner's LOSERS routinely reach
 * ~+1R before giving it all back — an EXIT problem, not an entry problem. This
 * simulates what the SAME trades would have realised under candidate
 * profit-protection rules (move the stop up once the trade is in profit), so we
 * can measure whether such a rule improves expectancy BEFORE proposing it live.
 *
 * MEASUREMENT ONLY. Pure and path-dependent — same walking discipline as
 * grade.ts (which stays the source of truth for the honest baseline): it steps
 * the 5-min bars in TIME, so a stop-out before the trigger is still a stop-out.
 * No I/O, no clocks; the caller supplies bars + the suggestion time, so it runs
 * identically live and in replay.
 *
 * Every candidate rule is a TIGHTEN-ONLY stop move (the stop only ratchets
 * toward profit, never loosens) — so each is executable live within the user's
 * "stop moves may only tighten" rule. Partial-booking is deliberately NOT
 * modelled: the desk trades one indivisible lot, so half-exits aren't real.
 *
 * NO intra-candle lookahead: the protective stop that guards bar N is set from
 * the max-favourable-excursion through bar N-1 only. We never let a candle's own
 * high raise the stop that then "saves" that same candle's low.
 */
import type { StoredFyersBar } from '@/lib/fyers/candle-store';

/** Outcome under a protection rule. 'protected' = stopped at the ratcheted
 *  breakeven/locked level AFTER the trigger fired (R ≥ 0); 'stop' = the ORIGINAL
 *  -1R stop hit before the trigger; the rest mirror grade.ts. */
export type ProtectOutcome = 'target' | 'protected' | 'stop' | 'timeout' | 'entry-ambiguous' | 'incomplete';

export interface ProtectRule {
  /** Stable key persisted in the shadow blob + shown in the report. */
  name: string;
  /** MFE (in R) that must be reached before the stop is moved up. */
  triggerR: number;
  /** 'breakeven' pins the stop to entry (0R) once triggered; 'trail' locks
   *  (MFE - lockGapR), ratcheting up as MFE grows. */
  mode: 'breakeven' | 'trail';
  /** Only for 'trail': R kept BELOW the running MFE (e.g. 0.5 locks half). */
  lockGapR?: number;
}

export interface ProtectGrade {
  outcome: ProtectOutcome;
  /** Realised R vs the plan's own initial risk. null for the unresolvable
   *  outcomes (entry-ambiguous / incomplete), exactly like grade.ts. */
  outcomeR: number | null;
}

/** Candidate rules the report compares against the fixed-plan baseline. Keep
 *  these executable (tighten-only stop moves) and few — every extra rule needs
 *  live days of data to calibrate. */
export const PROTECT_PRESETS: ProtectRule[] = [
  { name: 'breakeven@1R', triggerR: 1, mode: 'breakeven' },
  { name: 'breakeven@1.5R', triggerR: 1.5, mode: 'breakeven' },
  { name: 'trail@1R-lock0.5', triggerR: 1, mode: 'trail', lockGapR: 0.5 },
];

const BUCKET = 300; // 5-min candle, seconds
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The stop's R-level given the running MFE and the rule — before any
 *  tighten-only clamp. Below the trigger the stop stays at the original -1R. */
function ruleStopR(rule: ProtectRule, mfeR: number): number {
  if (mfeR < rule.triggerR) return -1;
  if (rule.mode === 'breakeven') return 0;
  return mfeR - (rule.lockGapR ?? 0); // 'trail'
}

export function simulateProtected(
  optionType: 'CE' | 'PE',
  entry: number,
  stop: number | null,
  target: number | null,
  bars: Pick<StoredFyersBar, 'bucketTs' | 'high' | 'low' | 'close'>[],
  sinceSec: number,
  rule: ProtectRule,
  /** Expected last 5-min bucket of the session — same guard as grade.ts: a path
   *  that ends before it could hide a late exit → 'incomplete'. */
  expectedLastBucketSec?: number,
): ProtectGrade | null {
  const all = bars.filter((b) => b.high > 0 && b.low > 0).sort((a, b) => a.bucketTs - b.bucketTs);
  if (all.length === 0 || !(entry > 0) || stop == null || target == null || !(sinceSec > 0)) return null;

  const bull = optionType === 'CE';
  const risk = bull ? entry - stop : stop - entry;
  const reward = bull ? target - entry : entry - target;
  if (!(risk > 0) || !(reward > 0)) return null;
  const plannedRR = round2(reward / risk);
  const dir = bull ? 1 : -1;

  // Excursions in R vs the immutable initial risk (grade.ts / reanchor.ts share
  // this convention). favExc = best R the bar reached; advExc = worst (≤ 0-ish).
  const favExc = (b: { high: number; low: number }) => (dir * ((bull ? b.high : b.low) - entry)) / risk;
  const advExc = (b: { high: number; low: number }) => (dir * ((bull ? b.low : b.high) - entry)) / risk;

  const entryBucket = Math.floor(sinceSec / BUCKET) * BUCKET;
  const midCandle = sinceSec > entryBucket;
  const entryBar = all.find((b) => b.bucketTs === entryBucket) ?? null;
  const pathBars = all.filter((b) => (midCandle ? b.bucketTs > entryBucket : b.bucketTs >= entryBucket));

  // Entry-candle blind spot + missing entry period — mirror grade.ts exactly so
  // the baseline and the counterfactual are computed over the SAME resolvable set.
  const touchesInitStop = (b: { high: number; low: number }) => (bull ? b.low <= stop : b.high >= stop);
  const touchesTarget = (b: { high: number; low: number }) => (bull ? b.high >= target : b.low <= target);
  if (midCandle && entryBar && (touchesInitStop(entryBar) || touchesTarget(entryBar))) {
    return { outcome: 'entry-ambiguous', outcomeR: null };
  }
  if ((midCandle && !entryBar) || pathBars.length === 0) return { outcome: 'incomplete', outcomeR: null };

  let prevTs = midCandle ? entryBucket : entryBucket - BUCKET;
  let mfePrior = 0; // MFE (R) through the PREVIOUS bar — never this bar (no lookahead)
  let stopR = -1; // ratcheted stop level, in R; starts at the original stop
  for (const b of pathBars) {
    if (b.bucketTs - prevTs > BUCKET) return { outcome: 'incomplete', outcomeR: null }; // gap hides order
    prevTs = b.bucketTs;

    // Resolve THIS bar against the stop set from PRIOR bars (stop wins a tie).
    if (advExc(b) <= stopR) {
      // Below the trigger the stop is still the original -1R → a plain stop-out;
      // at/above 0R it's the protected exit (breakeven or a locked gain).
      return stopR <= -1 ? { outcome: 'stop', outcomeR: -1 } : { outcome: 'protected', outcomeR: round2(stopR) };
    }
    if (favExc(b) >= plannedRR) return { outcome: 'target', outcomeR: plannedRR };

    // Ratchet the stop from THIS bar's favourable excursion, for the NEXT bar.
    mfePrior = Math.max(mfePrior, favExc(b));
    stopR = Math.max(stopR, ruleStopR(rule, mfePrior)); // tighten-only
  }

  // Neither level hit on a contiguous path. Same truncation guard as grade.ts:
  // a session missing its final candle could hide a late exit → incomplete.
  const lastTs = pathBars[pathBars.length - 1].bucketTs;
  if (expectedLastBucketSec != null && lastTs < expectedLastBucketSec) {
    return { outcome: 'incomplete', outcomeR: null };
  }
  // A fully walked path → timeout at the last close, floored at the ratcheted
  // stop (we could never have sat through a level below stopR without exiting).
  const close = pathBars[pathBars.length - 1].close;
  const closeR = round2((dir * (close - entry)) / risk);
  return { outcome: 'timeout', outcomeR: Math.max(closeR, round2(stopR)) };
}

/** All presets' counterfactual R for one trade, keyed by rule name. Unresolvable
 *  trades (null R, or a plan the grader can't score) contribute nothing and are
 *  omitted so the aggregator's denominator stays honest. */
export function simulateAllPresets(
  optionType: 'CE' | 'PE',
  entry: number,
  stop: number | null,
  target: number | null,
  bars: Pick<StoredFyersBar, 'bucketTs' | 'high' | 'low' | 'close'>[],
  sinceSec: number,
  expectedLastBucketSec?: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rule of PROTECT_PRESETS) {
    const g = simulateProtected(optionType, entry, stop, target, bars, sinceSec, rule, expectedLastBucketSec);
    if (g && g.outcomeR != null) out[rule.name] = g.outcomeR;
  }
  return out;
}
