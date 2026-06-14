export interface DataStatus {
  equityRows: number;
  futuresRows: number;
  optionsRows: number;
  totalRows: number;
  hasData: boolean;
}

export interface TFTradeItem {
  date: string;
  symbol: string;
  optionType: string;
  strike: number;
  pnl: number;
  hasData: boolean;
  spotPrice?: number | null;
  expiry?: string | null;
  entryTime?: string;
  entryPrice?: number;
  exitTime?: string;
  exitPrice?: number;
  quantity?: number;
  humanReview?: boolean;
}

export interface Signal {
  timestamp: number;
  time: string;
  spreadRatio: number;
  rFactor: number;
  adx: number;
  plusDI: number;
  minusDI: number;
  direction: string;
  isHot: boolean;
  optionClose: number;
  equityClose: number;
}

export interface TradeDetailData {
  optionBars: {
    timestamp: number;
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    oi: number;
  }[];
  equityBars: {
    timestamp: number;
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
  }[];
  signals: Signal[];
  tf: { spotPrice: number | null; pnl: number; strike: number; optionType: string; expiry: string | null };
  estimatedEntry: { barIndex: number; timestamp: number; time: string; optionPrice: number; method: string } | null;
  estimatedExit: { barIndex: number; timestamp: number; time: string; optionPrice: number; method: string } | null;
  pnlCurve: { timestamp: number; time: string; optionPrice: number; pnl: number; pnlPct: number }[];
  lotSize: number;
  symbol: string;
  date: string;
  dataAvailable: boolean;
}
