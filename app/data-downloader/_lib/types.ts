/** Which button fills a given data gap. */
export type FixAction = 'download' | 'sync';

/**
 * Per-source data coverage for a trade's lookback window. Each data source is
 * filled by a different action, so the gap report has to say WHICH:
 *  - equity / futures / tradedOption → per-trade **Download** button (Dhan)
 *  - bhavcopy (futures + total option OI charts) → separate **Sync** button (NSE)
 */
export interface LegCoverage {
  key: 'equity' | 'futures' | 'tradedOption' | 'bhavcopy';
  /** Short tag for the list dots (EQ, FUT, OPT, OI). */
  short: string;
  /** Full label for tooltips / the detail panel. */
  label: string;
  /** Sessions of this source present in the window. */
  daysPresent: number;
  /**
   * Sessions we have ANY data for in the window — the honest denominator. We do
   * NOT claim to know the true NSE trading calendar here (the detail panel's
   * CalendarNote does that); this just flags sources that lag the others.
   */
  sessionsKnown: number;
  status: 'ok' | 'partial' | 'missing';
  fixedBy: FixAction;
  /** False for the tradedOption leg when the trade has no option (strike 0). */
  applicable: boolean;
}

export interface TradeDataStatus {
  symbol: string;
  date: string;
  optionType: string;
  strike: number;
  spotPrice?: number;
  pnl: number;
  humanReview: boolean;
  entryTime?: string;
  entryPrice?: number;
  exitTime?: string;
  exitPrice?: number;
  quantity?: number;
  expiry?: string;
  /** Back-compat booleans — true when the leg has any data in the window. */
  hasEquity: boolean;
  hasFutures: boolean;
  hasOptions: boolean;
  /** Per-source window coverage (drives the dots + the detail coverage note). */
  legs: LegCoverage[];
  status: 'ready' | 'partial' | 'missing';
}

export interface DataSummary {
  totalTrades: number;
  readyCount: number;
  partialCount: number;
  missingCount: number;
  dateRange: { from: string; to: string };
}

export interface DownloadEvent {
  type: 'progress' | 'step-done' | 'symbol-done' | 'complete' | 'error';
  symbol?: string;
  step?: 'master-sync' | 'equity' | 'futures' | 'options' | 'bhavcopy';
  rows?: number;
  symbolIndex?: number;
  totalSymbols?: number;
  totalRows?: number;
  errorCount?: number;
  errors?: string[];
  message?: string;
}

// ── Daily trade context (response shape of the `trade-context` API action) ───
// Per-day OI / turnover / volume aggregated from the downloaded 5-min bars,
// used by the bar graphs that explain WHY a trade was taken. Mirrors
// `TradeContext` from lib/backtest/backtest-evaluator.ts.

export interface DailyContextDay {
  date: string;
  isTradeDate: boolean;
  /** Futures end-of-day open interest — total across ALL contracts (NSE bhavcopy). */
  futOI: number;
  /** Futures turnover for the day — total across all contracts (NSE bhavcopy), in ₹. */
  futTurnover: number;
  futVolume: number;
  /** Single traded strike's EOD OI (Dhan). No longer charted — kept for reference. */
  optOI: number;
  /** Single traded strike's volume (Dhan). No longer charted. */
  optVolume: number;
  /** TOTAL option OI across ALL strikes (CE+PE) — official NSE bhavcopy accumulator. */
  optOITotal: number;
  /** TOTAL option volume across ALL strikes (CE+PE) — official NSE bhavcopy. */
  optVolumeTotal: number;
  /** Equity turnover for the day = Σ(volume × close), in ₹. */
  eqTurnover: number;
  eqVolume: number;
  /** Underlying EOD close (bhavcopy, else last equity 5-min bar) — drives price direction. */
  eqClose: number;
  /** Futures EOD close (last futures 5-min bar, Dhan single contract). */
  futClose: number;
  /** Traded strike's EOD premium (last option 5-min bar, Dhan). */
  optClose: number;
  /** Where the futures figures came from: NSE bhavcopy (total across contracts). */
  futSrc: 'dhan' | 'bhavcopy' | null;
  /** Where the total option figures came from: NSE bhavcopy. */
  optSrc: 'bhavcopy' | null;
  eqSrc: 'dhan' | 'bhavcopy' | null;
}

/** Preserved Dhan contract IDs resolved at download time (trade_contracts table). */
export interface TradeContractIds {
  eqSecurityId: string | null;
  futSecurityId: string | null;
  futExpiry: string | null;
  futLotSize: number | null;
  optSecurityId: string | null;
  optVia: string | null;
  resolvedAt: string;
}

export type FuturesQuadrant = 'long-buildup' | 'short-buildup' | 'short-covering' | 'long-unwinding' | 'flat';
export type DirectionBias = 'bullish' | 'bearish' | 'neutral';
export type OptionFlow = 'fresh-buying' | 'fresh-writing' | 'writers-covering' | 'buyers-exiting' | 'flat';

export interface TradeContextData {
  optionType: string;
  strike: number;
  days: DailyContextDay[];
  insight: {
    optOIChangePct: number | null;
    optOIChangePctTradeDay: number | null;
    futOIChangePct: number | null;
    turnoverVsAvg: number | null;
    /** TF/R-Factor `oi_level`: trade-day OI ÷ same-cycle average OI. Null for
     *  options when too few same-cycle sessions exist (right after a monthly expiry). */
    optOILevel20d: number | null;
    futOILevel20d: number | null;
    /** A monthly options expiry falls inside the lookback — option OI level/change
     *  are computed within the trade day's cycle only (and may be hidden). */
    optExpiryInWindow: boolean;
    /** Trade-day underlying price change vs the previous session (%). */
    priceChangePctTradeDay: number | null;
    /** Price+OI quadrant for the futures (prev session → trade day). */
    futQuadrant: FuturesQuadrant;
    futBias: DirectionBias;
    futQuadrantLabel: string;
    /** Traded-strike option flow (writing vs buying). */
    optFlow: OptionFlow;
    optFlowLabel: string;
    /** Does the data-derived futures bias agree with the trade's CE/PE direction? */
    directionAgrees: boolean;
    directionNote: string;
  };
  /** Weekend/holiday/data-gap accounting for the window (derived from market data). */
  calendar: WindowCalendar | null;
}

export interface WindowCalendar {
  sessions: number;
  spanFrom: string;
  spanTo: string;
  weekendsSkipped: number;
  /** Official NSE holidays (from HolidaycalenderData.csv, with occasion names). */
  holidays: { date: string; occasion: string | null }[];
  /** Market open but THIS symbol's data missing — skews averages, surfaced as a warning. */
  symbolGaps: string[];
  /** Weekend dates the market actually traded (e.g. Budget-day sessions). */
  specialSessions: string[];
  /** Weekdays with no data anywhere and not on the official list — reported, not labeled. */
  noDataDays: string[];
}
