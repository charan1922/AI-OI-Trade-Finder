import type { BreakoutSignal } from '@/lib/breakout';

export interface LiveUrgencyRow {
  symbol: string;
  ltp: number | null;
  /** Previous official cash close used by Sector Scope's `Pre C`/day-change display. */
  previousClose?: number | null;
  /** Signed move from the previous official cash close (%). */
  changePctPrevClose?: number | null;
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
  /** Live session high/low, used by the V2 shadow range-activity factor. */
  dayHigh?: number | null;
  dayLow?: number | null;
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

  // ── Move freshness + flow pace (the "can I still enter?" reads) ────────────
  /** Price change (%) since the first recorded tick at/after 09:45 IST — what the
   *  move has offered AFTER the entry window opened. A big Chg% with a tiny value
   *  here = the move happened at the open (gap-and-flat) and is likely spent.
   *  Null before 09:45 / when nothing is recorded (never fabricated). */
  sinceEntryPct?: number | null;
  /** Futures turnover ÷ its 20-day average, adjusted for the fraction of the
   *  session elapsed — is real money flowing at an unusual pace RIGHT NOW (a
   *  level that decays if the flow dies, unlike raw cumulative turnover). */
  turnoverLvl?: number | null;
  /** NSE's combined (futures+options) OI %-change vs the previous EOD, as
   *  RECORDED per 5-min bar by the Fyers poller (DB). Lags the live feed by up
   *  to one poll — kept only to derive `nseOiSlope30m`, NOT displayed as the NSE
   *  %Chng column (that uses the live-feed `nseChgOiPct` below so it matches NSE
   *  exactly). Null for names not in the feed / off-hours. */
  nseOiPct?: number | null;
  /** Trailing ~30-min build of nseOiPct in pct-points — OUR derived combined-OI
   *  rate ("still building now" vs "stalled"). Shown in the App block. */
  nseOiSlope30m?: number | null;
  /** Combined (futures+options) OI build in pct-points SINCE 09:35 IST — the OI
   *  counterpart of the `sinceEntryPct` price column, answering "how much of
   *  today's OI build arrived after the open settled" rather than "since
   *  yesterday". Both ends are NSE's own cumulative figure, subtracted — nothing
   *  is recomputed from raw OI. Null when no bar at/after 09:35 was recorded;
   *  null means no evidence, never zero build. */
  nseOiSinceWindowPct?: number | null;
  // ── NSE oi-spurts feed columns (LIVE-feed join, shown verbatim as NSE reports) ─
  // These are the exact per-underlying values from NSE's
  // live-analysis-oi-spurts-underlyings feed — the same numbers /nse/movers and
  // NSE's own F&O OI Build-up table show. Sourced live (getNseOiRowMap), so they
  // match NSE, not our recorded snapshot. Money values normalized to ₹ Cr.
  /** NSE `avgInOI` — combined fut+opt OI %-change vs yesterday's close. THE value
   *  NSE ranks its list by; shown exactly (2 dp). */
  nseChgOiPct?: number | null;
  /** NSE `changeInOI` — absolute change in combined OI (contracts). */
  nseChangeInOi?: number | null;
  /** NSE `volume` — traded volume today (contracts). */
  nseVolume?: number | null;
  /** NSE `underlyingValue` — the underlying's spot value. */
  nseUnderlyingValue?: number | null;
  // Snapshot from NSE's oi-spurts feed (cumulative since prev EOD). Money in ₹ Cr.
  /** Options premium traded value today (₹ Cr) — the money in the options pool. */
  nsePremValueCr?: number | null;
  /** Futures traded value today (₹ Cr). */
  nseFutValueCr?: number | null;
  /** Options notional traded value today (₹ Cr). */
  nseOptValueCr?: number | null;
  /** Futures + options-premium total (₹ Cr). */
  nseTotalValueCr?: number | null;
  /** Options share of the fut+prem value, [0,1] — options-led (high) vs futures-led. */
  nseOptShare?: number | null;
  /** Combined futures+options OI today / yesterday (contracts). */
  nseLatestOi?: number | null;
  nsePrevOi?: number | null;

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


  // ── TradeFinder breakout (lib/breakout) ────────────────────────────────────
  /** 3-check TF verdict: morning test · R-Factor efficiency · levels cleared.
   *  Live LTP against 5-min-cached levels. Null until candles are recorded
   *  (optional so older row producers/consumers are unaffected). */
  breakout?: BreakoutSignal | null;

  // ── TradeFinder's OWN R-Factor (lib/tf-live) ───────────────────────────────
  // From the most recent successful `all_sector` capture on /tf — TradeFinder's
  // actual number, not our estimate of it. Captured periodically (not live-
  // ticking), so this can lag by minutes to a day; capturedAt on the fetch
  // response says exactly how stale. Merged in client-side, additive only —
  // never touches the live quote/scanner path. Null until /tf has a
  // successful capture with this symbol in it.
  tfRFactor?: number | null;
  tfPctChange?: number | null;
  tfPreviousClose?: number | null;
}

/** TradeFinder's own R-Factor snapshot, merged into rows for display only. */
export interface TfRFactorMap {
  capturedAt: string | null;
  values: Record<string, { rFactor: number | null; pctChange: number | null; previousClose: number | null }>;
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

/** One name's race since market open — from /api/live/climbers. */
export interface RaceRunner {
  symbol: string;
  rankNow: number;
  /** Rank at market open; null = joined the board after open (new entrant). */
  rankOpen: number | null;
  /** rankOpen − rankNow. Positive = climbed toward #1. Null for new entrants. */
  deltaSinceOpen: number | null;
  valueNow: number;
  isNew: boolean;
  /** Rank at each 5-min check, aligned to `bucketTimes` (null = off the board that check). */
  track: (number | null)[];
}

export type RankFeed = 'oi' | 'gainers' | 'losers' | 'active-value' | 'active-volume';

export interface ClimbersResponse {
  success: boolean;
  marketOpen: boolean;
  feed: RankFeed;
  date: string;
  openTs: number | null;
  latestTs: number | null;
  /** Every 5-min checkpoint today (epoch seconds), oldest → newest. */
  bucketTimes: number[];
  runners: RaceRunner[];
  newEntrants: RaceRunner[];
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
