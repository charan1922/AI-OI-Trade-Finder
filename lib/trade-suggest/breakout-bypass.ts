/**
 * Breakout-bypass — a THIRD OI-gate path for pure price/base-breakout movers.
 *
 * WHY THIS EXISTS
 * ---------------
 * The OI-evidence gate (futures OI ≥ 1.1× its 20-day avg OR NSE combined
 * fut+opt OI ≥ 5%) blocks a whole class of real winners: names that break out
 * on PRICE with no OI build yet. Two documented cases —
 *   • ADANIENSOL 2026-07-06: multi-day base breakout, +₹13,635 (TF took it),
 *     futures OI 1.02×, NSE combined only +0.6→4% inside the window.
 *   • NAUKRI 2026-07-07: confirmed opening-range breakout, +6.92% / +2R in the
 *     replay, yet futures OI 1.07× and NSE combined −0.2% — zero OI evidence.
 * Both cleared every gate EXCEPT the OI one, so the engine never suggested them.
 *
 * The fix: let a candidate clear the OI gate when it shows a CONFIRMED
 * opening-range breakout in the trade direction, WITH trend agreement, AND an
 * above-normal R-Factor. We demand MORE on price here precisely because the OI
 * leg is absent — the bypass must not become a back door for weak names (e.g.
 * EXIDEIND 2026-07-07: no OI, no breakout, −1R). This module is the predicate;
 * the caller supplies the already-derived breakout/trend booleans.
 *
 * Historical replay predicate only. The live TF-only engine has no breakout
 * bypass toggle or OI admission gate; this remains for point-in-time research.
 */

import { rFactorAtRaw } from '@/lib/r-factor/scale';

export interface BreakoutBypassInput {
  /** Confirmed opening-range breakout in the trade direction (CE→above OR high, PE→below OR low). */
  orBreakout: boolean;
  /** Supertrend(10,3) agrees with the trade direction; null when not yet computable. */
  supertrendAligned: boolean | null;
  /** Price on the favorable side of session VWAP; null when VWAP not computable. */
  vwapAligned: boolean | null;
  /** R-Factor at this tick (1–10 scale). */
  rFactor: number | null;
}

export interface BreakoutBypassConfig {
  /** Minimum R-Factor to bypass the OI gate — higher than the base 3.6 gate,
   *  since we're dropping the OI-evidence requirement. */
  minRFactor: number;
  /** Require trend agreement (Supertrend, or VWAP side when Supertrend isn't
   *  computable yet). A breakout fighting the trend is the misaligned profile
   *  that went 0/3 on the benchmark. */
  requireTrendAlign: boolean;
}

export const DEFAULT_BREAKOUT_BYPASS_CONFIG: BreakoutBypassConfig = {
  minRFactor: rFactorAtRaw(0.375), // = base MIN_RFACTOR; breakout+trend is the discriminator
  requireTrendAlign: true,
};

/**
 * True when a candidate with NO OI evidence should still clear the OI gate on
 * the strength of a confirmed, trend-aligned, high-conviction breakout.
 */
export function qualifiesByBreakout(
  i: BreakoutBypassInput,
  cfg: BreakoutBypassConfig = DEFAULT_BREAKOUT_BYPASS_CONFIG,
): boolean {
  if (!i.orBreakout) return false;
  if ((i.rFactor ?? 0) < cfg.minRFactor) return false;
  if (cfg.requireTrendAlign) {
    // Supertrend wins when available; before it has enough bars, fall back to
    // the VWAP side. Unknown-and-no-fallback = not aligned = no bypass.
    const trendOk = i.supertrendAligned === true || (i.supertrendAligned == null && i.vwapAligned === true);
    if (!trendOk) return false;
  }
  return true;
}
