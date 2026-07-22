export type RFactorV2Direction = 'bullish' | 'bearish' | 'neutral';

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
  direction: RFactorV2Direction;
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

export interface RFactorV2Input {
  symbol: string;
  sector: string | null;
  priceChangePct: number | null;
  rangeRatio: number | null;
  /** Same-clock cumulative futures turnover / prior-session same-clock mean. */
  turnoverPace: number | null;
  /**
   * Per-stock z-score of today's same-clock turnover against that stock's own
   * prior-session spread. This is the "2x in a quiet name is not the same as 2x
   * in a violent name" correction; null until the stock has enough sessions.
   */
  turnoverZ: number | null;
  turnoverBaselineKind: PaceBaselineKind;
  oiLevel: number | null;
  futuresOiChangePct: number | null;
  oiVelocity: number | null;
  nseCombinedOiChangePct: number | null;
  nseOiSlope30m: number | null;
  /** NSE option-premium value / prior-session same-clock mean. */
  nsePremiumPace: number | null;
  spreadPct: number | null;
  imbalance: number | null;
  option: OptionActivityEvidence | null;
}

export interface RFactorV2Factor {
  key: string;
  label: string;
  score: number;
  weight: number;
  available: boolean;
  detail: string;
}

export interface RFactorV2Result {
  activityScore: number;
  rawActivity: number;
  /**
   * Activity over the factors EVERY name can supply (option evidence excluded).
   * Ranking uses this, not `rawActivity`: option chains are fetched only for
   * names already leading, so ranking on a score they alone can earn would let
   * today's leaders re-select themselves tomorrow.
   */
  comparableActivity: number;
  activityPercentile: number;
  activityRank: number;
  universeSize: number;
  direction: RFactorV2Direction;
  directionScore: number;
  directionConfidence: number;
  coverage: number;
  /** Coverage over the always-available factors only — what ranking relies on. */
  comparableCoverage: number;
  optionStatus: 'available' | 'pending';
  factors: RFactorV2Factor[];
}
