/**
 * R-Factor library — shared types.
 *
 * This is a self-contained, dependency-free library: every function takes plain
 * numbers in and returns plain data out. It does NOT read Dhan, Prisma, NSE, or
 * anything else — the caller supplies the market data. That keeps it reusable and
 * trivially unit-testable, independent of the rest of the app.
 */

/** A single factor's directional opinion. */
export type Vote = 'buy' | 'sell' | 'neutral';

/** Stable id for each factor — also the key into RFactorWeights. */
export type FactorKey =
  | 'smartMoney'
  | 'futuresOi'
  | 'oiLevel'
  | 'oiDirection'
  | 'callOi'
  | 'putOi'
  | 'pcr'
  | 'turnover'
  | 'volume'
  | 'bidAskSpread'
  | 'breakout';

/**
 * The output shape of every factor function: a normalized magnitude in [0,1]
 * (how strong/notable this factor is — NOT its direction), a directional vote,
 * and an `available` flag so the engine can renormalize when inputs are missing
 * (a missing factor contributes nothing instead of dragging the score to zero).
 */
export interface FactorScore {
  key: FactorKey;
  label: string;
  /** Strength of this factor in [0,1]. Direction lives in `vote`, not here. */
  score: number;
  vote: Vote;
  /** False when the required inputs were missing/invalid — excluded from the blend. */
  available: boolean;
  /** Plain-English explanation of the numbers used (for UI / debugging). */
  detail: string;
}

/**
 * Everything a full R-Factor computation can use for one symbol. Fields are
 * optional where a data source may be absent (e.g. option OI); the relevant
 * factor then reports `available: false` and is dropped from the blend.
 */
export interface RFactorInput {
  symbol: string;

  // ── Price (underlying or futures) — drives direction & breakout ──
  /** Last traded price. */
  ltp: number;
  /** Signed % price move for the session (vs previous close or day open). */
  priceChangePct: number;
  /** Breakout reference levels — e.g. prior-day high/low or the opening range. */
  breakoutHigh?: number;
  breakoutLow?: number;

  // ── Futures open interest ──
  /** Current futures OI. */
  futOi?: number;
  /** Previous session's futures OI (for the daily OI change). */
  futOiPrev?: number;
  /** Trailing 20-session average futures OI (for the sustained OI level). */
  futOi20dAvg?: number;

  // ── Turnover & volume (with 20-session baselines) ──
  turnover?: number;
  turnover20dAvg?: number;
  volume?: number;
  volume20dAvg?: number;

  // ── Options open interest ──
  callOi?: number;
  callOiPrev?: number;
  putOi?: number;
  putOiPrev?: number;

  // ── Microstructure ──
  bid?: number;
  ask?: number;

  // ── Timing ──
  /** Current timestamp; converted to IST internally for the entry-time gate. */
  now: Date;
  /** Entry window start in IST "HH:MM" (TradeFinder reads after 9:45). Default '09:45'. */
  entryTimeIST?: string;
}

/** Blend weights per factor — must be non-negative; the engine renormalizes. */
export type RFactorWeights = Record<FactorKey, number>;

/** Full result of computeRFactor(). */
export interface RFactorResult {
  symbol: string;
  /** Strength on a TradeFinder-like 1.0–5.0 scale (1 = quiet, 5 = very strong). */
  rFactor: number;
  /** Weighted strength in [0,1] before scaling — the raw blend over available factors. */
  rawScore: number;
  /** Net directional read from the voting factors. */
  bias: Vote;
  /** Agreement among directional factors, [0,1]. */
  confidence: number;
  /** True once IST time ≥ entry window AND the market is open. */
  afterEntryWindow: boolean;
  marketOpen: boolean;
  /** Per-factor breakdown, in display order. */
  factors: FactorScore[];
  /** Gating / missing-data caveats. */
  notes: string[];
}
