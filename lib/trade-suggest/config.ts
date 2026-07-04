/**
 * /trade-suggest strategy constants — every tunable in one place.
 *
 * Grounding (see .claude/skills/trade-suggest/SKILL.md for the full story):
 * - TradeFinder's real tickets (data/tradefinder_platform_trades.json): near-ATM
 *   stock options, entries cluster 10:00–10:40, current-month expiry.
 * - Documented TF-pick fingerprint: futures OI ≈1.25–1.35× the 20-day average
 *   (gate at 1.1×), turnover ≥1.2× average, futures direction agreeing with the
 *   option side, entries only after the 9:45 opening range is set.
 * - Standard intraday conventions: near-ATM for momentum buying (delta ~0.5,
 *   best liquidity); opening-range breakout with last-candle/range SL; 1:2 R:R.
 */

/** Suggestion window (IST minutes from midnight): 09:40 – 11:00. */
export const WINDOW_START_MIN = 9 * 60 + 40;
export const WINDOW_END_MIN = 11 * 60;
export const WINDOW_LABEL = { opensAt: '09:40 IST', closesAt: '11:00 IST' };

/** Hard gates — a candidate must clear ALL of these. */
export const MIN_RFACTOR = 3.6; // 1–8 scale (was 2.5 on 1–5; same raw cutoff 0.375)
export const MIN_CONFIDENCE = 0.2; // directional-factor agreement [0,1]
export const MIN_OI_LEVEL = 1.1; // futures OI ÷ 20d avg — the TF minimum fingerprint
/**
 * Alternate OI-evidence path: NSE's combined (futures + options) OI change.
 * Options-led builds don't register in futures-only OI level — seen live
 * 2026-07-03: SUNPHARMA futures 0.90× avg but NSE combined +8.1%, and TF's
 * winning trade that day was the SUNPHARMA 1920 CE. The gate passes on
 * EITHER futures level ≥ MIN_OI_LEVEL OR NSE combined ≥ this %.
 */
export const MIN_NSE_OI_PCT = 5;
export const MAX_SPREAD_PCT = 0.3; // execution-cost ceiling (matches setup-score)
/**
 * Third TF pillar: turnover ≥ 1.2× its (time-adjusted) 20-day average.
 * The R-Factor turnover score is clamp((ratio−1)/2, 0, 1), so 1.2× ⇔ 0.1 —
 * gating on the factor score applies the pillar without re-deriving the ratio.
 */
export const MIN_TURNOVER_SCORE = 0.1;

/** Premium-based max-loss backstop: exit if the option loses this % of premium
 *  (Indian option-buying convention is 40–50%; the SPOT SL remains the primary,
 *  signal-based exit). */
export const PREMIUM_SL_PCT = 40;
/** TF-style profit objective per lot (₹) — translated to a premium target. */
export const TF_LOT_TARGET_RUPEES = 5000;
/** Option-liquidity warnings: bid-ask spread of the OPTION itself above this %
 *  of mid, or zero traded volume, flags the contract as hard to execute. */
export const MAX_OPT_SPREAD_PCT = 2;

/** Composite score weights (sum 1.0) — applied to normalized [0,1] components.
 *  Price action / opening-range breakout raised to co-lead 2026-07-03 (user
 *  directive: "price action and breakout are crucial"; the day's one TF winner,
 *  SUNPHARMA, was an OR breakout while both non-breakout picks stopped out). */
export const WEIGHTS = {
  rFactor: 0.22,
  confidence: 0.08,
  oiUrgency: 0.18,
  oiLevel: 0.12,
  orBreakout: 0.2,
  imbalanceAlign: 0.07,
  sectorBreadth: 0.08,
  setupStrong: 0.05,
} as const;

/** Max picks per run — the user asked for at most 3. */
export const MAX_PICKS = 3;

/** The user's F&O capital (₹). A pick whose single lot costs more than this is
 *  skipped in favor of the next qualified candidate — suggestions must be
 *  tradeable for THIS account, not in theory. */
export const CAPITAL_BUDGET = 60_000;
/** How many extra ranked survivors to premium-quote as affordability fallbacks. */
export const PICK_OVERSAMPLE = 3;

/** Skip contracts expiring within this many days (theta burn near expiry). */
export const MIN_DTE = 3;

/** Reward:risk multiple for the spot target (entry ± N × risk). */
export const TARGET_RR = 2;

/** Minimum stop distance as % of entry. A last-5-min-candle SL can be
 *  degenerately tight when that bar is small (seen live: MARICO risk of
 *  0.05 pts on an ₹842 stock) — a stop inside normal 5-min noise is a
 *  guaranteed stop-out, not a plan. Structural SLs tighter than this floor
 *  are widened to it (slBasis: 'floor'). */
export const MIN_RISK_PCT = 0.35;
/** Volatility floor: risk floor becomes max(MIN_RISK_PCT%, SL_ATR_MULT × ATR14
 *  of the 5-min series). 0 = % floor only. Set from the replay benchmark
 *  (scripts/replay-window.ts) — change ONLY with fresh replay evidence. */
export const SL_ATR_MULT = 0;

/** Score multiplier for 'extended' movers (setupScore flags |chg from open|
 *  ≥3%) — the soft-penalty path, active only when EXCLUDE_EXTENDED is off. */
export const EXTENDED_SCORE_MULT = 0.6;
/** Hard-skip extended movers at pick time. Evidence: extended picks are
 *  0-for-5 (live 2026-07-03: MUTHOOTFIN/POLICYBZR/MARICO all stopped; replay
 *  benchmark same day: banning was the ONLY variant that improved ΣR, +1.00
 *  vs 0.00). Revisit if a recorded day shows extended continuation working —
 *  flip to false to fall back to the ×0.6 penalty. */
export const EXCLUDE_EXTENDED = true;

/** Candidate pool = exactly what the /nse/movers page surfaces (the user's
 *  primary hunting ground): OI spurts, F&O gainers/losers, most active by
 *  value and by volume. All F&O-gated server-side. */
export const CANDIDATE_SOURCES = [
  'nse-oi',
  'nse-gainers',
  'nse-losers',
  'nse-active-value',
  'nse-active-volume',
] as const;
