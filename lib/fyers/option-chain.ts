/**
 * Option-chain TYPES only. The Fyers options-chain fetchers were removed on
 * 2026-11-17 (Fyers Standard plan, 5,000 data calls/day; operator decision):
 * nothing live reads an option chain any more. The types stay because
 * lib/option-chain/evidence.ts still parses the STORED snapshots for
 * scripts/measure-option-evidence.ts.
 */
export interface OptionChainGreeksRow {
  strike: number;
  callGamma: number;
  callOi: number;
  putGamma: number;
  putOi: number;
}
export interface OptionChainGreeksSnapshot {
  rows: OptionChainGreeksRow[];
  underlyingLastPrice: number | null;
}
export interface DetailedOptionSide {
  securityId: string | null;
  lastPrice: number;
  averagePrice: number;
  oi: number;
  previousOi: number;
  previousClosePrice: number;
  previousVolume: number;
  volume: number;
  impliedVolatility: number | null;
  topBidPrice: number | null;
  topBidQuantity: number | null;
  topAskPrice: number | null;
  topAskQuantity: number | null;
  greeks: { delta: number; gamma: number; theta: number; vega: number } | null;
}
export interface DetailedOptionStrike { strike: number; ce: DetailedOptionSide | null; pe: DetailedOptionSide | null }
export interface DetailedOptionChain { underlyingLastPrice: number; strikes: DetailedOptionStrike[]; fetchedAt: string }
