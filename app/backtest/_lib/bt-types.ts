// Shared types for the vectorbt-backed backtest (page + API route).

export type BtStatus = 'ok' | 'skipped' | 'no-candles' | 'no-lot' | 'error';

export interface BtTradeRow {
  tradeId: number;
  date: string;
  symbol: string;
  optionType: string;
  strike: number;
  tfPnl: number;
  lotSize: number | null;
  /** Combined futures OI ÷ 20-day avg. */
  futOiLevel20: number | null;
  /** Combined option OI ÷ 20-day avg (the default gate signal). */
  optOiLevel20: number | null;
  /** How many of the 6 "Why this trade" signals supported the trade. */
  signalScore: number;
  /** Price+OI quadrant of the futures (direction read). */
  futQuadrant: FuturesQuadrant | null;
  futBias: DirectionBias | null;
  /** Traded-strike option flow (writing vs buying). */
  optFlow: OptionFlow | null;
  /** Does the futures bias agree with the trade's CE/PE direction? */
  directionAgrees: boolean | null;
  taken: boolean;
  status: BtStatus;
  entryTime: string | null;
  entryPrice: number | null;
  exitTime: string | null;
  exitPrice: number | null;
  exitReason: string | null;
  grossPnl: number | null;
  charges: number | null;
  netPnl: number | null;
  returnPct: number | null;
}

export interface BtSummary {
  totalTrades: number;
  taken: number; // gate passed
  evaluated: number; // actually simulated (status === 'ok')
  wins: number;
  losses: number;
  winRate: number; // wins / evaluated
  netPnl: number;
  grossPnl: number;
  charges: number;
  profitFactor: number | null;
  expectancy: number; // net per evaluated trade
  maxDrawdown: number; // worst peak-to-trough on cumulative net (₹, ≥ 0)
  sharpe: number | null; // per-trade dispersion ratio
  tfTotalPnl: number; // TF's actual P&L on the SAME evaluated trades
  gateBasis: GateBasis;
  gateThreshold: number;
  profitTarget: number;
}

export type GateBasis = 'optOi' | 'futOi' | 'score' | 'pillars' | 'none';

export type FuturesQuadrant = 'long-buildup' | 'short-buildup' | 'short-covering' | 'long-unwinding' | 'flat';
export type DirectionBias = 'bullish' | 'bearish' | 'neutral';
export type OptionFlow = 'fresh-buying' | 'fresh-writing' | 'writers-covering' | 'buyers-exiting' | 'flat';

export interface BtRunResponse {
  runId: number;
  results: BtTradeRow[]; // chronological (oldest first)
  summary: BtSummary;
  prep: { missingCandles: string[]; missingBhav: string[] };
}
