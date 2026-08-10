/**
 * Extended-trend bypass — lets a genuine TREND-day continuation re-qualify even
 * after it has run ≥3% from the open, which EXCLUDE_EXTENDED otherwise hard-gates.
 *
 * WHY THIS EXISTS
 * ---------------
 * EXCLUDE_EXTENDED bans every name ≥3% from open on 0-for-5 evidence: chasing a
 * spent morning spike lost every time (live 2026-07-03: MUTHOOTFIN / POLICYBZR /
 * MARICO all stopped). But that same ban throws away gap-and-go TREND days that
 * keep running:
 *   • KALYANKJIL 2026-07-09: gapped open +4.5%, trended to +17.5% with sub-2.2%
 *     pullbacks after the opening bar — the single biggest move on the board, and
 *     the engine refused it on all 91 scans because it was never < 3% from open.
 *
 * The discriminator between "trend continuation" and "spent spike" is standard
 * intraday structure, encoded by three booleans the caller supplies as-of the tick:
 *   • orBreakout        — price is STILL making new session extremes in the trade
 *                         direction (a fade stops printing new highs/lows).
 *   • vwapAligned       — price holds the favorable side of session VWAP (the
 *                         classic trend-day filter; a fade loses VWAP). MANDATORY.
 *   • supertrendAligned — Supertrend(10,3) agrees. Requiring it be actually TRUE
 *                         (not merely "not-yet-computable") also excludes the first
 *                         ~1h of raw-spike noise before the trend has proven itself.
 *
 * The known 0-for-5 losers reversed — they lost VWAP and/or Supertrend — so this
 * predicate still rejects them. PURE (no imports) so it is unit-testable and the
 * replay harness can A/B it across historical days. Opt-in via
 * USE_EXTENDED_TREND_BYPASS in config.ts — OFF until replay + Trade-Log evidence
 * shows it earns its place.
 */

export interface ExtendedTrendInput {
  /** Confirmed opening-range breakout in the trade direction (still extending). */
  orBreakout: boolean;
  /** Supertrend(10,3) agrees with the trade direction; null when not yet computable. */
  supertrendAligned: boolean | null;
  /** Price on the favorable side of session VWAP; null when VWAP not computable. */
  vwapAligned: boolean | null;
  /** R-Factor at this tick (1–10 scale). These names already cleared the base gate. */
  rFactor: number | null;
}

export interface ExtendedTrendConfig {
  /** Minimum R-Factor to bypass the extended ban. Defaults to the base gate value
   *  (extended survivors already passed it); raise to demand more conviction. */
  minRFactor: number;
  /** When true, Supertrend must be actively aligned (=== true), which also gates
   *  out the early-session spike minutes before Supertrend has enough bars. When
   *  false, a null (not-yet-computable) Supertrend is tolerated and VWAP carries
   *  the trend test alone (a disagreeing Supertrend still rejects, either way). */
  requireSupertrend: boolean;
}

/**
 * True when an EXTENDED name (≥3% from open) shows trend-CONTINUATION structure
 * strong enough to re-qualify past EXCLUDE_EXTENDED. Conservative by design: any
 * one failing leg — no new extreme, price back through VWAP, or Supertrend
 * disagreeing — rejects it. That is precisely the spent-spike profile that went
 * 0-for-5, so the guard the ban was built for is preserved.
 */
export function qualifiesExtendedTrend(i: ExtendedTrendInput, cfg: ExtendedTrendConfig): boolean {
  // Must still be extending in the trade direction — a fade stops making new extremes.
  if (!i.orBreakout) return false;
  // Conviction floor (survivors already passed the base R gate; this can raise it).
  if ((i.rFactor ?? 0) < cfg.minRFactor) return false;
  // MANDATORY: price on the favorable side of VWAP — the trend-day filter. A name
  // that has fallen back through VWAP is a spent spike, not a continuation.
  if (i.vwapAligned !== true) return false;
  // Supertrend must never DISAGREE. requireSupertrend additionally demands it be
  // computed and aligned (=== true), excluding the earliest, riskiest spike minutes.
  if (cfg.requireSupertrend) {
    if (i.supertrendAligned !== true) return false;
  } else if (i.supertrendAligned === false) {
    return false;
  }
  return true;
}
