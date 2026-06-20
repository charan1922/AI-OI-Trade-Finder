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
}

/** One pick from /api/live/sector-leaders — a sector's top performer. */
export interface SectorPick {
  symbol: string;
  sector: string;
  /** % change in close over the lookback window (5 sessions). */
  retPct: number;
  /** Avg daily futures turnover over the last 20 sessions, in ₹ Cr. */
  avgFutTurnoverCr: number;
}

export type SectorBasis = 'gainers' | 'losers' | 'movers';

export interface SectorLeadersResponse {
  success: boolean;
  picks: SectorPick[];
  meta?: {
    basis: SectorBasis;
    perSector: number;
    returnWindow: { from: string; to: string; sessions: number };
    liquidityFloorCr: number;
    sectorsCovered: number;
    candidates: number;
  };
  error?: string;
}

export interface LiveQuoteResponse {
  success: boolean;
  marketOpen: boolean;
  asOf?: string;
  date?: string;
  rows: LiveUrgencyRow[];
  symbols: string[];
  error?: string;
}
