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
 *
 * THEORETICAL STOP-LEVEL FILLS (PR#5 review #2): when a stop is crossed we credit
 * the exact stop level — the SAME assumption grade.ts makes for its baseline −1R
 * stop. It ignores intrabar gap-through slippage (a candle that OPENS beyond the
 * stop would really fill at the open, worse than the level). This is deliberate:
 * modelling gaps on the protection side ALONE would bias the ΔR against
 * protection, since the baseline it's compared to also fills at its level. Gap
 * slippage hits both sides comparably, so it largely cancels in the ΔR. The
 * per-rule numbers are therefore a THEORETICAL (level-fill) expectancy, matched
 * to the baseline — a decision metric, not a promise of live fills. If gap
 * realism is ever wanted, it must be added to grade.ts too, symmetrically.
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
  /** THEORETICAL (level-fill) R vs the plan's own initial risk — assumes the
   *  exit fills at the stop level, same as grade.ts's baseline (gap slippage
   *  ignored on both sides; see header). null for the unresolvable outcomes
   *  (entry-ambiguous / incomplete), exactly like grade.ts. */
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

  // Entry-candle blind spot + missing entry period — mirror grade.ts, PLUS this
  // rule's own TRIGGER. A mid-candle suggestion whose entry candle touched the
  // original stop/target OR reached this rule's profit trigger is unresolvable:
  // we can't tell if the trigger (which ARMS the stop move) fired before or after
  // the fill. Without the trigger check the entry candle's spike is silently
  // dropped (mfePrior starts at 0) and the rule is scored pessimistically as
  // never-armed — biasing ΔR downward (PR#5 review #1). Per-rule, so a stricter
  // rule (e.g. breakeven@1.5R) can still resolve when a 1R trigger was ambiguous.
  const touchesInitStop = (b: { high: number; low: number }) => (bull ? b.low <= stop : b.high >= stop);
  const touchesTarget = (b: { high: number; low: number }) => (bull ? b.high >= target : b.low <= target);
  if (midCandle && entryBar && (touchesInitStop(entryBar) || touchesTarget(entryBar) || favExc(entryBar) >= rule.triggerR)) {
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

/** Parse a persisted protectShadow JSON blob → { ruleName: R }. Never throws;
 *  drops any non-numeric entry. Shared by store.ts and the report so the parse
 *  is defined once and unit-testable. */
export function parseProtectBlob(v: unknown): Record<string, number> {
  try {
    const parsed = JSON.parse(String(v ?? '{}'));
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(parsed)) if (typeof val === 'number' && Number.isFinite(val)) out[k] = val;
    return out;
  } catch {
    return {};
  }
}

/** One resolved pick's inputs to the aggregation: its baseline R + parsed blob. */
export interface ProtectAggRow {
  baseR: number;
  blob: Record<string, number>;
}

export interface ProtectRuleStat {
  name: string;
  /** Rows this rule was scored over — its blob carried a finite R for the rule.
   *  Per-rule (a rule that was entry-ambiguous on some rows has a smaller n). */
  n: number;
  /** Mean counterfactual R under the rule (theoretical level-fill). */
  avgR: number | null;
  /** Mean BASELINE R over the SAME n rows — apples-to-apples. */
  baselineAvgR: number | null;
  /** avgR − baselineAvgR: positive = the rule improved expectancy. */
  deltaR: number | null;
  /** Rows the rule rescued: baseline was a −1R stop, the rule exited ≥ 0R. */
  savedStops: number;
  /** Rows the rule made WORSE than baseline (the honest cost side). */
  hurt: number;
}

export interface ProtectAggregate {
  /** Resolved rows carrying any protection blob (the overall denominator). */
  n: number;
  /** Mean baseline R over those rows — the bar every rule must beat. */
  baselineAvgR: number | null;
  rules: ProtectRuleStat[];
}

const mean = (v: number[]): number | null =>
  v.length === 0 ? null : Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100;

/**
 * PURE aggregation of the profit-protection shadow (PR#5 review #4): given the
 * resolved rows' baseline R + parsed blobs, compare each rule against the
 * baseline over the SAME paired rows. No DB — store.getProtectionStats() just
 * loads the rows and calls this, so the savedStops/hurt/ΔR math is unit-testable.
 */
export function aggregateProtection(rows: ProtectAggRow[], rules: ProtectRule[] = PROTECT_PRESETS): ProtectAggregate {
  const usable = rows.filter((r) => Number.isFinite(r.baseR));
  const ruleStats = rules.map<ProtectRuleStat>((rule) => {
    const paired = usable.filter((r) => Number.isFinite(r.blob[rule.name]));
    const avgR = mean(paired.map((r) => r.blob[rule.name]));
    const baselineAvgR = mean(paired.map((r) => r.baseR));
    return {
      name: rule.name,
      n: paired.length,
      avgR,
      baselineAvgR,
      deltaR: avgR != null && baselineAvgR != null ? Math.round((avgR - baselineAvgR) * 100) / 100 : null,
      savedStops: paired.filter((r) => r.baseR <= -1 && r.blob[rule.name] >= 0).length,
      hurt: paired.filter((r) => r.blob[rule.name] < r.baseR).length,
    };
  });
  return { n: usable.length, baselineAvgR: mean(usable.map((r) => r.baseR)), rules: ruleStats };
}
