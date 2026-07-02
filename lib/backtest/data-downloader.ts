/**
 * Backtest Data Downloader
 *
 * Downloads 5-min OHLCV data from Dhan APIs and stores in DuckDB.
 * Supports: equity, futures (with OI), and rolling options (with IV/OI/spot).
 *
 * Rate limits: 4 req/sec (250ms between calls).
 */

import { dhanRequest } from '@/lib/dhan/rate-limiter';
import {
  batchResolveFutures,
  getStrikeStep,
  nearestStrike,
  resolveOptionSecurity,
  resolveSymbol,
} from '@/lib/historify/master-contracts';
import { checkpoint, execute } from './backtest-store';

/**
 * Convert Unix timestamp to IST date string (YYYY-MM-DD).
 * Dhan intraday API returns Unix timestamps (seconds since 1970).
 */
function unixToISTDate(unix: number): string {
  const istMs = (unix + 5.5 * 3600) * 1000;
  return new Date(istMs).toISOString().split('T')[0];
}

/**
 * Download equity 5-min OHLCV for a stock.
 * Uses /v2/charts/intraday endpoint.
 */
export async function downloadEquity5min(
  symbol: string,
  fromDate: string,
  toDate: string,
  opts?: { securityId?: string },
): Promise<{ rows: number; error?: string; securityId?: string }> {
  try {
    // Preserved contract ID (from trade_contracts) skips master resolution —
    // equity IDs are stable, and this keeps re-syncs independent of master churn.
    let securityId = opts?.securityId;
    if (!securityId) {
      const entry = await resolveSymbol(symbol, 'NSE');
      if (!entry) return { rows: 0, error: `Symbol not found: ${symbol}` };
      securityId = entry.securityId;
    }

    const data = (await dhanRequest('/v2/charts/intraday', {
      securityId,
      exchangeSegment: 'NSE_EQ',
      instrument: 'EQUITY',
      interval: '5',
      fromDate,
      toDate,
    })) as {
      open?: number[];
      high?: number[];
      low?: number[];
      close?: number[];
      volume?: number[];
      timestamp?: number[];
    };

    if (!data.open || data.open.length === 0) return { rows: 0, error: 'No data returned' };

    const n = data.open.length;
    const values: string[] = [];
    const esc = (s: string) => s.replace(/'/g, "''");
    for (let i = 0; i < n; i++) {
      const ts = data.timestamp?.[i] ?? 0;
      const unix = ts;
      const date = unixToISTDate(unix);
      values.push(
        `('${esc(symbol)}', '${date}', ${unix}, ${data.open[i]}, ${data.high![i]}, ${data.low![i]}, ${data.close![i]}, ${data.volume?.[i] ?? 0})`,
      );
    }

    // Insert in chunks
    for (let i = 0; i < values.length; i += 500) {
      const chunk = values.slice(i, i + 500).join(',');
      await execute(`INSERT OR IGNORE INTO backtest_equity VALUES ${chunk}`);
    }

    return { rows: n, securityId };
  } catch (error) {
    return { rows: 0, error: (error as Error).message };
  }
}

/**
 * Download futures 5-min OHLCV + OI for a stock.
 */
export async function downloadFutures5min(
  symbol: string,
  fromDate: string,
  toDate: string,
  opts?: { securityId?: string; expiry?: string; lotSize?: number },
): Promise<{ rows: number; error?: string; securityId?: string; expiry?: string; lotSize?: number }> {
  try {
    // Preserved contract first — the exact contract that backed this trade,
    // valid even after it drops out of the (today-only) master.
    let fut = opts?.securityId
      ? { securityId: opts.securityId, expiryDate: opts.expiry ?? '', lotSize: opts.lotSize ?? 0 }
      : undefined;
    if (!fut) {
      const futMap = await batchResolveFutures([symbol], toDate);
      fut = futMap.get(symbol);
    }
    if (!fut) return { rows: 0, error: `Futures not found: ${symbol}` };

    const data = (await dhanRequest('/v2/charts/intraday', {
      securityId: fut.securityId,
      exchangeSegment: 'NSE_FNO',
      instrument: 'FUTSTK',
      interval: '5',
      oi: true,
      fromDate,
      toDate,
    })) as {
      open?: number[];
      high?: number[];
      low?: number[];
      close?: number[];
      volume?: number[];
      timestamp?: number[];
      open_interest?: number[];
    };

    if (!data.open || data.open.length === 0) return { rows: 0, error: 'No data returned' };

    const n = data.open.length;
    const values: string[] = [];
    const esc = (s: string) => s.replace(/'/g, "''");
    for (let i = 0; i < n; i++) {
      const ts = data.timestamp?.[i] ?? 0;
      const unix = ts;
      const date = unixToISTDate(unix);
      values.push(
        `('${esc(symbol)}', '${date}', ${unix}, ${data.open[i]}, ${data.high![i]}, ${data.low![i]}, ${data.close![i]}, ${data.volume?.[i] ?? 0}, ${data.open_interest?.[i] ?? 0})`,
      );
    }

    for (let i = 0; i < values.length; i += 500) {
      const chunk = values.slice(i, i + 500).join(',');
      await execute(`INSERT OR IGNORE INTO backtest_futures VALUES ${chunk}`);
    }

    return { rows: n, securityId: fut.securityId, expiry: fut.expiryDate, lotSize: fut.lotSize };
  } catch (error) {
    return { rows: 0, error: (error as Error).message };
  }
}

/**
 * Download option 5-min data (CE or PE at a given strike).
 *
 * Primary path: /v2/charts/intraday using the option contract's securityId from
 * master_contracts (works for live / not-yet-expired contracts).
 *
 * Fallback path: if the contract is no longer in master_contracts (dropped after
 * expiry) OR intraday returns no candles, fall back to /v2/charts/rollingoption,
 * which serves EXPIRED-contract data keyed by the underlying + ATM-relative strike.
 * `opts.spotPrice` (the spot at trade time) sharpens the ATM-relative mapping.
 */
export async function downloadOption5min(
  symbol: string,
  optionType: 'CE' | 'PE',
  strike: number,
  fromDate: string,
  toDate: string,
  opts?: { spotPrice?: number; securityId?: string },
): Promise<{ rows: number; error?: string; via?: string; securityId?: string }> {
  try {
    // If strike is 0, resolve ATM from equity spot (use last known close)
    let targetStrike = strike;
    if (targetStrike === 0) {
      // Get equity data to find approximate spot
      const eqEntry = await resolveSymbol(symbol, 'NSE');
      if (!eqEntry) return { rows: 0, error: `Symbol not found: ${symbol}` };
      const step = getStrikeStep(symbol);
      // Use a reasonable default — caller should provide actual strike
      targetStrike = nearestStrike(opts?.spotPrice || strike || 1000, step);
    }

    // Preserved contract first; else resolve from master_contracts DB.
    let optionId = opts?.securityId;
    if (!optionId) {
      const option = await resolveOptionSecurity(symbol, targetStrike, optionType, 0, toDate);
      if (!option) {
        // Contract not in master (most likely expired & dropped) — use rollingoption.
        return downloadExpiredOption5min(symbol, optionType, targetStrike, fromDate, toDate, opts?.spotPrice);
      }
      optionId = option.securityId;
    }

    const data = (await dhanRequest('/v2/charts/intraday', {
      securityId: optionId,
      exchangeSegment: 'NSE_FNO',
      instrument: 'OPTSTK',
      interval: '5',
      oi: true,
      fromDate,
      toDate,
    })) as {
      open?: number[];
      high?: number[];
      low?: number[];
      close?: number[];
      volume?: number[];
      timestamp?: number[];
      open_interest?: number[];
    };

    if (!data.open || data.open.length === 0) {
      // Active-contract intraday returned nothing — likely expired. Try rollingoption.
      return downloadExpiredOption5min(symbol, optionType, targetStrike, fromDate, toDate, opts?.spotPrice);
    }

    const n = data.open.length;
    const values: string[] = [];
    const esc = (s: string) => s.replace(/'/g, "''");
    for (let i = 0; i < n; i++) {
      const unix = data.timestamp?.[i] ?? 0;
      const date = unixToISTDate(unix);
      values.push(
        `('${esc(symbol)}', '${date}', ${unix}, '${optionType}', ${targetStrike}, ${data.open[i]}, ${data.high![i]}, ${data.low![i]}, ${data.close![i]}, ${data.volume?.[i] ?? 0}, ${data.open_interest?.[i] ?? 0}, 0, 0)`,
      );
    }

    for (let i = 0; i < values.length; i += 500) {
      const chunk = values.slice(i, i + 500).join(',');
      await execute(`INSERT OR IGNORE INTO backtest_options VALUES ${chunk}`);
    }

    return { rows: n, via: 'intraday', securityId: optionId };
  } catch (error) {
    return { rows: 0, error: (error as Error).message };
  }
}

/** Dhan rollingoption per-side payload — parallel arrays (one entry per 5-min bar). */
interface OptionChartPayload {
  open?: number[];
  high?: number[];
  low?: number[];
  close?: number[];
  volume?: number[];
  oi?: number[];
  iv?: number[];
  strike?: number[];
  spot?: number[];
  timestamp?: number[];
}

/**
 * Download EXPIRED option 5-min data via /v2/charts/rollingoption.
 *
 * The intraday endpoint does not serve expired contracts; rollingoption does.
 * It is keyed by the UNDERLYING securityId + an ATM-relative strike band + a
 * relative monthly expiry code (1=nearest, 2, 3) + CALL/PUT — so it sidesteps
 * resolving a per-strike securityId that has been dropped from master_contracts.
 *
 * We request a band around ATM (sharpened by `spotPrice` when known), keep only
 * the rows whose absolute strike matches the traded strike, and try expiryCode
 * 1→3, stopping at the first that yields rows for the target strike. The exact
 * strike returned in each row (requiredData includes "strike") makes the band
 * choice self-correcting — a too-wide band is simply filtered down.
 */
export async function downloadExpiredOption5min(
  symbol: string,
  optionType: 'CE' | 'PE',
  strike: number,
  fromDate: string,
  toDate: string,
  spotPrice?: number,
): Promise<{ rows: number; error?: string; via?: string }> {
  try {
    const eq = await resolveSymbol(symbol, 'NSE');
    if (!eq) return { rows: 0, error: `Underlying not found: ${symbol}` };
    const underlyingId = Number(eq.securityId);

    // ATM-relative band. TF trades are typically at/near ATM, so default to "ATM".
    // When the spot at trade time is known, widen just enough to cover the strike.
    // (Dhan stock options support up to ±3 strikes around ATM per request.)
    let strikeParam = 'ATM';
    if (spotPrice && spotPrice > 0) {
      const step = getStrikeStep(symbol);
      const atm = nearestStrike(spotPrice, step);
      const offset = step > 0 ? Math.abs(Math.round((strike - atm) / step)) : 0;
      const band = Math.min(3, offset);
      if (band > 0) strikeParam = `ATM-${band}~${band}`;
    } else {
      // Spot unknown — request the widest stock band and filter by exact strike.
      strikeParam = 'ATM-3~3';
    }

    const drv = optionType === 'CE' ? 'CALL' : 'PUT';
    const payloadKey = optionType === 'CE' ? 'ce' : 'pe';
    const esc = (s: string) => s.replace(/'/g, "''");

    for (const expiryCode of [1, 2, 3]) {
      const resp = (await dhanRequest('/v2/charts/rollingoption', {
        securityId: underlyingId,
        exchangeSegment: 'NSE_FNO',
        instrument: 'OPTSTK',
        expiryFlag: 'MONTH',
        expiryCode,
        strike: strikeParam,
        drvOptionType: drv,
        requiredData: ['open', 'high', 'low', 'close', 'iv', 'volume', 'strike', 'oi', 'spot'],
        fromDate,
        toDate,
        interval: '5',
      })) as { data?: { ce?: OptionChartPayload; pe?: OptionChartPayload } };

      const p = resp?.data?.[payloadKey];
      if (!p?.timestamp || p.timestamp.length === 0) continue;

      const values: string[] = [];
      for (let i = 0; i < p.timestamp.length; i++) {
        // Keep only rows matching the traded absolute strike.
        if (Math.round(p.strike?.[i] ?? 0) !== Math.round(strike)) continue;
        const unix = p.timestamp[i];
        const date = unixToISTDate(unix);
        values.push(
          `('${esc(symbol)}', '${date}', ${unix}, '${optionType}', ${strike}, ${p.open?.[i] ?? 0}, ${p.high?.[i] ?? 0}, ${p.low?.[i] ?? 0}, ${p.close?.[i] ?? 0}, ${p.volume?.[i] ?? 0}, ${p.oi?.[i] ?? 0}, ${p.iv?.[i] ?? 0}, ${p.spot?.[i] ?? 0})`,
        );
      }
      if (values.length === 0) continue;

      for (let i = 0; i < values.length; i += 500) {
        const chunk = values.slice(i, i + 500).join(',');
        await execute(`INSERT OR IGNORE INTO backtest_options VALUES ${chunk}`);
      }
      return { rows: values.length, via: `rollingoption(expiry=${expiryCode},strike=${strikeParam})` };
    }

    return {
      rows: 0,
      error: `No expired-option data for ${symbol} ${strike}${optionType} (rollingoption, tried expiryCode 1-3, strike=${strikeParam})`,
    };
  } catch (error) {
    return { rows: 0, error: (error as Error).message };
  }
}

/** TF trade definition for downloading */
export interface TFTrade {
  date: string; // YYYY-MM-DD
  symbol: string;
  optionType: 'CE' | 'PE';
  strike: number;
  pnl: number;
  // Verified execution details (optional — user provides from broker screenshots)
  entryTime?: string; // "10:17:46 AM"
  entryPrice?: number; // Option premium at entry
  exitTime?: string; // "03:25:32 PM"
  exitPrice?: number; // Option premium at exit
  quantity?: number; // Lots × lotSize
  capitalUsed?: number; // Entry premium × quantity
  spotPrice?: number;
  expiry?: string;
  humanReview?: boolean; // True when verified from broker screenshots
}

/**
 * Load ALL trades from tradefinder_platform_trades.json.
 * Returns unique stocks with their earliest/latest trade dates.
 */
export async function loadAllTFTrades(): Promise<{
  trades: TFTrade[];
  symbols: string[];
  dateRange: { from: string; to: string };
}> {
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');
  // The trade log lives in data/ in this project; fall back to the project root.
  const candidates = [
    path.join(process.cwd(), 'data', 'tradefinder_platform_trades.json'),
    path.join(process.cwd(), 'tradefinder_platform_trades.json'),
  ];
  let filePath = candidates[0];
  for (const c of candidates) {
    try {
      await fs.access(c);
      filePath = c;
      break;
    } catch {
      // try next candidate
    }
  }
  const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));

  const trades: TFTrade[] = [];
  for (const t of raw.trades) {
    if (t.trade_status !== 'Trade Taken' || !t.stock_name) continue;
    // Parse date "17 Mar 2026" → "2026-03-17" (IST-safe)
    try {
      const match = t.trade_date.match(/(\d+)\s(\w+)\s(\d+)/);
      if (!match) continue;
      const months: Record<string, string> = {
        Jan: '01',
        Feb: '02',
        Mar: '03',
        Apr: '04',
        May: '05',
        Jun: '06',
        Jul: '07',
        Aug: '08',
        Sep: '09',
        Oct: '10',
        Nov: '11',
        Dec: '12',
      };
      const day = match[1].padStart(2, '0');
      const mon = months[match[2]] ?? '01';
      const year = match[3];
      const dateStr = `${year}-${mon}-${day}`;
      const d = new Date(`${dateStr}T00:00:00`);
      if (Number.isNaN(d.getTime())) continue;
      trades.push({
        date: dateStr, 
        symbol: t.stock_name,
        optionType: t.instrument_type ?? 'CE',
        strike: t.strike_price ?? 0,
        pnl: t.total_pnl ?? 0,
        entryTime: t.entry_time ?? undefined,
        entryPrice: t.entry_price ?? undefined,
        exitTime: t.exit_time ?? undefined,
        exitPrice: t.exit_price ?? undefined,
        quantity: t.quantity ?? undefined,
        capitalUsed: t.capital_used ?? undefined,
        spotPrice: t.spot_price ?? undefined,
        expiry: t.expiry_date ?? undefined,
        humanReview: t.humanReview ?? false,
      });
    } catch {}
  }

  const symbols = [...new Set(trades.map((t) => t.symbol))].sort();
  const dates = trades.map((t) => t.date).sort();

  return {
    trades,
    symbols,
    dateRange: { from: dates[0] ?? '', to: dates[dates.length - 1] ?? '' },
  };
}

/**
 * The set of option contracts the TF trades actually reference, as
 * `${symbol}|${optionType}|${strike}` keys. The bhavcopy sync uses this to capture
 * ONLY these strikes' daily close/OI (so the data-downloader's option-flow read
 * works from bhavcopy, no Dhan download) — keeping `bhavcopy_option_strike` small.
 */
export async function tradedStrikeKeys(): Promise<Set<string>> {
  const { trades } = await loadAllTFTrades();
  const keys = new Set<string>();
  for (const t of trades) {
    if (t.strike > 0) keys.add(`${t.symbol}|${t.optionType}|${t.strike}`);
  }
  return keys;
}

/**
 * Download data for specific symbols (not just the hardcoded 20).
 * Downloads equity + futures 5-min. Options only if strike is provided.
 */
export async function downloadSymbols(
  symbols: string[],
  fromDate: string,
  toDate: string,
  includeOptions: { symbol: string; optionType: 'CE' | 'PE'; strike: number; spotPrice?: number }[] = [],
  onProgress?: (msg: string) => void,
): Promise<{ total: number; errors: string[] }> {
  const errors: string[] = [];
  let total = 0;
  const log = onProgress ?? console.log;

  for (const sym of symbols) {
    // Skip index symbols (NIFTY, BANKNIFTY)
    if (sym === 'NIFTY' || sym === 'BANKNIFTY') {
      log(`[${sym}] Skipping index symbol`);
      continue;
    }

    log(`[${sym}] Equity 5-min...`);
    const eq = await downloadEquity5min(sym, fromDate, toDate);
    if (eq.error) errors.push(`${sym} equity: ${eq.error}`);
    else total += eq.rows;
    log(`[${sym}] Equity: ${eq.rows} rows${eq.error ? ` (ERROR: ${eq.error})` : ''}`);

    log(`[${sym}] Futures 5-min...`);
    const fut = await downloadFutures5min(sym, fromDate, toDate);
    if (fut.error) errors.push(`${sym} futures: ${fut.error}`);
    else total += fut.rows;
    log(`[${sym}] Futures: ${fut.rows} rows${fut.error ? ` (ERROR: ${fut.error})` : ''}`);

    // Options if specified
    const optTrade = includeOptions.find((o) => o.symbol === sym);
    if (optTrade && optTrade.strike > 0) {
      log(`[${sym}] Option ${optTrade.optionType} ${optTrade.strike}...`);
      const opt = await downloadOption5min(sym, optTrade.optionType, optTrade.strike, fromDate, toDate, {
        spotPrice: optTrade.spotPrice,
      });
      if (opt.error) errors.push(`${sym} option: ${opt.error}`);
      else total += opt.rows;
      log(
        `[${sym}] Option: ${opt.rows} rows${opt.via ? ` via ${opt.via}` : ''}${opt.error ? ` (ERROR: ${opt.error})` : ''}`,
      );
    }
  }

  await checkpoint();
  log(`\nDone: ${total} rows, ${errors.length} errors`);
  return { total, errors };
}

/** The last 20 TF trades from tradefinder_platform_trades.json */
export const TF_TRADES: TFTrade[] = [
  { date: '2026-03-17', symbol: 'NATIONALUM', optionType: 'CE', strike: 390, pnl: 20250 },
  { date: '2026-03-16', symbol: 'BANDHANBNK', optionType: 'PE', strike: 170, pnl: 15120 },
  { date: '2026-03-13', symbol: 'JINDALSTEL', optionType: 'PE', strike: 1150, pnl: 18750 },
  { date: '2026-03-11', symbol: 'COLPAL', optionType: 'PE', strike: 2000, pnl: -2936 },
  { date: '2026-03-10', symbol: 'HAVELLS', optionType: 'CE', strike: 1400, pnl: 16500 },
  { date: '2026-03-09', symbol: 'ONGC', optionType: 'PE', strike: 280, pnl: 16425 },
  { date: '2026-03-05', symbol: 'MAZDOCK', optionType: 'CE', strike: 2300, pnl: 21930 },
  { date: '2026-03-04', symbol: 'TATASTEEL', optionType: 'PE', strike: 190, pnl: 17160 },
  { date: '2026-02-27', symbol: 'HDFCLIFE', optionType: 'PE', strike: 720, pnl: 18920 },
  { date: '2026-02-26', symbol: 'LAURUSLABS', optionType: 'CE', strike: 1100, pnl: -2550 },
  { date: '2026-02-24', symbol: 'PERSISTENT', optionType: 'PE', strike: 4600, pnl: 20050 },
  { date: '2026-02-23', symbol: 'KPITTECH', optionType: 'PE', strike: 800, pnl: 14110 },
  { date: '2026-02-20', symbol: 'ABB', optionType: 'CE', strike: 6000, pnl: 23875 },
  { date: '2026-02-19', symbol: 'PERSISTENT', optionType: 'PE', strike: 5400, pnl: 17400 },
  { date: '2026-02-18', symbol: 'DIXON', optionType: 'PE', strike: 11200, pnl: -2465 },
  { date: '2026-02-17', symbol: 'BANKBARODA', optionType: 'CE', strike: 300, pnl: 19013 },
  { date: '2026-02-16', symbol: 'POWERGRID', optionType: 'CE', strike: 295, pnl: 17100 },
  { date: '2026-02-13', symbol: 'ADANIGREEN', optionType: 'PE', strike: 960, pnl: 16410 },
  { date: '2026-02-12', symbol: 'KPITTECH', optionType: 'PE', strike: 920, pnl: 15725 },
  { date: '2026-02-11', symbol: 'LAURUSLABS', optionType: 'CE', strike: 1100, pnl: 18785 },
];

/**
 * Download all data for TF's last 20 trades.
 * For each trade: equity + futures + ATM option 5-min data.
 * Downloads 25 trading days before the trade date for R-Factor baseline.
 */
export async function downloadAllTFData(
  onProgress?: (msg: string) => void,
): Promise<{ total: number; errors: string[] }> {
  const errors: string[] = [];
  let total = 0;

  // Get unique symbols
  const symbols = [...new Set(TF_TRADES.map((t) => t.symbol))];
  const log = onProgress ?? console.log;

  // Global date range: earliest trade - 35 days → latest trade
  const earliest = TF_TRADES.reduce((a, b) => (a.date < b.date ? a : b)).date;
  const latest = TF_TRADES.reduce((a, b) => (a.date > b.date ? a : b)).date;

  // 35 trading days before earliest trade for R-Factor lookback
  const fromDate = new Date(earliest);
  fromDate.setDate(fromDate.getDate() - 50); // ~50 calendar days = ~35 trading days
  const fromDateStr = fromDate.toISOString().split('T')[0];

  log(`Downloading data for ${symbols.length} unique symbols`);
  log(`Date range: ${fromDateStr} → ${latest}`);

  for (const sym of symbols) {
    // 1. Equity 5-min
    log(`[${sym}] Downloading equity 5-min...`);
    const eq = await downloadEquity5min(sym, fromDateStr, latest);
    if (eq.error) errors.push(`${sym} equity: ${eq.error}`);
    else total += eq.rows;
    log(`[${sym}] Equity: ${eq.rows} rows ${eq.error ? `(ERROR: ${eq.error})` : ''}`);

    // 2. Futures 5-min
    log(`[${sym}] Downloading futures 5-min...`);
    const fut = await downloadFutures5min(sym, fromDateStr, latest);
    if (fut.error) errors.push(`${sym} futures: ${fut.error}`);
    else total += fut.rows;
    log(`[${sym}] Futures: ${fut.rows} rows ${fut.error ? `(ERROR: ${fut.error})` : ''}`);

    // 3. Rolling option (CE or PE matching TF's trade)
    const tfTrades = TF_TRADES.filter((t) => t.symbol === sym);
    for (const trade of tfTrades) {
      log(`[${sym}] Downloading ${trade.optionType} ${trade.strike} option (${trade.date})...`);
      const opt = await downloadOption5min(sym, trade.optionType, trade.strike, fromDateStr, latest, {
        spotPrice: trade.spotPrice,
      });
      if (opt.error) errors.push(`${sym} ${trade.optionType}: ${opt.error}`);
      else total += opt.rows;
      log(
        `[${sym}] Option ${trade.optionType} ${trade.strike}: ${opt.rows} rows ${opt.via ? `via ${opt.via} ` : ''}${opt.error ? `(ERROR: ${opt.error})` : ''}`,
      );
      break; // One option type per symbol is enough
    }
  }

  // Flush WAL to main file so other connections can read the data
  await checkpoint();
  log(`\nDownload complete: ${total} total rows, ${errors.length} errors`);
  return { total, errors };
}
