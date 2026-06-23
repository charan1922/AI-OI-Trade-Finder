/**
 * R-Factor library — pure math primitives.
 *
 * No imports, no state. These are the normalization building blocks every factor
 * uses to turn raw market numbers into a comparable [0,1] strength score.
 */

/** Constrain `v` to [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Round to `dp` decimal places (default 2). */
export function round(v: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** True for a usable, finite, positive number. */
export function isPos(v: number | undefined | null): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** a / b with a fallback when b is 0 / invalid. */
export function safeDiv(a: number, b: number, fallback = 0): number {
  return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : fallback;
}

/** Signed percentage change from `prev` to `curr`. 0 when prev is non-positive. */
export function pctChange(curr: number, prev: number): number {
  if (!isPos(prev)) return 0;
  return ((curr - prev) / prev) * 100;
}

/**
 * Map a "× of baseline" ratio to a [0,1] score. ratio = value / baseline.
 * At/below the baseline → 0; at (1 + capExcess)× → 1 (e.g. capExcess=2 ⇒ 3× = max).
 */
export function scoreFromRatio(value: number, baseline: number, capExcess: number): number {
  if (!isPos(baseline) || !Number.isFinite(value)) return 0;
  const excess = value / baseline - 1;
  return clamp(excess / capExcess, 0, 1);
}

/**
 * Map a magnitude to [0,1] by a soft cap: |value| reaches `cap` ⇒ 1.
 * Used for things like |OI change %| where there's no clean baseline ratio.
 */
export function scoreFromMagnitude(value: number, cap: number): number {
  if (!isPos(cap) || !Number.isFinite(value)) return 0;
  return clamp(Math.abs(value) / cap, 0, 1);
}

/** Sign of a change with a dead-band, in % terms: 'up' | 'down' | 'flat'. */
export function direction(changePct: number, deadbandPct: number): 'up' | 'down' | 'flat' {
  if (!Number.isFinite(changePct) || Math.abs(changePct) < deadbandPct) return 'flat';
  return changePct > 0 ? 'up' : 'down';
}
