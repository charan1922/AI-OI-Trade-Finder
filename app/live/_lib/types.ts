export interface LiveUrgencyRow {
  symbol: string;
  ltp: number | null;
  /** Intraday change since the day's open (%). */
  changePctOpen: number | null;
  /** Best bid/ask and the spread as a % of mid — the liquidity / execution-cost read. */
  bid: number | null;
  ask: number | null;
  spreadPct: number | null;
  /** Bid qty ÷ (bid+ask) in [0,1] — order-flow pressure (the real "urgency" proxy). */
  imbalance: number | null;
  /** Live futures OI and its ratio to the 20-session bhavcopy average (conviction). */
  futOi: number | null;
  oiLevel: number | null;
  /** Live futures turnover ≈ VWAP × volume (quality). */
  turnover: number | null;
  /** False when no order book came back for this name (shown as "—", never faked). */
  hasDepth: boolean;

  // ── Intraday OI urgency (from the per-day oi_intraday series) ──────────────
  // Rate-of-change of OI within THIS session, distinct from oiLevel (a static
  // 20-day ratio). Null until enough intraday snapshots have accumulated today.
  /** Total OI build since the session's first snapshot (%). */
  sessionOiChangePct: number | null;
  /** Latest OI build rate, ‰ of day-open OI per minute, clamped [−5, +5]. */
  oiVelocity: number | null;
  /** Is the OI build itself accelerating? Clamped [−3, +3]. */
  oiAccel: number | null;
  /** Composite 0–10 urgency — fast + accelerating + already-significant OI build. */
  oiUrgency: number | null;

  // ── R-Factor (lib/r-factor, live intraday) ─────────────────────────────────
  // Recomputed every poll from the live snapshot against fixed EOD baselines.
  // Null when there's no usable price. Weights are provisional until calibrated.
  /** Strength on a 1.0–8.0 scale (TradeFinder-like). Higher = stronger interest. */
  rFactor: number | null;
  /** Net directional read from the voting factors. */
  rFactorBias: 'buy' | 'sell' | 'neutral' | null;
  /** Agreement among directional factors, [0,1]. */
  rFactorConfidence: number | null;
  /** True once past the 9:45 IST entry window (and market open). */
  rFactorAfterEntry: boolean | null;
  /** Per-factor breakdown for the tooltip. */
  rFactors: RFactorRowDetail[] | null;
}

/** One factor's contribution, surfaced to the UI tooltip. */
export interface RFactorRowDetail {
  label: string;
  score: number;
  vote: 'buy' | 'sell' | 'neutral';
  available: boolean;
  detail: string;
}

/** One auto-picked watchlist name. Used by both sector-leaders and NSE-movers sources. */
export interface SectorPick {
  symbol: string;
  sector: string;
  /** % move: 5-session close return for sector leaders, today's feed % for NSE movers. */
  retPct: number;
  /** Avg daily futures turnover over the last 20 sessions, in ₹ Cr. Sector leaders only. */
  avgFutTurnoverCr?: number;
}

export type SectorBasis = 'gainers' | 'losers' | 'movers';

/**
 * Where the Live Urgency watchlist is auto-built from. `sector-*` come from the
 * synced bhavcopy (per-sector leaders); `nse-*` come from NSE's live pulse feeds.
 * Every source is gated to F&O-only, non-'avoid' names server-side.
 */
export type WatchlistSource =
  | 'sector-gainers'
  | 'sector-losers'
  | 'nse-oi'
  | 'nse-gainers'
  | 'nse-losers'
  | 'nse-active-value'
  | 'nse-active-volume';

/** Response of both /api/live/sector-leaders and /api/live/nse-watchlist. */
export interface SectorLeadersResponse {
  success: boolean;
  picks: SectorPick[];
  meta?: {
    /** Set by the NSE-movers source; absent for sector leaders. */
    source?: WatchlistSource;
    basis?: SectorBasis;
    perSector?: number;
    /** Sector-leaders only — the return-window dates. */
    returnWindow?: { from: string; to: string; sessions: number };
    liquidityFloorCr?: number;
    sectorsCovered: number;
    candidates: number;
    /** F&O names dropped for being in the 'avoid' lot-size band. */
    excludedAvoid?: number;
  };
  error?: string;
}

export interface LiveQuoteResponse {
  success: boolean;
  marketOpen: boolean;
  /** True when rows are the persisted end-of-session state (post-market), not live depth. */
  snapshot?: boolean;
  /** The session the snapshot rows belong to (YYYY-MM-DD). */
  snapshotDate?: string;
  asOf?: string;
  date?: string;
  rows: LiveUrgencyRow[];
  symbols: string[];
  /** Symbols dropped from the watchlist because they aren't tradeable F&O names. */
  excluded?: { symbol: string; reason: string }[];
  error?: string;
}
