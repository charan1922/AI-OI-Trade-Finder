/**
 * Pure helpers for the quant SHADOW report — kept out of the report SCRIPT so
 * they can be unit-tested without opening a DB or running the CLI (AT-review
 * 2026-07-20, finding 6). No I/O, no clocks.
 */

/** Late-chase bucket for the change-from-open at entry. A MISSING metric
 *  (stale-at-fill spot → null) is its OWN bucket, never silently folded into
 *  "small": `Math.abs(x ?? 0)` used to classify a null as 0% (a calm early
 *  entry), biasing the safe bucket. */
export type ChgOpenBucket = 'missing' | 'small' | 'mid' | 'extended';

/** thresholds in absolute % from the day's open (see quant-shadow-report). */
export const CHG_OPEN_SMALL_MAX = 1.5;
export const CHG_OPEN_MID_MAX = 3;

export function chgOpenBucket(chgOpenPct: number | null | undefined): ChgOpenBucket {
  if (chgOpenPct == null || !Number.isFinite(chgOpenPct)) return 'missing';
  const a = Math.abs(chgOpenPct);
  if (a < CHG_OPEN_SMALL_MAX) return 'small';
  if (a < CHG_OPEN_MID_MAX) return 'mid';
  return 'extended';
}
