/**
 * Shared shapes for the /trade-suggest engine (see engine.ts for the flow).
 */

import type { BreakoutSignal } from '@/lib/breakout';
import type { PriorityFeed, PriorityReason, PriorityTier } from '@/lib/priority-refresh/types';
import type { SectorAggregate } from '@/lib/sector/aggregate';

export type OptionSide = 'CE' | 'PE';

/** Live quote of the picked option contract (one extra batched Dhan call). */
export interface OptionPremium {
  /** The resolved premium (₹/share): last traded price, or the bid-ask mid
   *  when the contract has no usable print (see priceSource). */
  ltp: number;
  /** Where ltp came from — 'ltp' = a real trade print, 'mid' = bid-ask mid
   *  (live resting orders; used when no fresh trade exists). */
  priceSource?: 'ltp' | 'mid';
  bid: number | null;
  ask: number | null;
  /** Bid-ask spread of the OPTION as % of mid — its own execution cost. */
  spreadPct: number | null;
  /** Today's traded volume + open interest of this contract (liquidity). */
  volume: number | null;
  oi: number | null;
  /** EXECUTABLE cost of one lot = (ask, else mark) × lotSize — what a market BUY
   *  actually commits. The engine's affordability skip uses this, so it agrees
   *  with auto-trade's ask-based capital gate. `ltp` is the mark, kept separate. */
  perLotCost: number;
  /** Premium stop: ltp × (1 − OPTION_STOP_PCT/100) — sized to the OPTION's own
   *  noise and independent of lot size. The per-lot rupee budget is enforced by
   *  refusing an over-sized contract, not by tightening this. */
  slPremium: number;
  /** Premium level that books ~₹TF_LOT_TARGET_RUPEES on one lot. */
  targetPremium: number;
  /** Non-null when the contract looks hard to execute (wide spread / no volume). */
  liquidityWarning: string | null;
}

/** The resolved near-ATM contract for a pick. */
export interface OptionPlan {
  optionType: OptionSide;
  strike: number;
  expiryDate: string; // YYYY-MM-DD
  lotSize: number;
  optSecurityId: string;
  optSymbol: string;
  /** Null when the option quote wasn't available (off-hours / feed hiccup). */
  premium: OptionPremium | null;
}

export type OptionResolutionStatus =
  | 'selected'
  | 'invalid-request'
  | 'master-stale'
  | 'master-incomplete'
  | 'no-listed-expiry'
  | 'no-eligible-expiry'
  | 'no-strike'
  | 'invalid-master-data'
  | 'query-error';

/** Auditable output from the contract-master boundary. It explains both a
 * successful month roll and a fail-closed non-resolution. */
export interface OptionExpiryResolution {
  status: OptionResolutionStatus;
  selectedExpiry: string | null;
  nearestListedExpiry: string | null;
  rolled: boolean;
  rollReason: 'EXPIRY_WEEK' | null;
  calendarDte: number | null;
  masterSyncDate: string | null;
  detail: string;
}

/** Spot-level trade plan. Premium-level numbers are never fabricated. */
export interface SpotPlan {
  entrySpot: number;
  /** Last completed 5-min candle low (CE) / high (PE); OR boundary fallback;
   *  widened to the MIN_RISK_PCT floor when the structural level is inside noise. */
  slSpot: number | null;
  /** 1:2 reward:risk from entry/SL. Null when SL couldn't be derived. */
  targetSpot: number | null;
  slBasis: 'last-candle' | 'opening-range' | 'floor' | 'none';
}

/** Context factors attached to each pick — DISPLAY EVIDENCE, deliberately not
 *  gates/weights (replay 2026-07-03: tilt/VWAP gates would have blocked the
 *  day's one winner; Supertrend needs more days before it earns weight). */
export interface PickFactors {
  /** Session VWAP and whether the entry is on the favorable side for the trade. */
  vwap: number | null;
  vwapAligned: boolean | null;
  /** Supertrend(10,3) on the 5-min bars + whether it agrees with the direction. */
  supertrend: 'up' | 'down' | null;
  supertrendLine: number | null;
  supertrendAligned: boolean | null;
  /** ATR(14) of the 5-min series, absolute and as % of entry (the noise unit). */
  atr: number | null;
  atrPct: number | null;
  /** Live equity turnover ÷ time-adjusted 20-day average. CAVEAT: assumes
   *  uniform pacing; real volume is U-shaped, so mornings over-read ~2× —
   *  treat ≥3–4× as genuinely elevated. */
  eqTurnoverRatio: number | null;
  /** DERIVED combined (futures+options) OI vs 20-day avg: yesterday's bhavcopy
   *  combined total × (1 + NSE's live combined OI %-change) ÷ 20-day combined
   *  avg. Both inputs are official; the product is labeled derived. */
  combinedOiLevel: number | null;
  /** NSE's combined OI %-change (the oi-spurts feed), verbatim. */
  nseOiPct: number | null;
  /** Change in nseOiPct over the trailing ~30 min (pct-points), from the
   *  per-5-min series the Fyers poller persists — the combined-OI build RATE
   *  (lib/signals/combined-oi-slope.ts). Null when the series is too short. */
  combinedOiSlope30m: number | null;
  /** On NSE's OI build-up list this scan (big-player activity marker). */
  onOiSpurtList: boolean;
  /** The pick's sector: turnover-weighted % move among scanned names (the
   *  heatmap's aggregation — lib/sector/aggregate.ts), advance ratio in [0,1],
   *  and whether the sector's direction agrees with the trade. Aligned is null
   *  when the sector is missing or too flat (<0.1%) to call. Evidence only. */
  sectorPct: number | null;
  sectorAdvanceRatio: number | null;
  sectorAligned: boolean | null;
}

/**
 * Candle-freshness + (later) priority-plan metadata stamped on a suggestion at
 * scan time (see plan §24). Freshness comes from an extra per-symbol point-read.
 * It is best-effort informational metadata that fails closed and is never the
 * source of truth for placement. Priority/sector fields are populated once the
 * priority-refresh planner is wired into the scanner (a later PR); until then
 * they carry safe empties.
 */
export interface SuggestionCandleContext {
  requiredBucketTs: number;
  latestBucketTs: number | null;
  fresh: boolean;

  priorityTier: PriorityTier | null;
  priorityReasons: PriorityReason[];
  feedRanks: Partial<Record<PriorityFeed, number>>;
  sectorPromoted: boolean;
  sectorDirection: 'bullish' | 'bearish' | null;
}

/** One suggestion, fully assembled. */
export interface TradeSuggestion {
  rank: number;
  symbol: string;
  sector: string;
  direction: 'bullish' | 'bearish';
  score: number;
  option: OptionPlan | null; // null if no OPTSTK contract resolved (suggestion still shown)
  /** Structured contract-selection audit. Optional only for legacy fixtures and
   * rows created before the expiry-week policy existed. */
  optionResolution?: OptionExpiryResolution;
  plan: SpotPlan;
  // Signal snapshot at suggestion time
  rFactor: number;
  rFactorConfidence: number;
  oiLevel: number;
  oiUrgency: number | null;
  changePctOpen: number | null;
  spreadPct: number | null;
  imbalance: number | null;
  orBreakout: boolean;
  /** TradeFinder 3-check breakout verdict from the live row (lib/breakout):
   *  morning test · R-Factor efficiency · named levels cleared. Display
   *  evidence, not a gate — null until the symbol's candles are recorded. */
  tfBreakout: BreakoutSignal | null;
  setupLevel: string;
  /** Already moved ≥3% from open at suggestion time. With EXCLUDE_EXTENDED
   *  these are gated out (0-for-5 evidence); kept for the flag-off path. */
  extended: boolean;
  factors: PickFactors | null;
  reasons: string[];
  /** Candle-freshness (+ later priority) context, stamped at scan time. Optional
   *  because a suggestion rehydrated from the DB may predate it; the auto-trade
   *  gate recomputes freshness from the store at placement time regardless. */
  candleContext?: SuggestionCandleContext;
}

/** Market breadth among the scanned candidates — context, never a gate
 *  (replay: a tilt gate would have blocked the day's only winner). */
export interface MarketTilt {
  up: number;
  down: number;
  flat: number;
  /** % moves are measured from the day's OPEN (live rows carry no prev close). */
  basis: 'since-open';
  lean: 'CE' | 'PE' | 'neutral';
}

/** Per-sector flow among scanned candidates (inflow/outflow read). */
export interface SectorFlow {
  sector: string;
  names: number;
  avgChgPct: number | null;
  /** How many of the sector's names are on NSE's OI build-up list. */
  oiSpurts: number;
}

/** An earlier-today call with its LIVE price — the position-management feed.
 *  Stays populated even after the name drops off the movers lists / below the
 *  gates, so the commentary can decide HOLD / MOVE SL / EXIT with real numbers
 *  all day (a dropped pick must never leave an open position blind). */
export interface TrackedPosition {
  symbol: string;
  side: OptionSide;
  direction: 'bullish' | 'bearish';
  /** Spot when first suggested + the original plan levels. */
  entrySpot: number;
  slSpot: number | null;
  targetSpot: number | null;
  /** Live spot this scan (null only if the quote batch missed it). */
  ltp: number | null;
  suggestedAt: string;
}

/**
 * Current thesis evidence for an earlier suggestion, recomputed even when the
 * symbol no longer survives today's suggestion gates. The auto-trader filters
 * this to actual open symbols and uses it only as supporting evidence; the
 * held contract and mutable plan remain authoritative in openPositions.
 */
export interface ManagedPositionSignal {
  symbol: string;
  direction: 'bullish' | 'bearish';
  changePctOpen: number | null;
  rFactor: number | null;
  confidence: number | null;
  oiLevel: number | null;
  oiUrgency: number | null;
  nseOiPct: number | null;
  combinedOiSlope30m: number | null;
  vwapAligned: boolean | null;
  supertrendAligned: boolean | null;
  orBreakout: boolean | null;
  tfBreakout: BreakoutSignal | null;
  sectorAligned: boolean | null;
  dataAsOfMs: number | null;
}

/** A persisted suggestion read back from trade_suggestions. */
export interface StoredSuggestion {
  date: string;
  symbol: string;
  optionType: OptionSide;
  strike: number;
  expiryDate: string;
  spotAtSuggest: number;
  slSpot: number | null;
  targetSpot: number | null;
  lotSize: number;
  optSecurityId: string;
  nearestListedExpiry: string | null;
  expiryRolled: boolean | null;
  expiryRollReason: 'EXPIRY_WEEK' | null;
  expiryCalendarDte: number | null;
  masterSyncDate: string | null;
  sector: string;
  rFactor: number;
  confidence: number;
  oiLevel: number;
  oiUrgency: number | null;
  score: number;
  rank: number;
  reasons: string[];
  premiumAtSuggest: number | null;
  premiumSl: number | null;
  premiumTarget: number | null;
  suggestedAt: string;
  lastSeenAt: string;
  timesSeen: number;
  maxUpPct: number | null;
  maxDownPct: number | null;
  closePct: number | null;
  /** Honest PATH-DEPENDENT grade vs the stored plan (grade.ts): which of the
   *  plan's stop/target was reached FIRST, or 'timeout'. 'entry-ambiguous' /
   *  'incomplete' = 5-min blind spots (excluded from the win-rate). Null on
   *  legacy rows graded before this existed. */
  spotOutcome: 'target' | 'stop' | 'timeout' | 'entry-ambiguous' | 'incomplete' | null;
  /** Realised R against the plan's own risk (stop −1, target +RR, timeout
   *  close-based); null for the unresolvable outcomes and legacy rows. */
  spotOutcomeR: number | null;
  /** Profit-protection SHADOW: JSON blob of counterfactual R per candidate rule
   *  (profit-protect.ts), computed at review time (today, or a regrade of any
   *  retained session) — carries a `_v` model-version stamp. Measurement only —
   *  never changes a live exit. Null when the baseline was unresolvable / legacy. */
  protectShadow: string | null;
  outcomeAt: string | null;
}

export interface SuggestWindow {
  active: boolean;
  opensAt: string; // "09:40 IST"
  closesAt: string; // "11:00 IST"
  nowIST: string;
}

export interface SuggestResponse {
  success: boolean;
  window: SuggestWindow;
  marketOpen: boolean;
  date: string;
  scanned: number;
  /** How many candidates each gate removed (for transparency). */
  gated: Record<string, number>;
  suggestions: TradeSuggestion[];
  /** Breadth of the scanned candidates (context strip in the UI). */
  tilt?: MarketTilt;
  /** Sector inflow/outflow read among the candidates, strongest first. */
  sectorFlow?: SectorFlow[];
  /** Per-sector turnover-weighted move + breadth among the scanned candidates —
   *  the input the priority-refresh shadow producer turns into a stored sector
   *  snapshot for the next cycle's plan (measurement only). */
  sectorAggregates?: SectorAggregate[];
  /** Dhan quote observation time, captured before scanner-side DB/candle work. */
  marketDataAsOfMs?: number;
  /** Everything persisted earlier today (continuity across loop iterations). */
  earlierToday: StoredSuggestion[];
  /** Earlier calls + live price — the position-management feed (see TrackedPosition). */
  tracked?: TrackedPosition[];
  /** Current thesis evidence for tracked names, independent of suggestion gates. */
  managedPositionSignals?: ManagedPositionSignal[];
  note?: string;
  error?: string;
}
