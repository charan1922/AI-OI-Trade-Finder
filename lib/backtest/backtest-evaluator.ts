/**
 * Backtest Evaluator
 *
 * Replays 5-min historical data for TF's last 20 trades.
 * For each trade date:
 * 1. Rank all stocks by intraday spread ratio at 9:45 AM
 * 2. Compute intraday ADX(7) for direction
 * 3. Simulate option entry at 9:45, exit at profit/SL/time
 * 4. Compare our P&L with TF's actual P&L
 */

import { ADX } from 'trading-signals';
import { queryRows, getTradeContract } from './backtest-store';
import { getOptionExpiryOISeries } from '@/lib/historify/bhavcopy-service';
import { getExpiriesAsc, mostRecentExpiryBefore } from './expiry-calendar';
import { analyzeWindow, type WindowCalendar } from './trading-calendar';
import { TF_TRADES, type TFTrade } from './data-downloader';
import { calculateOptionCharges, type ChargesBreakdown } from '@/lib/ai-trading/commissions';
import { batchResolveFutures } from '@/lib/historify/master-contracts';
import {
  classifyFuturesOI,
  classifyOptionFlow,
  reconcileWithLabel,
  type DirectionBias,
  type FuturesQuadrant,
  type OptionFlow,
} from '@/lib/signals/oi-direction';

export interface BacktestResult {
  date: string;
  // TF's trade
  tfStock: string;
  tfCePe: string;
  tfStrike: number;
  tfPnl: number;
  // Our signal at 9:45 AM
  ourTopStock: string;
  ourRank: number; // TF stock's rank in our list
  ourSpread: number;
  ourDirection: 'CE' | 'PE';
  ourADX: number;
  stockMatch: boolean;
  directionMatch: boolean;
  tfInTop10: boolean;
  // Simulated option trade (using TF's stock for fair comparison)
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  exitReason: string;
  lotSize: number;
  grossPnl: number;
  charges: number;
  netPnl: number;
  profitable: boolean;
}

export interface BacktestSummary {
  totalTrades: number;
  /** Trades that produced a real P&L (had bars AND a resolvable lot size). */
  evaluatedTrades: number;
  stockMatchCount: number;
  directionMatchCount: number;
  tfInTop10Count: number;
  ourWins: number;
  ourLosses: number;
  ourTotalPnl: number;
  ourAvgWin: number;
  ourAvgLoss: number;
  /** ourWins ÷ evaluatedTrades. */
  ourWinRate: number;
  /** Σ wins ÷ |Σ losses|; null when there were no losses. */
  profitFactor: number | null;
  /** Mean net P&L per evaluated trade (₹). */
  expectancy: number;
  /** Largest peak-to-trough drop of the cumulative net-P&L curve (₹, ≥ 0). */
  maxDrawdown: number;
  /** Per-trade Sharpe: mean net P&L ÷ std dev (not annualized); null if std = 0. */
  sharpe: number | null;
  tfTotalPnl: number;
  tfWinRate: number;
}

// IST offset: 5h30m = 19800 seconds
const IST_OFFSET = 5.5 * 3600;

function unixToIST(unix: number): Date {
  return new Date((unix + IST_OFFSET) * 1000);
}

/**
 * Parse "10:17:46 AM" or "03:25:32 PM" → minutes since midnight in IST.
 * Then find the 5-min bar whose IST time range contains this time.
 */
function findBarByTime(bars: { timestamp: number }[], timeStr: string): number {
  // Parse "10:17:46 AM" → 24h minutes
  const match = timeStr.match(/(\d+):(\d+):?(\d+)?\s*(AM|PM)/i);
  if (!match) return -1;
  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const ampm = match[4].toUpperCase();
  if (ampm === 'PM' && hours !== 12) hours += 12;
  if (ampm === 'AM' && hours === 12) hours = 0;
  const targetMinutes = hours * 60 + minutes; // e.g., 10:17 AM = 617

  // Find bar where target time falls within [barTime, barTime+5min)
  for (let i = 0; i < bars.length; i++) {
    const barIST = unixToIST(bars[i].timestamp);
    const barMinutes = barIST.getUTCHours() * 60 + barIST.getUTCMinutes();
    // Bar covers [barMinutes, barMinutes+5)
    if (targetMinutes >= barMinutes && targetMinutes < barMinutes + 5) {
      return i;
    }
  }

  // Fallback: find closest bar
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < bars.length; i++) {
    const barIST = unixToIST(bars[i].timestamp);
    const barMinutes = barIST.getUTCHours() * 60 + barIST.getUTCMinutes();
    const diff = Math.abs(targetMinutes - barMinutes);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function formatTime(unix: number): string {
  const d = unixToIST(unix);
  return `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}`;
}

/**
 * Get daily spread for a stock from 5-min bars.
 * Returns (day_high - day_low) / last_close for each trading day.
 */
async function getDailySpreadHistory(symbol: string, beforeDate: string, days = 20): Promise<number[]> {
  // Get distinct dates with their high/low/close from equity bars
  const rows = (await queryRows(
    `
    SELECT date, MAX(high) as day_high, MIN(low) as day_low,
           (SELECT close FROM backtest_equity e2 WHERE e2.symbol = ? AND e2.date = e.date ORDER BY timestamp DESC LIMIT 1) as last_close
    FROM backtest_equity e
    WHERE symbol = ? AND date < ?
    GROUP BY date
    ORDER BY date DESC
    LIMIT ?
  `,
    [symbol, symbol, beforeDate, days],
  )) as { date: string; day_high: number; day_low: number; last_close: number }[];

  return rows
    .map((r) => {
      const high = Number(r.day_high);
      const low = Number(r.day_low);
      const close = Number(r.last_close);
      return close > 0 ? (high - low) / close : 0;
    })
    .reverse(); // oldest first
}

// ── Daily trade-context aggregation (data-downloader "why this trade" view) ──

export interface DailyContextDay {
  date: string;
  isTradeDate: boolean;
  futOI: number;
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
  /** OI of the TRADED contract only (this exact expiry month, all strikes CE+PE),
   *  from the per-expiry table. 0 when not backfilled. Powers the expiry-safe level. */
  optContractOI: number;
  eqTurnover: number;
  eqVolume: number;
  /** Underlying EOD close (bhavcopy, else last equity 5-min bar). Drives price direction. */
  eqClose: number;
  /** Futures EOD close (last futures 5-min bar, Dhan single contract). */
  futClose: number;
  /** Traded strike's EOD premium (last option 5-min bar, Dhan). Drives option-flow read. */
  optClose: number;
  /** Source of the futures fields: NSE bhavcopy (total across contracts). */
  futSrc: 'dhan' | 'bhavcopy' | null;
  /** Source of the total option fields: NSE bhavcopy. */
  optSrc: 'bhavcopy' | null;
  eqSrc: 'dhan' | 'bhavcopy' | null;
}

export interface TradeContext {
  optionType: string;
  strike: number;
  days: DailyContextDay[];
  insight: {
    optOIChangePct: number | null; // window first → last
    optOIChangePctTradeDay: number | null; // prev day → trade day
    futOIChangePct: number | null;
    turnoverVsAvg: number | null; // trade-day futures turnover ÷ window avg
    /** TF/R-Factor `oi_level`. When the traded contract's per-expiry data exists,
     *  this is trade-day OI ÷ that contract's own recent average (no cross-cycle
     *  skew). Otherwise it falls back to the summed total clipped to the trade
     *  day's cycle; null if too few comparable sessions. */
    optOILevel20d: number | null;
    futOILevel20d: number | null;
    /** True only on the FALLBACK path (no per-contract data) when a monthly expiry
     *  sits in the lookback — the summed total is cycle-distorted, so trust it less. */
    optExpiryInWindow: boolean;
    /** The contract month the OI metrics track (ISO, e.g. "2026-06-30"), or null
     *  when per-contract data isn't available and we fell back to the total. */
    optContractExpiry: string | null;
    /** True when the OI level/change come from the traded contract's own series
     *  (the accurate path) rather than the summed-total fallback. */
    optContractDataAvailable: boolean;
    /** Trade-day underlying price change vs the previous session (%). */
    priceChangePctTradeDay: number | null;
    /** Price+OI quadrant for the futures (prev session → trade day). */
    futQuadrant: FuturesQuadrant;
    futBias: DirectionBias;
    futQuadrantLabel: string;
    /** Traded-strike option flow (writing vs buying), prev session → trade day. */
    optFlow: OptionFlow;
    optFlowLabel: string;
    /** Does the data-derived futures bias agree with the trade's CE/PE direction? */
    directionAgrees: boolean;
    directionNote: string;
  };
  /** Weekend/holiday/data-gap accounting for the window (derived from market data). */
  calendar: WindowCalendar | null;
}

/**
 * Per-day context leading up to (and including) a trade date, aggregated from the
 * downloaded 5-min bars. Powers the data-downloader bar graphs that explain WHY a
 * trade was taken: option-strike OI buildup, futures OI, and turnover.
 *
 * EOD OI = the OI of the last bar of each day (correlated subquery, same trick as
 * `getDailySpreadHistory`). Turnover = Σ(volume × close) per day (Dhan history has
 * no turnover/VWAP field — see document.json).
 */
const MONTHS_3: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * Normalize a trade's expiry to ISO YYYY-MM-DD so it matches the exchange file's
 * `XpryDt` exactly. Accepts "30 Jun 2026", "2026-06-30", or "2026-06-30T..".
 * Returns null if it can't be parsed (caller then falls back to the summed total).
 */
function normalizeExpiry(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})$/);
  if (dmy) {
    const mm = MONTHS_3[dmy[2].toLowerCase()];
    if (mm) return `${dmy[3]}-${mm}-${dmy[1].padStart(2, '0')}`;
  }
  return null;
}

export async function getDailyContext(params: {
  symbol: string;
  date: string;
  optionType: 'CE' | 'PE';
  strike: number;
  days?: number;
  /** The trade's contract month (any of "30 Jun 2026" / "2026-06-30"); used to
   *  track that exact contract's OI instead of the all-months summed total. */
  expiry?: string;
}): Promise<TradeContext> {
  const { symbol, date, optionType, strike } = params;
  const days = params.days ?? 30;
  const contractExpiry = normalizeExpiry(params.expiry); // ISO YYYY-MM-DD or null

  const futRows = (await queryRows(
    `
    SELECT date,
      (SELECT oi FROM backtest_futures f2 WHERE f2.symbol = f.symbol AND f2.date = f.date ORDER BY timestamp DESC LIMIT 1) as eod_oi,
      (SELECT close FROM backtest_futures f3 WHERE f3.symbol = f.symbol AND f3.date = f.date ORDER BY timestamp DESC LIMIT 1) as eod_close,
      SUM(volume * close) as turnover, SUM(volume) as volume
    FROM backtest_futures f
    WHERE symbol = ? AND date <= ?
    GROUP BY date ORDER BY date DESC LIMIT ?
  `,
    [symbol, date, days],
  )) as { date: string; eod_oi: number; eod_close: number; turnover: number; volume: number }[];

  const optRows = (await queryRows(
    `
    SELECT date,
      (SELECT oi FROM backtest_options o2 WHERE o2.symbol = o.symbol AND o2.date = o.date AND o2.option_type = o.option_type AND CAST(o2.strike AS REAL) = ? ORDER BY timestamp DESC LIMIT 1) as eod_oi,
      (SELECT close FROM backtest_options o3 WHERE o3.symbol = o.symbol AND o3.date = o.date AND o3.option_type = o.option_type AND CAST(o3.strike AS REAL) = ? ORDER BY timestamp DESC LIMIT 1) as eod_close,
      SUM(volume) as volume
    FROM backtest_options o
    WHERE symbol = ? AND option_type = ? AND CAST(strike AS REAL) = ? AND date <= ?
    GROUP BY date ORDER BY date DESC LIMIT ?
  `,
    [strike, strike, symbol, optionType, strike, date, days],
  )) as { date: string; eod_oi: number; eod_close: number; volume: number }[];

  const eqRows = (await queryRows(
    `
    SELECT date, SUM(volume * close) as turnover, SUM(volume) as volume,
      (SELECT close FROM backtest_equity e2 WHERE e2.symbol = e.symbol AND e2.date = e.date ORDER BY timestamp DESC LIMIT 1) as eod_close
    FROM backtest_equity e
    WHERE symbol = ? AND date <= ?
    GROUP BY date ORDER BY date DESC LIMIT ?
  `,
    [symbol, date, days],
  )) as { date: string; turnover: number; volume: number; eod_close: number }[];

  // NSE bhavcopy fallback (official EOD) for days Dhan candles don't cover —
  // e.g. futures of symbols that have since left F&O. Units verified against
  // Dhan: OI ratio 1.002, turnover ratio 0.999 (same units); futures VOLUME is
  // NOT mixable (Dhan shares vs NSE contracts), so it is never filled from here.
  let bhavMap = new Map<
    string,
    {
      futOi: number;
      futTurnover: number;
      optOi: number;
      optVolume: number;
      eqVolume: number;
      eqTurnover: number;
      eqClose: number;
    }
  >();
  try {
    const { prisma } = await import('@/lib/db');
    const bhavRows = await prisma.$queryRawUnsafe<
      {
        date: string;
        futOi: number | null;
        futTurnover: number | null;
        optOi: number | null;
        optVolume: number | null;
        eqVolume: number | null;
        eqTurnover: number | null;
        eqClose: number | null;
      }[]
    >(
      `SELECT date, futOi, futTurnover, optOi, optVolume, eqVolume, eqTurnover, eqClose FROM bhavcopy_days
       WHERE symbol = ? AND date <= ?
       ORDER BY date DESC LIMIT ?`,
      symbol,
      date,
      days,
    );
    bhavMap = new Map(
      bhavRows.map((r) => [
        r.date,
        {
          futOi: Number(r.futOi ?? 0),
          futTurnover: Number(r.futTurnover ?? 0),
          optOi: Number(r.optOi ?? 0),
          optVolume: Number(r.optVolume ?? 0),
          eqVolume: Number(r.eqVolume ?? 0),
          eqTurnover: Number(r.eqTurnover ?? 0),
          eqClose: Number(r.eqClose ?? 0),
        },
      ]),
    );
  } catch {
    // bhavcopy table absent — Dhan-only context
  }

  const futMap = new Map(futRows.map((r) => [r.date, r]));
  const optMap = new Map(optRows.map((r) => [r.date, r]));
  const eqMap = new Map(eqRows.map((r) => [r.date, r]));

  // Traded contract's OWN OI series (symbol + exact expiry month). Empty if the
  // per-expiry table hasn't been backfilled for this contract yet → getDailyContext
  // falls back to the summed-total path and flags it.
  const contractOiByDate = new Map<string, number>();
  if (contractExpiry) {
    const series = await getOptionExpiryOISeries(symbol, contractExpiry, date, days + 5);
    for (const s of series) contractOiByDate.set(s.date, s.optOi);
  }
  const optContractDataAvailable = contractOiByDate.size > 0;

  const allDates = new Set<string>([...futMap.keys(), ...optMap.keys(), ...eqMap.keys(), ...bhavMap.keys()]);
  const windowDates = [...allDates].sort().slice(-days); // oldest first

  const daysArr: DailyContextDay[] = windowDates.map((d) => {
    const f = futMap.get(d);
    const o = optMap.get(d);
    const e = eqMap.get(d);
    const b = bhavMap.get(d);

    const hasBhavFut = (b?.futOi ?? 0) > 0 || (b?.futTurnover ?? 0) > 0;
    const hasBhavOpt = (b?.optOi ?? 0) > 0 || (b?.optVolume ?? 0) > 0;
    const hasDhanEq = Number(e?.turnover ?? 0) > 0;
    const hasBhavEq = (b?.eqTurnover ?? 0) > 0;

    // Futures OI/turnover AND total option OI/volume come ONLY from NSE bhavcopy —
    // totals across all contracts/strikes (see fetchFnOBhavcopy). We deliberately
    // do NOT fall back to Dhan futures: Dhan history is a single contract whose OI
    // ramps with maturity, a different measurement entirely. Days bhavcopy hasn't
    // covered show as a gap (src null) — honest, not distorting. Equity has no
    // contract/expiry, so Dhan equity turnover stays primary.
    return {
      date: d,
      isTradeDate: d === date,
      futOI: hasBhavFut ? (b?.futOi ?? 0) : 0,
      futTurnover: hasBhavFut ? (b?.futTurnover ?? 0) : 0,
      futVolume: Number(f?.volume ?? 0), // Dhan futures volume (shares); not charted, kept for completeness
      optOI: Number(o?.eod_oi ?? 0), // single traded strike (Dhan) — not charted
      optVolume: Number(o?.volume ?? 0), // single traded strike (Dhan) — not charted
      optOITotal: hasBhavOpt ? (b?.optOi ?? 0) : 0,
      optVolumeTotal: hasBhavOpt ? (b?.optVolume ?? 0) : 0,
      // Traded contract's OI (this exact expiry month, bhavcopy per-expiry table).
      // 0 when not backfilled — drives the expiry-safe oi_level when present.
      optContractOI: contractOiByDate.get(d) ?? 0,
      // Official NSE bhavcopy traded value is authoritative; the Σ(5-min vol×close)
      // from Dhan candles is only an approximation, so use it solely as a fallback
      // for days bhavcopy hasn't covered. (Verified equal to ~0.003% on liquid names.)
      eqTurnover: hasBhavEq ? (b?.eqTurnover ?? 0) : Number(e?.turnover ?? 0),
      eqVolume: hasBhavEq ? (b?.eqVolume ?? 0) : Number(e?.volume ?? 0),
      // Underlying price for direction: bhavcopy EOD close is authoritative; fall
      // back to the last equity 5-min bar's close when bhavcopy hasn't covered the day.
      eqClose: (b?.eqClose ?? 0) > 0 ? (b?.eqClose ?? 0) : Number(e?.eod_close ?? 0),
      futClose: Number(f?.eod_close ?? 0),
      optClose: Number(o?.eod_close ?? 0),
      futSrc: hasBhavFut ? 'bhavcopy' : null,
      optSrc: hasBhavOpt ? 'bhavcopy' : null,
      eqSrc: hasBhavEq ? 'bhavcopy' : hasDhanEq ? 'dhan' : null,
    };
  });

  const pct = (from: number, to: number) => (from > 0 ? ((to - from) / from) * 100 : null);
  const tradeIdx = daysArr.findIndex((d) => d.isTradeDate);
  const lastIdx = tradeIdx >= 0 ? tradeIdx : daysArr.length - 1;
  // Change over the LAST 5 sessions ending at the trade day. Full-window first→last
  // is misleading because a contract's OI starts near zero (huge spurious %).
  const kBack = (field: 'optOITotal' | 'futOI', k = 5) => {
    if (lastIdx < 0) return null;
    return pct(daysArr[Math.max(0, lastIdx - k)]?.[field] ?? 0, daysArr[lastIdx]?.[field] ?? 0);
  };
  const prevOptOI = lastIdx > 0 ? daysArr[lastIdx - 1].optOITotal : 0;
  const tradeOptOI = lastIdx >= 0 ? daysArr[lastIdx].optOITotal : 0;
  const futTurnovers = daysArr.filter((d) => d.futTurnover > 0).map((d) => d.futTurnover);
  const avgTurnover = futTurnovers.length ? futTurnovers.reduce((a, b) => a + b, 0) / futTurnovers.length : 0;
  const tradeTurnover = lastIdx >= 0 ? daysArr[lastIdx].futTurnover : 0;

  // TF/R-Factor `oi_level`: trade-day OI ÷ 20-session average (sessions BEFORE the
  // trade day, zero-OI days excluded). The V4 finding: TF top picks sit 25-35%
  // above their 20d average — sustained accumulation that daily change misses.
  const oiLevel20 = (field: 'optOITotal' | 'futOI') => {
    if (lastIdx < 0) return null;
    const prior = daysArr
      .slice(Math.max(0, lastIdx - 20), lastIdx)
      .map((d) => d[field])
      .filter((v) => v > 0);
    if (prior.length < 5) return null; // too little history for a meaningful average
    const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
    const today = daysArr[lastIdx][field];
    return avg > 0 && today > 0 ? today / avg : null;
  };

  // ── Options expiry awareness (authoritative NSE calendar) ──────────────────
  // Total option OI steps DOWN at each MONTHLY expiry — a whole expiry's strikes
  // roll off — so a level-vs-trailing-average that straddles an expiry compares
  // two contract cycles and skews high. The trade day's cycle starts the session
  // AFTER the most recent expiry (exact date from the calendar, not a heuristic).
  // We need ≥5 same-cycle sessions for a meaningful level; right after an expiry
  // there aren't enough → return null (honest) rather than an inflated number.
  const expiriesAsc = await getExpiriesAsc();
  const recentExpiry = mostRecentExpiryBefore(expiriesAsc, date); // ISO or null
  let optCycleStart = 0; // index in daysArr where the trade day's option cycle begins
  let optExpiryInWindow = false;
  if (recentExpiry) {
    const idx = daysArr.findIndex((d) => d.date > recentExpiry);
    if (idx > 0) {
      optCycleStart = idx; // the expiry boundary falls INSIDE the window
      optExpiryInWindow = true;
    }
    // idx === 0 → the whole window is already post-expiry (boundary precedes it)
  }
  const optCycleVals = daysArr
    .slice(optCycleStart, lastIdx)
    .map((d) => d.optOITotal)
    .filter((v) => v > 0);
  const optTradeOi = lastIdx >= 0 ? daysArr[lastIdx].optOITotal : 0;
  const optOILevelCycle =
    optCycleVals.length >= 5 && optTradeOi > 0
      ? optTradeOi / (optCycleVals.reduce((a, b) => a + b, 0) / optCycleVals.length)
      : null;
  // 5-session summed-total change, only when the 5-back session is in the same cycle.
  const optChange5 = lastIdx - 5 >= optCycleStart ? kBack('optOITotal') : null;

  // Traded contract's day-over-day OI change — the clean "fresh positioning into
  // the traded month" signal (both sides are within the current near-month regime).
  // We deliberately do NOT compute a contract level-vs-average: a single contract's
  // OI ramps over its life (far→near month), which would inflate any such ratio.
  const contractTradeOi = lastIdx >= 0 ? daysArr[lastIdx].optContractOI : 0;
  const contractPrevOi = lastIdx > 0 ? daysArr[lastIdx - 1].optContractOI : 0;
  const contractChangeTradeDay =
    optContractDataAvailable && contractTradeOi > 0 ? pct(contractPrevOi, contractTradeOi) : null;

  // ── Price + OI direction (the four-quadrant read) ──────────────────────────
  // Direction comes from PRICE alongside OI, day-over-day (previous session →
  // trade day) — never from OI alone. Underlying price drives the futures
  // quadrant; the traded strike's premium separates option buying from writing.
  const dPrev = lastIdx > 0 ? daysArr[lastIdx - 1] : null;
  const dTrade = lastIdx >= 0 ? daysArr[lastIdx] : null;
  const priceChangePctTradeDay = dPrev && dTrade ? pct(dPrev.eqClose, dTrade.eqClose) : null;
  const futOiChangePctTradeDay = dPrev && dTrade ? pct(dPrev.futOI, dTrade.futOI) : null;
  const optPremChangePctTradeDay = dPrev && dTrade ? pct(dPrev.optClose, dTrade.optClose) : null;
  const optStrikeOiChangePctTradeDay = dPrev && dTrade ? pct(dPrev.optOI, dTrade.optOI) : null;

  const fut = classifyFuturesOI({ priceChangePct: priceChangePctTradeDay, oiChangePct: futOiChangePctTradeDay });
  const optFlow = classifyOptionFlow({
    premiumChangePct: optPremChangePctTradeDay,
    oiChangePct: optStrikeOiChangePctTradeDay,
    optionType,
  });
  const recon = reconcileWithLabel(fut.bias, optionType);

  return {
    optionType,
    strike,
    days: daysArr,
    insight: {
      // 5-session change on the summed total, clipped to the trade day's cycle.
      optOIChangePct: optChange5,
      // Trade-day OI change of the TRADED CONTRACT when we have it (the clean
      // buildup), else the summed-total day-over-day.
      optOIChangePctTradeDay: optContractDataAvailable ? contractChangeTradeDay : pct(prevOptOI, tradeOptOI),
      futOIChangePct: kBack('futOI'),
      turnoverVsAvg: avgTurnover > 0 ? tradeTurnover / avgTurnover : null,
      // Level vs normal = summed total clipped to the current expiry cycle (null
      // right after an expiry — not enough same-cycle sessions yet).
      optOILevel20d: optOILevelCycle,
      futOILevel20d: oiLevel20('futOI'),
      optExpiryInWindow,
      optContractExpiry: optContractDataAvailable ? contractExpiry : null,
      optContractDataAvailable,
      priceChangePctTradeDay,
      futQuadrant: fut.quadrant,
      futBias: fut.bias,
      futQuadrantLabel: fut.label,
      optFlow: optFlow.flow,
      optFlowLabel: optFlow.label,
      directionAgrees: recon.agree,
      directionNote: recon.note,
    },
    calendar: await analyzeWindow(windowDates),
  };
}

/**
 * Get all 5-min equity bars for a stock on a specific date.
 */
async function getEquityBars(
  symbol: string,
  date: string,
): Promise<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }[]> {
  const rows = (await queryRows(
    `
    SELECT timestamp, open, high, low, close, volume
    FROM backtest_equity
    WHERE symbol = ? AND date = ?
    ORDER BY timestamp ASC
  `,
    [symbol, date],
  )) as { timestamp: number; open: number; high: number; low: number; close: number; volume: number }[];
  return rows.map((r) => ({
    timestamp: Number(r.timestamp),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}

/**
 * Get option 5-min bars for a stock on a specific date.
 *
 * `strike` MUST be passed when known: a symbol/date/type can have several
 * downloaded strikes (ATM±3 band), and omitting the filter interleaves their
 * bars — `optionBars[ENTRY_BAR_INDEX]` would then point at the wrong contract.
 */
async function getOptionBars(
  symbol: string,
  optionType: string,
  date: string,
  strike?: number,
): Promise<{ timestamp: number; open: number; high: number; low: number; close: number }[]> {
  const strikeFilter = strike && strike > 0 ? `AND CAST(strike AS REAL) = ?` : '';
  const params = strike && strike > 0 ? [symbol, optionType, date, strike] : [symbol, optionType, date];
  const rows = (await queryRows(
    `
    SELECT timestamp, open, high, low, close
    FROM backtest_options
    WHERE symbol = ? AND option_type = ? AND date = ? ${strikeFilter}
    ORDER BY timestamp ASC
  `,
    params,
  )) as { timestamp: number; open: number; high: number; low: number; close: number }[];
  return rows.map((r) => ({
    timestamp: Number(r.timestamp),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
  }));
}

/**
 * Get all unique symbols that have data.
 */
async function getAvailableSymbols(): Promise<string[]> {
  const rows = (await queryRows(`SELECT DISTINCT symbol FROM backtest_equity`)) as { symbol: string }[];
  return rows.map((r) => r.symbol);
}

/**
 * Compute intraday spread ratio and ADX at a specific bar index.
 */
function computeSignals(
  bars: { timestamp: number; high: number; low: number; close: number }[],
  upToIndex: number,
  avgDailySpread: number,
): { spreadRatio: number; adx: number; plusDI: number; minusDI: number } {
  // Running high/low for the day
  let dayHigh = -Infinity;
  let dayLow = Infinity;
  const adxIndicator = new ADX(7);

  for (let i = 0; i <= upToIndex && i < bars.length; i++) {
    dayHigh = Math.max(dayHigh, bars[i].high);
    dayLow = Math.min(dayLow, bars[i].low);
    adxIndicator.update({ high: bars[i].high, low: bars[i].low, close: bars[i].close }, false);
  }

  const currentClose = bars[upToIndex].close;
  const spreadRaw = currentClose > 0 ? (dayHigh - dayLow) / currentClose : 0;
  const spreadRatio = avgDailySpread > 0 ? spreadRaw / avgDailySpread : 0;

  let adx = 0;
  let plusDI = 0;
  let minusDI = 0;
  try {
    adx = Number(adxIndicator.getResult());
    plusDI = Number(adxIndicator.pdi) * 100;
    minusDI = Number(adxIndicator.mdi) * 100;
  } catch {
    // Not enough data for ADX yet
  }

  return { spreadRatio, adx, plusDI, minusDI };
}

/**
 * Run the full backtest across all 20 TF trades.
 */
export async function runFullBacktest(): Promise<{ results: BacktestResult[]; summary: BacktestSummary }> {
  const results: BacktestResult[] = [];
  const allSymbols = await getAvailableSymbols();

  for (const trade of TF_TRADES) {
    try {
      const result = await evaluateSingleTrade(trade, allSymbols);
      results.push(result);
    } catch (error) {
      console.error(`[Backtest] Error on ${trade.date} ${trade.symbol}:`, error);
      results.push({
        date: trade.date,
        tfStock: trade.symbol,
        tfCePe: trade.optionType,
        tfStrike: trade.strike,
        tfPnl: trade.pnl,
        ourTopStock: '?',
        ourRank: 0,
        ourSpread: 0,
        ourDirection: 'CE',
        ourADX: 0,
        stockMatch: false,
        directionMatch: false,
        tfInTop10: false,
        entryTime: '',
        entryPrice: 0,
        exitTime: '',
        exitPrice: 0,
        exitReason: `Error: ${(error as Error).message}`,
        lotSize: 0,
        grossPnl: 0,
        charges: 0,
        netPnl: 0,
        profitable: false,
      });
    }
  }

  // Compute summary. Risk metrics use only EVALUATED trades (real P&L: had bars
  // AND a resolvable lot size) — never the no-data / lot-unknown placeholders,
  // whose netPnl is a structural 0, not a real flat outcome.
  const evaluated = results.filter((r) => r.lotSize > 0);
  const wins = evaluated.filter((r) => r.netPnl > 0);
  const losses = evaluated.filter((r) => r.netPnl < 0);

  const grossWin = wins.reduce((s, r) => s + r.netPnl, 0);
  const grossLoss = losses.reduce((s, r) => s + r.netPnl, 0); // ≤ 0
  const ourTotalPnl = evaluated.reduce((s, r) => s + r.netPnl, 0);
  const expectancy = evaluated.length > 0 ? ourTotalPnl / evaluated.length : 0;

  // Max drawdown over the cumulative net-P&L curve (trades in TF chronological order).
  let cum = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const r of evaluated) {
    cum += r.netPnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDrawdown) maxDrawdown = peak - cum;
  }

  // Per-trade Sharpe (population std). Not annualized — a trade-set dispersion ratio.
  let sharpe: number | null = null;
  if (evaluated.length > 1) {
    const mean = ourTotalPnl / evaluated.length;
    const variance = evaluated.reduce((s, r) => s + (r.netPnl - mean) ** 2, 0) / evaluated.length;
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? Math.round((mean / std) * 100) / 100 : null;
  }

  const summary: BacktestSummary = {
    totalTrades: results.length,
    evaluatedTrades: evaluated.length,
    stockMatchCount: results.filter((r) => r.stockMatch).length,
    directionMatchCount: results.filter((r) => r.directionMatch).length,
    tfInTop10Count: results.filter((r) => r.tfInTop10).length,
    ourWins: wins.length,
    ourLosses: losses.length,
    ourTotalPnl: Math.round(ourTotalPnl),
    ourAvgWin: wins.length > 0 ? Math.round(grossWin / wins.length) : 0,
    ourAvgLoss: losses.length > 0 ? Math.round(grossLoss / losses.length) : 0,
    ourWinRate: evaluated.length > 0 ? Math.round((wins.length / evaluated.length) * 1000) / 1000 : 0,
    profitFactor: grossLoss < 0 ? Math.round((grossWin / -grossLoss) * 100) / 100 : null,
    expectancy: Math.round(expectancy),
    maxDrawdown: Math.round(maxDrawdown),
    sharpe,
    tfTotalPnl: TF_TRADES.reduce((s, t) => s + t.pnl, 0),
    tfWinRate: TF_TRADES.filter((t) => t.pnl > 0).length / TF_TRADES.length,
  };

  return { results, summary };
}

/**
 * Evaluate a single TF trade date.
 */
async function evaluateSingleTrade(trade: TFTrade, allSymbols: string[]): Promise<BacktestResult> {
  const ENTRY_BAR_INDEX = 6; // 9:45 AM = 6th bar after 9:15 (bars at 9:15, 9:20, 9:25, 9:30, 9:35, 9:40, 9:45)

  // Step 1: Load equity bars for ALL symbols on this date and rank by spread
  const stockSignals: { symbol: string; spreadRatio: number; adx: number; plusDI: number; minusDI: number }[] = [];

  for (const sym of allSymbols) {
    const bars = await getEquityBars(sym, trade.date);
    if (bars.length < ENTRY_BAR_INDEX + 1) continue;

    const avgSpreadHistory = await getDailySpreadHistory(sym, trade.date, 20);
    const avgDailySpread =
      avgSpreadHistory.length > 0 ? avgSpreadHistory.reduce((a, b) => a + b, 0) / avgSpreadHistory.length : 0;

    const signals = computeSignals(bars, ENTRY_BAR_INDEX, avgDailySpread);
    stockSignals.push({ symbol: sym, ...signals });
  }

  // Rank by spread ratio (our R-Factor proxy)
  stockSignals.sort((a, b) => b.spreadRatio - a.spreadRatio);

  const ourTop = stockSignals[0] ?? { symbol: '?', spreadRatio: 0, adx: 0, plusDI: 0, minusDI: 0 };
  const ourDirection: 'CE' | 'PE' = ourTop.plusDI > ourTop.minusDI ? 'CE' : 'PE';
  const tfRank = stockSignals.findIndex((s) => s.symbol === trade.symbol) + 1;
  const tfSignal = stockSignals.find((s) => s.symbol === trade.symbol);

  // Step 2: Load option bars for TF's stock on this date (filtered to the
  // traded strike — a symbol/date can hold several downloaded strikes).
  const optionBars = await getOptionBars(trade.symbol, trade.optionType, trade.date, trade.strike);

  if (optionBars.length < ENTRY_BAR_INDEX + 1) {
    return {
      date: trade.date,
      tfStock: trade.symbol,
      tfCePe: trade.optionType,
      tfStrike: trade.strike,
      tfPnl: trade.pnl,
      ourTopStock: ourTop.symbol,
      ourRank: tfRank,
      ourSpread: ourTop.spreadRatio,
      ourDirection,
      ourADX: ourTop.adx,
      stockMatch: ourTop.symbol === trade.symbol,
      directionMatch: ourDirection === trade.optionType,
      tfInTop10: tfRank > 0 && tfRank <= 10,
      entryTime: '',
      entryPrice: 0,
      exitTime: '',
      exitPrice: 0,
      exitReason: 'No option data for this date',
      lotSize: 0,
      grossPnl: 0,
      charges: 0,
      netPnl: 0,
      profitable: false,
    };
  }

  // Step 3: Entry at the 9:45 bar — we BUY the option (long the premium), so a
  // FALLING option price is a loss regardless of CE/PE.
  const entryBar = optionBars[ENTRY_BAR_INDEX];
  const entryPrice = entryBar.close;

  // Lot size must be REAL — resolve it now (the ₹5,000 profit level needs it).
  // If it can't be resolved we report the trade as not-evaluable rather than
  // inventing a multiplier.
  const lotSize = await resolveLotSize(trade.symbol, trade.date, trade.optionType, trade.strike);
  if (lotSize === null) {
    return {
      date: trade.date,
      tfStock: trade.symbol,
      tfCePe: trade.optionType,
      tfStrike: trade.strike,
      tfPnl: trade.pnl,
      ourTopStock: ourTop.symbol,
      ourRank: tfRank,
      ourSpread: Math.round(ourTop.spreadRatio * 100) / 100,
      ourDirection,
      ourADX: Math.round(ourTop.adx),
      stockMatch: ourTop.symbol === trade.symbol,
      directionMatch: tfSignal ? (tfSignal.plusDI > tfSignal.minusDI ? 'CE' : 'PE') === trade.optionType : false,
      tfInTop10: tfRank > 0 && tfRank <= 10,
      entryTime: formatTime(entryBar.timestamp),
      entryPrice: Math.round(entryPrice * 100) / 100,
      exitTime: '',
      exitPrice: 0,
      exitReason: 'lot size unavailable',
      lotSize: 0,
      grossPnl: 0,
      charges: 0,
      netPnl: 0,
      profitable: false,
    };
  }

  // Exit rules:
  //  • Profit target — FIXED ₹5,000. profitLevel = the option price where our
  //    open profit hits ₹5,000. A candle's real high reaching it means the
  //    market actually traded there, so a sell-limit at that price fills.
  //  • Stop-loss — the PREVIOUS candle's low, trailed UP as the trade moves our
  //    way (a long stop never moves down). The stop level is itself a real
  //    traded price (an actual candle low); on a gap straight through it we
  //    fill no better than that bar's open.
  const PROFIT_TARGET_RUPEES = 5000;
  const profitLevel = entryPrice + PROFIT_TARGET_RUPEES / lotSize;

  // Step 4: Walk forward bar by bar to find the exit.
  let exitPrice = entryPrice;
  let exitTime = entryBar.timestamp;
  let exitReason = 'time-exit';
  let trailStop = optionBars[ENTRY_BAR_INDEX - 1]?.low ?? entryBar.low; // candle before entry

  for (let i = ENTRY_BAR_INDEX + 1; i < optionBars.length; i++) {
    const bar = optionBars[i];

    // Raise the stop to the previous completed candle's low (never lower it).
    trailStop = Math.max(trailStop, optionBars[i - 1].low);

    // Stop-loss checked first (conservative: if a bar could hit both levels,
    // assume the loss). Gap straight through → fill no better than the open.
    if (bar.low <= trailStop) {
      exitPrice = Math.min(trailStop, bar.open);
      exitTime = bar.timestamp;
      exitReason = 'stop-loss';
      break;
    }

    // Fixed ₹5,000 profit reached.
    if (bar.high >= profitLevel) {
      exitPrice = profitLevel;
      exitTime = bar.timestamp;
      exitReason = 'profit-target';
      break;
    }

    // Ran out of bars → exit at the last real close (end of day / data).
    if (i === optionBars.length - 1) {
      exitPrice = bar.close;
      exitTime = bar.timestamp;
      exitReason = 'time-exit';
    }
  }

  // Step 5: Compute P&L (lotSize already resolved above).
  const grossPnl = (exitPrice - entryPrice) * lotSize;
  const charges = calculateOptionCharges({
    numOrders: 2,
    buyTurnover: entryPrice * lotSize,
    sellTurnover: exitPrice * lotSize,
  }).total;
  const netPnl = Math.round(grossPnl - charges);

  return {
    date: trade.date,
    tfStock: trade.symbol,
    tfCePe: trade.optionType,
    tfStrike: trade.strike,
    tfPnl: trade.pnl,
    ourTopStock: ourTop.symbol,
    ourRank: tfRank,
    ourSpread: Math.round(ourTop.spreadRatio * 100) / 100,
    ourDirection,
    ourADX: Math.round(ourTop.adx),
    stockMatch: ourTop.symbol === trade.symbol,
    directionMatch: tfSignal ? (tfSignal.plusDI > tfSignal.minusDI ? 'CE' : 'PE') === trade.optionType : false,
    tfInTop10: tfRank > 0 && tfRank <= 10,
    entryTime: formatTime(entryBar.timestamp),
    entryPrice: Math.round(entryPrice * 100) / 100,
    exitTime: formatTime(exitTime),
    exitPrice: Math.round(exitPrice * 100) / 100,
    exitReason,
    lotSize,
    grossPnl: Math.round(grossPnl),
    charges: Math.round(charges),
    netPnl,
    profitable: netPnl > 0,
  };
}

// ─── Trade Detail API (for real-data backtesting) ────────────────────────────

export interface TradeDetailSignal {
  timestamp: number;
  time: string;
  spreadRatio: number;
  rFactor: number;
  adx: number;
  plusDI: number;
  minusDI: number;
  direction: 'CE' | 'PE';
  isHot: boolean;
  optionClose: number;
  equityClose: number;
}

export interface TradeDetail {
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
  equityBars: { timestamp: number; time: string; open: number; high: number; low: number; close: number }[];
  futuresBars: {
    timestamp: number;
    time: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    oi: number;
  }[];
  signals: TradeDetailSignal[];
  tf: { spotPrice: number | null; pnl: number; strike: number; optionType: string; expiry: string | null };
  estimatedEntry: { barIndex: number; timestamp: number; time: string; optionPrice: number; method: string } | null;
  estimatedExit: { barIndex: number; timestamp: number; time: string; optionPrice: number; method: string } | null;
  pnlCurve: { timestamp: number; time: string; optionPrice: number; pnl: number; pnlPct: number }[];
  lotSize: number;
  symbol: string;
  date: string;
  dataAvailable: boolean;
}

export interface SimulationResult {
  entryPrice: number;
  exitPrice: number;
  lotSize: number;
  grossPnl: number;
  charges: ChargesBreakdown;
  netPnl: number;
  pnlPct: number;
  tfPnl: number;
  pnlDifference: number;
}

/** Get option bars WITH strike filter (fixes existing bug) */
async function getFullOptionBars(symbol: string, optionType: string, strike: number, date: string) {
  const rows = (await queryRows(
    `
    SELECT timestamp, open, high, low, close, volume, oi
    FROM backtest_options
    WHERE symbol = ? AND option_type = ? AND CAST(strike AS REAL) = ? AND date = ?
    ORDER BY timestamp ASC
  `,
    [symbol, optionType, strike, date],
  )) as { timestamp: number; open: number; high: number; low: number; close: number; volume: number; oi: number }[];
  return rows.map((r) => ({
    timestamp: Number(r.timestamp),
    time: formatTime(Number(r.timestamp)),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
    oi: Number(r.oi),
  }));
}

/** Get futures bars with OI */
async function getFullFuturesBars(symbol: string, date: string) {
  const rows = (await queryRows(
    `
    SELECT timestamp, open, high, low, close, volume, oi
    FROM backtest_futures
    WHERE symbol = ? AND date = ?
    ORDER BY timestamp ASC
  `,
    [symbol, date],
  )) as { timestamp: number; open: number; high: number; low: number; close: number; volume: number; oi: number }[];
  return rows.map((r) => ({
    timestamp: Number(r.timestamp),
    time: formatTime(Number(r.timestamp)),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
    oi: Number(r.oi),
  }));
}

/**
 * Resolve the REAL lot size for a symbol, never fabricating one.
 *
 * Priority (most authoritative first):
 *   1. `trade_contracts.fut_lot_size` — the lot size captured at download time
 *      (matches the exact contract the bars came from).
 *   2. `master_contracts` via `batchResolveFutures` — today's live mapping.
 *
 * Returns `null` when neither source has it. Callers must treat `null` as
 * "lot size unknown" and NOT compute a P&L — a guessed lot size would make the
 * P&L unreal.
 */
export async function resolveLotSize(
  symbol: string,
  date?: string,
  optionType?: string,
  strike?: number,
): Promise<number | null> {
  if (date && optionType && strike && strike > 0) {
    try {
      const preserved = await getTradeContract(symbol, date, optionType, strike);
      if (preserved?.futLotSize && preserved.futLotSize > 0) return preserved.futLotSize;
    } catch {
      // fall through to master lookup
    }
  }
  try {
    const map = await batchResolveFutures([symbol]);
    const lot = map.get(symbol)?.lotSize;
    return lot && lot > 0 ? lot : null;
  } catch {
    return null;
  }
}

/**
 * Get full trade detail — bar-by-bar data, signals, P&L curve.
 * This is the core function for the real-data backtest view.
 */
export async function getTradeDetail(params: {
  symbol: string;
  date: string;
  optionType: 'CE' | 'PE';
  strike: number;
  spotPrice?: number | null;
  tfPnl?: number;
  tfExpiry?: string | null;
  // Verified execution data (from broker screenshots)
  tfEntryTime?: string; // "10:17:46 AM"
  tfEntryPrice?: number; // Option premium at entry
  tfExitTime?: string; // "03:25:32 PM"
  tfExitPrice?: number; // Option premium at exit
  tfQuantity?: number;
}): Promise<TradeDetail> {
  const { symbol, date, optionType, strike } = params;

  // Load bars
  const equityBarsRaw = await getEquityBars(symbol, date);
  const optionBarsRaw = await getFullOptionBars(symbol, optionType, strike, date);
  const futuresBarsRaw = await getFullFuturesBars(symbol, date);
  // Real lot size only — 0 signals "unknown" so the rupee P&L stays empty
  // rather than scaling by a guessed multiplier.
  const lotSize = (await resolveLotSize(symbol, date, optionType, strike)) ?? 0;

  const dataAvailable = equityBarsRaw.length > 0 && optionBarsRaw.length > 0;

  // Format equity bars with time
  const equityBars = equityBarsRaw.map((b) => ({ ...b, time: formatTime(b.timestamp) }));

  // Get 20-day spread history for R-Factor baseline
  const avgSpreadHistory = await getDailySpreadHistory(symbol, date, 20);
  const avgDailySpread =
    avgSpreadHistory.length > 0 ? avgSpreadHistory.reduce((a, b) => a + b, 0) / avgSpreadHistory.length : 0;

  // Compute signals at EVERY equity bar
  const signals: TradeDetailSignal[] = [];
  for (let i = 0; i < equityBarsRaw.length; i++) {
    const sig = computeSignals(equityBarsRaw, i, avgDailySpread);
    const rFactor = Math.max(1.0, 1.5596 * sig.spreadRatio);
    const direction: 'CE' | 'PE' = sig.plusDI > sig.minusDI ? 'CE' : 'PE';
    const isHot = rFactor >= 2.0 && sig.adx >= 28;

    // Find matching option bar (closest timestamp)
    const optBar = optionBarsRaw.find((o) => o.timestamp === equityBarsRaw[i].timestamp);

    signals.push({
      timestamp: equityBarsRaw[i].timestamp,
      time: formatTime(equityBarsRaw[i].timestamp),
      spreadRatio: Math.round(sig.spreadRatio * 100) / 100,
      rFactor: Math.round(rFactor * 100) / 100,
      adx: Math.round(sig.adx),
      plusDI: Math.round(sig.plusDI),
      minusDI: Math.round(sig.minusDI),
      direction,
      isHot,
      optionClose: optBar?.close ?? 0,
      equityClose: equityBarsRaw[i].close,
    });
  }

  // Determine entry bar — use verified data if available, else estimate
  let estimatedEntry: TradeDetail['estimatedEntry'] = null;

  if (params.tfEntryTime && params.tfEntryPrice && params.tfEntryPrice > 0) {
    // VERIFIED: find bar by TIME, not by price
    // Parse "10:17:46 AM" → hours:minutes in 24h format
    const entryBarIdx = findBarByTime(optionBarsRaw, params.tfEntryTime);
    const idx = entryBarIdx >= 0 ? entryBarIdx : 0;
    estimatedEntry = {
      barIndex: idx,
      timestamp: optionBarsRaw[idx].timestamp,
      time: formatTime(optionBarsRaw[idx].timestamp),
      optionPrice: params.tfEntryPrice,
      method: `verified (₹${params.tfEntryPrice} @ ${params.tfEntryTime})`,
    };
  } else if (params.spotPrice && params.spotPrice > 0 && equityBarsRaw.length > 0) {
    // ESTIMATED: match equity price to TF's spot_price
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < equityBarsRaw.length; i++) {
      const diff = Math.abs(equityBarsRaw[i].close - params.spotPrice);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    const optBar = optionBarsRaw.find((o) => o.timestamp === equityBarsRaw[bestIdx].timestamp);
    estimatedEntry = {
      barIndex: bestIdx,
      timestamp: equityBarsRaw[bestIdx].timestamp,
      time: formatTime(equityBarsRaw[bestIdx].timestamp),
      optionPrice: optBar?.close ?? 0,
      method: `spot-match (₹${params.spotPrice})`,
    };
  } else if (equityBarsRaw.length > 6) {
    const idx = 6;
    const optBar = optionBarsRaw.find((o) => o.timestamp === equityBarsRaw[idx].timestamp);
    estimatedEntry = {
      barIndex: idx,
      timestamp: equityBarsRaw[idx].timestamp,
      time: formatTime(equityBarsRaw[idx].timestamp),
      optionPrice: optBar?.close ?? 0,
      method: 'default-945',
    };
  }

  // Determine exit bar — use verified data if available, else estimate
  let estimatedExit: TradeDetail['estimatedExit'] = null;

  if (params.tfExitTime && params.tfExitPrice && params.tfExitPrice > 0 && optionBarsRaw.length > 0) {
    // VERIFIED: find bar by TIME
    const exitBarIdx = findBarByTime(optionBarsRaw, params.tfExitTime);
    const idx = exitBarIdx >= 0 ? exitBarIdx : optionBarsRaw.length - 1;
    estimatedExit = {
      barIndex: idx,
      timestamp: optionBarsRaw[idx].timestamp,
      time: formatTime(optionBarsRaw[idx].timestamp),
      optionPrice: params.tfExitPrice,
      method: `verified (₹${params.tfExitPrice} @ ${params.tfExitTime})`,
    };
  } else if (estimatedEntry && params.tfPnl && lotSize > 0 && optionBarsRaw.length > 0) {
    // ESTIMATED: reverse-engineer from P&L
    const entryPrice = estimatedEntry.optionPrice;
    if (entryPrice > 0) {
      const impliedExitPrice = entryPrice + params.tfPnl / lotSize;
      let bestIdx = optionBarsRaw.length - 1;
      let bestDiff = Infinity;
      for (let i = estimatedEntry.barIndex + 1; i < optionBarsRaw.length; i++) {
        const diff = Math.abs(optionBarsRaw[i].close - impliedExitPrice);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = i;
        }
      }
      estimatedExit = {
        barIndex: bestIdx,
        timestamp: optionBarsRaw[bestIdx].timestamp,
        time: formatTime(optionBarsRaw[bestIdx].timestamp),
        optionPrice: optionBarsRaw[bestIdx].close,
        method: `pnl-match (implied ₹${impliedExitPrice.toFixed(1)})`,
      };
    }
  }

  // P&L curve from entry to end of day
  const pnlCurve: TradeDetail['pnlCurve'] = [];
  if (estimatedEntry && estimatedEntry.optionPrice > 0) {
    const entryPrice = estimatedEntry.optionPrice;
    for (let i = estimatedEntry.barIndex; i < optionBarsRaw.length; i++) {
      const price = optionBarsRaw[i].close;
      const pnl = Math.round((price - entryPrice) * lotSize);
      const pnlPct = entryPrice > 0 ? Math.round(((price - entryPrice) / entryPrice) * 10000) / 100 : 0;
      pnlCurve.push({
        timestamp: optionBarsRaw[i].timestamp,
        time: formatTime(optionBarsRaw[i].timestamp),
        optionPrice: price,
        pnl,
        pnlPct,
      });
    }
  }

  return {
    optionBars: optionBarsRaw.map((b) => ({ ...b, time: formatTime(b.timestamp) })),
    equityBars,
    futuresBars: futuresBarsRaw,
    signals,
    tf: {
      spotPrice: params.spotPrice ?? null,
      pnl: params.tfPnl ?? 0,
      strike,
      optionType,
      expiry: params.tfExpiry ?? null,
    },
    estimatedEntry,
    estimatedExit,
    pnlCurve,
    lotSize,
    symbol,
    date,
    dataAvailable,
  };
}

/**
 * Simulate a trade with custom entry/exit timestamps.
 */
export async function simulateTrade(params: {
  symbol: string;
  date: string;
  optionType: 'CE' | 'PE';
  strike: number;
  entryTimestamp: number;
  exitTimestamp: number;
  tfPnl?: number;
}): Promise<SimulationResult> {
  const optBars = await getFullOptionBars(params.symbol, params.optionType, params.strike, params.date);
  const lotSize = (await resolveLotSize(params.symbol, params.date, params.optionType, params.strike)) ?? 0;

  const entryBar = optBars.find((b) => b.timestamp === params.entryTimestamp) ?? optBars[0];
  const exitBar = optBars.find((b) => b.timestamp === params.exitTimestamp) ?? optBars[optBars.length - 1];

  if (!entryBar || !exitBar) {
    return {
      entryPrice: 0,
      exitPrice: 0,
      lotSize,
      grossPnl: 0,
      charges: { brokerage: 0, stt: 0, exchangeTxn: 0, gst: 0, sebi: 0, stampDuty: 0, total: 0 },
      netPnl: 0,
      pnlPct: 0,
      tfPnl: params.tfPnl ?? 0,
      pnlDifference: 0,
    };
  }

  const entryPrice = entryBar.close;
  const exitPrice = exitBar.close;
  const grossPnl = Math.round((exitPrice - entryPrice) * lotSize);
  const charges = calculateOptionCharges({
    numOrders: 2,
    buyTurnover: entryPrice * lotSize,
    sellTurnover: exitPrice * lotSize,
  });
  const netPnl = Math.round(grossPnl - charges.total);
  const pnlPct = entryPrice > 0 ? Math.round(((exitPrice - entryPrice) / entryPrice) * 10000) / 100 : 0;

  return {
    entryPrice,
    exitPrice,
    lotSize,
    grossPnl,
    charges,
    netPnl,
    pnlPct,
    tfPnl: params.tfPnl ?? 0,
    pnlDifference: netPnl - (params.tfPnl ?? 0),
  };
}
