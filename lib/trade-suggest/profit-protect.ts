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

/** Outcome under a protection rule. 'protected' = the exit was governed by the
 *  moved-up stop AFTER the trigger armed — usually the ratcheted breakeven/locked
 *  level, but the OBSERVABLE CLOSE when the arming candle already closed beyond
 *  that level (so R can be < 0 there). 'stop' = the ORIGINAL -1R stop hit before
 *  the trigger; the rest mirror grade.ts. */
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

/** Simulator version, stamped into each persisted blob as `_v` (PR#6 review).
 *  Bump whenever the simulator's math changes meaning so a report can tell rows
 *  graded by different versions apart (rule NAMES alone are ambiguous across
 *  versions). v2 = PR#6: entry-candle trigger ambiguity, stop-can't-rest-above-
 *  close, price-based target detection. */
export const PROTECT_MODEL_VERSION = 2;

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
    // Detect target by the stored PRICE (same predicate as grade.ts), NOT by
    // `favExc >= plannedRR`: plannedRR is rounded, so a candle touching the exact
    // target price can fail the R comparison (1.989… >= 1.99 is false) and
    // disagree with the baseline grader on decimal plans (PR#6 review). Report
    // plannedRR as the R, exactly like grade.ts.
    if (touchesTarget(b)) return { outcome: 'target', outcomeR: plannedRR };

    // Ratchet the stop from THIS bar's favourable excursion, for the NEXT bar.
    mfePrior = Math.max(mfePrior, favExc(b));
    const candidateStopR = Math.max(stopR, ruleStopR(rule, mfePrior)); // tighten-only
    if (candidateStopR > stopR) {
      // The raised stop only becomes active from the NEXT bar (no-lookahead). If
      // THIS bar already CLOSED at/below the raised level, the market is already
      // beyond where the stop would rest — a sell-stop (long) / buy-stop (short)
      // can't sit on the wrong side of price. So the exit is the observable
      // CLOSE, never the unreachable level (crediting the level would assume
      // intra-candle trailing this model explicitly disavows) — PR#6 review.
      const armCloseR = round2((dir * (b.close - entry)) / risk);
      if (armCloseR <= candidateStopR) return { outcome: 'protected', outcomeR: armCloseR };
      stopR = candidateStopR;
    }
  }

  // Neither level hit on a contiguous path. Same truncation guard as grade.ts:
  // a session missing its final candle could hide a late exit → incomplete.
  const lastTs = pathBars[pathBars.length - 1].bucketTs;
  if (expectedLastBucketSec != null && lastTs < expectedLastBucketSec) {
    return { outcome: 'incomplete', outcomeR: null };
  }
  // A fully walked path → timeout at the last close. The `max` is defensive:
  // reaching here means no bar's low hit `stopR`, so the last close is provably
  // ≥ stopR (a stop above the close would have exited in the arming step above),
  // i.e. this resolves to closeR — never a floor above the close (PR#6 review).
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
  const out: Record<string, number> = { _v: PROTECT_MODEL_VERSION };
  for (const rule of PROTECT_PRESETS) {
    const g = simulateProtected(optionType, entry, stop, target, bars, sinceSec, rule, expectedLastBucketSec);
    if (g && g.outcomeR != null) out[rule.name] = g.outcomeR;
  }
  return out;
}

/** A persisted protectShadow blob, parsed into its model version + rule Rs. */
export interface ParsedProtectBlob {
  /** The `_v` model-version stamp that WROTE this blob, or null for a
   *  pre-versioning (PR#5) blob that carried no `_v`. The aggregator uses this
   *  to REFUSE to average rows written by different simulator versions. */
  version: number | null;
  /** { ruleName: theoretical R } — `_`-prefixed metadata (incl. `_v`) and
   *  non-finite values dropped, so metadata is never mistaken for a rule. */
  rules: Record<string, number>;
}

/** Parse a persisted protectShadow JSON blob → { version, rules }. Never throws.
 *  Reads the `_v` stamp SEPARATELY (so the version isn't lost when metadata is
 *  stripped) and drops any non-numeric entry AND any `_`-prefixed key from the
 *  rules. Shared by store.ts and the report so the parse is defined once and
 *  unit-testable. */
export function parseProtectBlob(v: unknown): ParsedProtectBlob {
  try {
    const parsed = JSON.parse(String(v ?? '{}'));
    if (!parsed || typeof parsed !== 'object') return { version: null, rules: {} };
    const rules: Record<string, number> = {};
    for (const [k, val] of Object.entries(parsed)) {
      if (!k.startsWith('_') && typeof val === 'number' && Number.isFinite(val)) rules[k] = val;
    }
    const rawV = (parsed as Record<string, unknown>)._v;
    const version = typeof rawV === 'number' && Number.isFinite(rawV) ? rawV : null;
    return { version, rules };
  } catch {
    return { version: null, rules: {} };
  }
}

/** One resolved pick's inputs to the aggregation: its baseline R + parsed blob
 *  (version + rule Rs). The version rides along so the aggregator can exclude
 *  rows written by a different simulator version. */
export interface ProtectAggRow {
  baseR: number;
  version: number | null;
  rules: Record<string, number>;
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
  /** The model version these stats are FOR. Only rows whose blob carried this
   *  `_v` are averaged; every other row is excluded (never silently mixed). */
  version: number;
  /** Current-version resolved rows carrying a protection blob (the denominator). */
  n: number;
  /** Mean baseline R over those rows — the bar every rule must beat. */
  baselineAvgR: number | null;
  /** Rows dropped to avoid mixing versions: `legacy` = a pre-`_v` (PR#5) blob;
   *  `otherVersion` = a DIFFERENT `_v` than `version`. Surfaced so a shrinking
   *  denominator is visible, not silent. */
  excludedLegacy: number;
  excludedOtherVersion: number;
  rules: ProtectRuleStat[];
}

const mean = (v: number[]): number | null =>
  v.length === 0 ? null : Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100;

/**
 * PURE aggregation of the profit-protection shadow (PR#5 review #4): given the
 * resolved rows' baseline R + parsed blobs, compare each rule against the
 * baseline over the SAME paired rows. No DB — store.getProtectionStats() just
 * loads the rows and calls this, so the savedStops/hurt/ΔR math is unit-testable.
 *
 * VERSION-ENFORCED (PR#6 review): only rows whose blob carried `_v === version`
 * are averaged. A simulator-math change bumps PROTECT_MODEL_VERSION, so numbers
 * from an OLD version (e.g. a session that aged out of candle retention and can
 * never be regraded) can no longer silently pollute the current stats — they are
 * counted under excludedLegacy / excludedOtherVersion instead. These numbers may
 * one day inform a real-money exit rule, so mixing versions is disallowed.
 */
export function aggregateProtection(
  rows: ProtectAggRow[],
  rules: ProtectRule[] = PROTECT_PRESETS,
  version: number = PROTECT_MODEL_VERSION,
): ProtectAggregate {
  // A row can contribute only if it has a finite baseline R AND at least one rule
  // counterfactual (rules are already `_v`-stripped by parse).
  const hasData = rows.filter((r) => Number.isFinite(r.baseR) && Object.keys(r.rules).length > 0);
  // Of those, only the CURRENT model version is averaged; the rest are excluded
  // (never mixed) and merely COUNTED, so a shrunk denominator is visible.
  const usable = hasData.filter((r) => r.version === version);
  const excludedLegacy = hasData.filter((r) => r.version == null).length;
  const excludedOtherVersion = hasData.filter((r) => r.version != null && r.version !== version).length;
  const ruleStats = rules.map<ProtectRuleStat>((rule) => {
    const paired = usable.filter((r) => Number.isFinite(r.rules[rule.name]));
    return {
      name: rule.name,
      n: paired.length,
      avgR: mean(paired.map((r) => r.rules[rule.name])),
      baselineAvgR: mean(paired.map((r) => r.baseR)),
      // ΔR from the PAIRED per-row differences, rounded ONCE — not the difference
      // of two already-rounded means (double-rounding could shift a ±0.1R signal;
      // PR#6 review). Mathematically the mean of (rule − base) over the same rows.
      deltaR: mean(paired.map((r) => r.rules[rule.name] - r.baseR)),
      savedStops: paired.filter((r) => r.baseR <= -1 && r.rules[rule.name] >= 0).length,
      hurt: paired.filter((r) => r.rules[rule.name] < r.baseR).length,
    };
  });
  return {
    version,
    n: usable.length,
    baselineAvgR: mean(usable.map((r) => r.baseR)),
    excludedLegacy,
    excludedOtherVersion,
    rules: ruleStats,
  };
}
