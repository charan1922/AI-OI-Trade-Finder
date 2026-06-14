/**
 * Market Simulator — core types.
 *
 * The simulator replays recorded historical F&O data on a virtual clock so the
 * UI behaves exactly like a live market feed. `SimQuote` is the rich, live-like
 * snapshot broadcast on every tick — it carries every parameter the Dhan market
 * feed / option-chain APIs expose so downstream consumers (charts, an eventual
 * order engine) can treat replay and real-live identically.
 */

/** Instruments the simulator can replay. */
export type SimInstrumentKind = 'EQUITY' | 'FUTSTK' | 'OPTSTK';

/** Candle interval in minutes (Dhan intraday supported set). */
export type SimInterval = '1' | '5' | '15' | '25' | '60';

/** A normalized historical candle (one row of the replay timeline). */
export interface SimCandle {
  /** Unix epoch seconds (candle open time). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Traded volume for this candle (shares for EQ/options, shares for futures). */
  volume: number;
  /** Open interest at candle close (0 for equity). */
  oi: number;
}

/**
 * The live-like quote broadcast on every simulator tick.
 *
 * Mirrors the fields available from Dhan's `/marketfeed/quote`
 * (LTP, OHLC, volume, VWAP, OI) plus derived analytics (% change, OI
 * change). Everything a real terminal would show is present here.
 */
export interface SimQuote {
  // -- identity --
  symbol: string;
  securityId: string;
  instrumentKind: SimInstrumentKind;
  segment: string;

  // -- last trade --
  /** Last traded price. */
  ltp: number;
  /** Last traded quantity (this tick's volume slice). */
  ltq: number;
  /** Last trade time — epoch seconds in the historical timeline. */
  lastTradeTime: number;
  /** Open time (epoch seconds) of the candle this tick belongs to — stable bar key for charts. */
  candleTime: number;

  // -- forming candle (current interval, updated tick-by-tick) --
  open: number;
  high: number;
  low: number;
  close: number;

  // -- day stats --
  dayOpen: number;
  dayHigh: number;
  dayLow: number;
  /** Previous day's close (basis for % change). */
  prevClose: number;
  change: number;
  changePct: number;

  // -- volume / value --
  /** Cumulative day volume up to this tick. */
  volume: number;
  /** Volume traded within the current forming candle. */
  candleVolume: number;
  /** Volume-weighted average price for the day so far. */
  vwap: number;
  /** Cumulative traded value (₹) for the day so far. */
  turnover: number;

  // -- open interest (F&O) --
  oi: number;
  /** OI change vs the previous day's OI. */
  oiChange: number;
  oiChangePct: number;
  /** OI at the day's first candle (open). */
  dayOpenOi: number;

  // -- replay bookkeeping --
  /** Wall-clock epoch ms when this tick was emitted. */
  ts: number;
  /** Index of the candle this tick belongs to. */
  candleIndex: number;
  /** Index of this tick within the whole replay timeline. */
  tickIndex: number;
  /** True when this is the final tick of its candle (candle is now closed). */
  isCandleClose: boolean;
}

/** Replay clock lifecycle. */
export type SimClockState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'finished';

/** Compact status snapshot broadcast on `status` events and returned by the control API. */
export interface SimStatus {
  state: SimClockState;
  /** Loaded instrument summary (null until a session is loaded). */
  symbol: string | null;
  instrumentKind: SimInstrumentKind | null;
  interval: SimInterval | null;
  fromDate: string | null;
  toDate: string | null;
  speed: number;
  /** Current tick cursor (0-based). */
  cursor: number;
  totalTicks: number;
  totalCandles: number;
  candleIndex: number;
  /** Historical sim time at the cursor — epoch seconds. */
  simTime: number | null;
  /** 0..1 replay progress. */
  progress: number;
  clientCount: number;
  error: string | null;
}

/** SSE envelope broadcast to clients. */
export type SimEvent =
  | { event: 'info'; data: { status: 'connected' } }
  | { event: 'status'; data: SimStatus }
  | { event: 'quote'; data: SimQuote }
  | { event: 'loaded'; data: SimLoadedMeta }
  | { event: 'snapshot'; data: { finalizedCandles: SimCandle[]; quote: SimQuote | null; status: SimStatus } };

/** A downloaded, persisted real-data set the simulator can replay (catalog entry). */
export interface SimDataset {
  key: string;
  symbol: string;
  instrumentKind: SimInstrumentKind;
  segment: string;
  securityId: string;
  interval: string;
  fromDate: string;
  toDate: string;
  candles: number;
  firstTime: number;
  lastTime: number;
  downloadedAt: string;
}

/** Metadata broadcast once a session's data is loaded. */
export interface SimLoadedMeta {
  symbol: string;
  instrumentKind: SimInstrumentKind;
  interval: SimInterval;
  fromDate: string;
  toDate: string;
  totalCandles: number;
  totalTicks: number;
  firstTime: number;
  lastTime: number;
}
