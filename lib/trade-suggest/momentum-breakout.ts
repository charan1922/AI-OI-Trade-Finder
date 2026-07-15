/**
 * Momentum-breakout — a FOURTH entry path for pure price-momentum movers that
 * carry NO accumulation evidence at all.
 *
 * WHY THIS EXISTS
 * ---------------
 * The engine is accumulation-based: R-Factor, confidence, OI level, NSE
 * combined OI and the setup verdict all measure fresh POSITIONING. A
 * short-covering breakout (price rising while OI falls) scores near-zero on
 * every one of them BY DESIGN — the documented case is ADANIGREEN 2026-07-14:
 * tick-by-tick replay showed R 1.7–2.3 (gate 3.6), confidence 0% (gate 0.2),
 * futures OI 0.97–0.99× (gate 1.1×), NSE combined ~+1% (gate 5%), setup
 * "quiet" — five independent blocks — while price held a confirmed multi-level
 * breakout the whole entry window. TradeFinder rode it for +₹15,930. The
 * existing breakout-bypass can't help: it sits behind the R-Factor gate and
 * itself demands R ≥ 3.6, which a low-R momentum name never reaches.
 *
 * This path therefore bypasses the R-Factor, confidence, OI and quiet-setup
 * gates — and precisely BECAUSE all that evidence is absent, it demands the
 * strictest price picture we can ask for:
 *   • a CONFIRMED opening-range breakout in the trade direction, AND
 *   • BOTH Supertrend and VWAP agreeing (no null-tolerance — the OI-gate
 *     bypass accepts VWAP alone when Supertrend isn't computable; here an
 *     unknown trend means no entry), AND
 *   • a real move behind it (≥ minChangePct from open, in the direction) —
 *     a poke above the OR with no follow-through doesn't count.
 * The spread (illiquid), turnover, price-direction and Supertrend/VWAP hard
 * gates still apply to these candidates like any other.
 *
 * PURE (no imports) so it can be unit-tested and driven by the replay harness.
 * Opt-in via USE_MOMENTUM_BREAKOUT in config.ts — off until the replay shows,
 * across several recorded days, that it catches the ADANIGREEN class without
 * admitting fakeout junk.
 */

export interface MomentumBreakoutInput {
  /** Confirmed opening-range breakout in the trade direction (CE→above OR high, PE→below OR low). */
  orBreakout: boolean;
  /** Supertrend(10,3) agrees with the trade direction; null when not yet computable. */
  supertrendAligned: boolean | null;
  /** Price on the favorable side of session VWAP; null when VWAP not computable. */
  vwapAligned: boolean | null;
  /** Move since the day's open (%), signed. */
  changePctOpen: number | null;
  /** The trade direction the breakout was evaluated against. */
  direction: 'bullish' | 'bearish';
}

export interface MomentumBreakoutConfig {
  /** Minimum |move from open| (%) in the trade direction. */
  minChangePct: number;
}

export const DEFAULT_MOMENTUM_BREAKOUT_CONFIG: MomentumBreakoutConfig = {
  minChangePct: 1.5,
};

/**
 * True when a candidate with NO accumulation evidence (low R-Factor, no OI
 * build, quiet setup) should still enter on the strength of a confirmed,
 * fully trend-aligned breakout with a real move behind it.
 */
export function qualifiesMomentumBreakout(
  i: MomentumBreakoutInput,
  cfg: MomentumBreakoutConfig = DEFAULT_MOMENTUM_BREAKOUT_CONFIG
): boolean {
  if (!i.orBreakout) return false;
  // BOTH trend indicators must be computable AND agree — with every
  // accumulation gate bypassed, trend agreement is the only junk filter left.
  if (i.supertrendAligned !== true || i.vwapAligned !== true) return false;
  const chg = i.changePctOpen;
  if (chg == null) return false;
  return i.direction === 'bullish' ? chg >= cfg.minChangePct : chg <= -cfg.minChangePct;
}
