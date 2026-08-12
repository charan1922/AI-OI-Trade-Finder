/**
 * Spot trailing stop — the exit change that replaces the fixed 1:2 target.
 *
 * PURE: no I/O, no clock, no DB. The replay harness and the live position guard
 * both call `trailedSpotStop`, so a backtested exit and a live exit cannot
 * diverge through code drift — the same discipline scoring.ts and grade.ts keep.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The operator's benchmark (TradeFinder, Sensibull-verified, 23 sessions
 * 2026-07-09 → 2026-08-10) makes its money on the exit, not the entry:
 *
 *   every losing day:  −0.14R  −0.98R  −0.94R  −0.84R   (never once past 1R)
 *   winning days:      3.5R … 9.6R
 *   profit factor 40.4,  82.6% winning days,  all exits 15:31–16:02 IST
 *
 * Two rules produce that: one stop ends the day, and winners run to the close.
 * Our engine capped every winner at a fixed 2R target. Measured on TF-race
 * candidates over 2026-08-10..12 at a 1% stop, one entry per name per day, the
 * fixed target capped the best available trade at exactly 2.0R; removing it
 * surfaced a 6.4R winner in the same three sessions (avg +0.700R → +0.840R).
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * Once the trade is `trailR` onside (measured on the FAVOURABLE EXTREME since
 * entry, not the last close), the stop moves to `extreme − trailR × risk` and
 * NEVER loosens. Below that it stays where the scanner plan put it.
 *
 * MONOTONICITY IS THE WHOLE SAFETY PROPERTY. `CLAUDE.md`'s standing rule is that
 * stop moves may only tighten; a trailing stop that could widen on a data
 * hiccup would be a way to quietly increase risk on an open position. Every
 * return value here is clamped against the current stop, so a stale/absent
 * extreme is incapable of loosening anything.
 */

export interface TrailInput {
  direction: 'bullish' | 'bearish';
  /** Spot at entry — the anchor the plan's risk was measured from. */
  entrySpot: number;
  /** Current stop. Returned unchanged whenever trailing would not tighten it. */
  currentStop: number;
  /**
   * Risk in POINTS (entry → original stop). Must be > 0; a non-positive or
   * non-finite risk means the plan is unusable and trailing is skipped rather
   * than guessed at.
   */
  riskPoints: number;
  /**
   * Best spot reached in the trade's favour since entry (high for bullish, low
   * for bearish). Null when no post-entry bar has been recorded yet.
   */
  favourableExtreme: number | null;
  /** How many R of open profit to give back. Null disables trailing entirely. */
  trailR: number | null;
}

/**
 * The tightened stop, or `currentStop` when trailing does not apply.
 *
 * Returns `currentStop` (never null, never a wider level) when: trailing is
 * disabled, the plan risk is unusable, no extreme has printed yet, the trade
 * has not yet reached `trailR`, or the computed level would be looser than the
 * stop already in force.
 */
export function trailedSpotStop(input: TrailInput): number {
  const { direction, entrySpot, currentStop, riskPoints, favourableExtreme, trailR } = input;
  if (trailR == null || !Number.isFinite(trailR) || trailR <= 0) return currentStop;
  if (!Number.isFinite(riskPoints) || riskPoints <= 0) return currentStop;
  if (favourableExtreme == null || !Number.isFinite(favourableExtreme)) return currentStop;
  if (!Number.isFinite(entrySpot) || !Number.isFinite(currentStop)) return currentStop;

  const bullish = direction === 'bullish';
  // How far the trade has gone our way, in R, at its best.
  const mfeR = (bullish ? favourableExtreme - entrySpot : entrySpot - favourableExtreme) / riskPoints;
  if (!(mfeR >= trailR)) return currentStop;

  const trailed = bullish
    ? favourableExtreme - trailR * riskPoints
    : favourableExtreme + trailR * riskPoints;

  // TIGHTEN-ONLY. This clamp is the safety property, not an optimisation.
  return bullish ? Math.max(currentStop, trailed) : Math.min(currentStop, trailed);
}

/** True when `next` is strictly tighter than `current` for this direction —
 *  the test the caller uses before writing a stop change to the DB. */
export function isTighterStop(direction: 'bullish' | 'bearish', current: number, next: number): boolean {
  return direction === 'bullish' ? next > current : next < current;
}
