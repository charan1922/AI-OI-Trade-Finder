/**
 * Dhan option-chain evidence — the shapes describing what the OPTIONS are doing.
 *
 * Extracted from the retired lib/r-factor-v2 module (2026-08-11). The R-Factor
 * V2 scoring experiment it used to live inside was deleted; this read survived
 * because it is independently useful and is what /live and the commentary
 * narration actually consume. Nothing here scores or gates a trade — see
 * scripts/measure-option-evidence.ts for why (measured, no predictive edge).
 */

export type OptionDirection = 'bullish' | 'bearish' | 'neutral';

/**
 * How a "pace" factor's denominator was obtained. Every pace number carries one
 * of these so a reader can tell measured history from a linear estimate. The
 * linear kinds assume activity accrues evenly through the session, which real
 * intraday volume does not (it is U-shaped); they are fallbacks, never claims.
 */
export type PaceBaselineKind =
  | 'same-time-z'
  | 'same-time'
  | 'prior-session-linear'
  | 'linear-fallback'
  | 'missing';

export interface OptionStrikeEvidence {
  strike: number;
  side: 'CE' | 'PE';
  delta: number | null;
  oi: number;
  previousOi: number;
  volume: number;
  previousVolume: number;
  ltp: number;
  /**
   * Session VWAP for this leg. Premium turnover uses this rather than LTP,
   * because LTP × cumulative volume prices the whole day's trades at the last
   * print — badly wrong on a leg that trended hard intraday.
   */
  averagePrice: number;
  previousClose: number;
  iv: number | null;
  bid: number | null;
  ask: number | null;
}

export interface OptionActivityEvidence {
  capturedAt: string;
  expiry: string;
  underlyingLtp: number;
  strikesUsed: number;
  totalStrikes: number;
  activityScore: number;
  directionScore: number;
  direction: OptionDirection;
  directionConfidence: number;
  /**
   * How many option legs actually carried directional evidence (a fresh OI
   * build with a readable premium move). ZERO means the chain said nothing
   * about direction — which is different from it saying "balanced", and the
   * engine skips the option vote entirely rather than casting a neutral one.
   */
  directionEvidenceLegs: number;
  oiPcr: number | null;
  volumePcr: number | null;
  premiumValuePcr: number | null;
  /** PCR over delta-weighted OI: a 0.15-delta wing counts far less than an ATM
   *  strike, so a wall of cheap far OI cannot masquerade as conviction. */
  moneynessWeightedOiPcr: number | null;
  premiumTurnoverPace: number | null;
  paceBaselineKind: PaceBaselineKind;
  /** Raw traded premium value and contract volume behind the pace, retained so
   *  later sessions can build a same-clock baseline instead of a linear one. */
  premiumValue: number;
  optionVolume: number;
  callOiChangePct: number | null;
  putOiChangePct: number | null;

  // ── Gamma evidence (RECORDED, NOT SCORED) ─────────────────────────────────
  // Public OI plus a model gamma cannot reveal who is long or short, so none of
  // this is dealer positioning and none of it predicts a range or a breakout.
  // It is retained so the evaluation harness can test whether proximity to a
  // gamma concentration relates to a breakout running or stalling. Until that
  // is measured on unseen sessions, it contributes nothing to activity,
  // direction, or any trading decision.
  /** Scale-free call-minus-put OI-weighted gamma balance, in percentage points. */
  gammaNetSharePct: number | null;
  /** Strike holding the largest absolute net gamma contribution. */
  gammaConcentrationStrike: number | null;
  /** Spot's distance to that strike, in percent (signed: positive = above spot). */
  gammaConcentrationDistancePct: number | null;
  /** Total OI-weighted gamma across near-money legs — sign-convention free. */
  grossGamma: number;

  rows: OptionStrikeEvidence[];
}

