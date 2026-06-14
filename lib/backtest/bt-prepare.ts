/**
 * Backtest preparation — builds the isolated, per-trade `bt_*` copy that the
 * vectorbt engine reads.
 *
 * For each TF trade it:
 *   1. copies the traded option's 5-min bars (trade day) → bt_candle,
 *   2. computes COMBINED-OI signals from bhavcopy_days (futOi / optOi aggregates,
 *      NOT per-strike) plus the price+OI direction quadrant → bt_signal,
 *   3. resolves the real lot size (local resolveLot — no synced-today gate),
 *   4. applies the entry GATE (default: combined OPTION OI ≥ 1.1× 20-day avg;
 *      'pillars' basis additionally requires turnover quality + direction agreement),
 *   5. writes bt_trade / bt_run.
 *
 * Reads only: backtest_options, bhavcopy_days, master_contracts.
 * Writes only: bt_* tables. Nothing existing is modified.
 */

import { prisma } from '@/lib/db';
import {
  classifyFuturesOI,
  classifyOptionFlow,
  reconcileWithLabel,
  type DirectionBias,
  type FuturesQuadrant,
  type OptionFlow,
} from '@/lib/signals/oi-direction';
import { loadAllTFTrades, type TFTrade, downloadOption5min } from './data-downloader';
import { btExecute, btQuery, ensureBtTables, resetBt } from './bt-store';

/** Min relative futures turnover for the 'pillars' gate's quality leg. */
const PILLAR_TURNOVER_MIN = 1.2;

const IST_OFFSET = 5.5 * 3600;
/** Minutes since IST midnight for a unix-seconds timestamp. */
function istMinutes(unix: number): number {
  const d = new Date((unix + IST_OFFSET) * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Parse "10:17:46 AM" / "03:25 PM" → minutes since IST midnight; null if unparseable. */
function parseClockMinutes(s?: string): number | null {
  if (!s) return null;
  const m = s.match(/(\d+):(\d+):?(\d+)?\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[4].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

/** Index of the last bar at/before targetMin (the candle in progress at entry). */
function barAtOrBefore(bars: { timestamp: number }[], targetMin: number): number {
  let idx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (istMinutes(bars[i].timestamp) <= targetMin) idx = i;
    else break;
  }
  return idx;
}

interface OptBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi: number;
}

async function loadOptionBars(t: TFTrade): Promise<OptBar[]> {
  const rows = await prisma.$queryRawUnsafe<OptBar[]>(
    `SELECT timestamp, open, high, low, close, volume, oi
     FROM backtest_options
     WHERE symbol = ? AND option_type = ? AND CAST(strike AS REAL) = ? AND date = ?
     ORDER BY timestamp ASC`,
    t.symbol,
    t.optionType,
    t.strike,
    t.date,
  );
  return rows.map((r) => ({
    timestamp: Number(r.timestamp),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
    oi: Number(r.oi),
  }));
}

interface BhavRow {
  date: string;
  futOi: number;
  optOi: number;
  optVolume: number;
  futTurnover: number;
  futOiChange: number;
  eqClose: number;
}

/** Combined-OI daily series for a symbol up to (and including) the trade day. */
async function loadBhav(symbol: string, date: string): Promise<BhavRow[]> {
  const rows = await prisma.$queryRawUnsafe<BhavRow[]>(
    `SELECT date, futOi, optOi, optVolume, futTurnover, futOiChange, eqClose
     FROM bhavcopy_days
     WHERE symbol = ? AND date <= ?
     ORDER BY date DESC
     LIMIT 21`,
    symbol,
    date,
  );
  return rows.map((r) => ({
    date: r.date,
    futOi: Number(r.futOi),
    optOi: Number(r.optOi),
    optVolume: Number(r.optVolume),
    futTurnover: Number(r.futTurnover),
    futOiChange: Number(r.futOiChange),
    eqClose: Number(r.eqClose),
  }));
}

/**
 * Traded strike's last-two EOD (close, oi) up to the trade day — used to read
 * option FLOW (fresh buying vs writing). Best-effort: only the trade day exists
 * for trades downloaded single-day, in which case flow stays 'flat'.
 */
async function loadOptionEod(t: TFTrade): Promise<{ date: string; close: number; oi: number }[]> {
  const rows = await prisma.$queryRawUnsafe<{ date: string; close: number; oi: number }[]>(
    `SELECT o.date AS date,
       (SELECT close FROM backtest_options c WHERE c.symbol = o.symbol AND c.date = o.date
          AND c.option_type = o.option_type AND CAST(c.strike AS REAL) = ? ORDER BY timestamp DESC LIMIT 1) AS close,
       (SELECT oi FROM backtest_options i WHERE i.symbol = o.symbol AND i.date = o.date
          AND i.option_type = o.option_type AND CAST(i.strike AS REAL) = ? ORDER BY timestamp DESC LIMIT 1) AS oi
     FROM backtest_options o
     WHERE o.symbol = ? AND o.option_type = ? AND CAST(o.strike AS REAL) = ? AND o.date <= ?
     GROUP BY o.date ORDER BY o.date DESC LIMIT 2`,
    t.strike,
    t.strike,
    t.symbol,
    t.optionType,
    t.strike,
    t.date,
  );
  return rows.map((r) => ({ date: r.date, close: Number(r.close), oi: Number(r.oi) }));
}

/**
 * Real lot size, resolved WITHOUT the master_contracts "synced today" gate
 * (this is historical backtest data — a day-old master is fine, and lot sizes
 * are stable facts). Priority: the contract preserved at download time (exact
 * for the trade date) → master_contracts FUTSTK by underlying → OPTSTK by
 * underlying. Returns null only if the symbol has no F&O contract at all.
 */
async function resolveLot(symbol: string, date: string, optionType: string, strike: number): Promise<number | null> {
  const tc = await prisma.$queryRawUnsafe<{ fut_lot_size: number | null }[]>(
    `SELECT fut_lot_size FROM trade_contracts
     WHERE symbol = ? AND date = ? AND option_type = ? AND CAST(strike AS REAL) = ? AND fut_lot_size > 0 LIMIT 1`,
    symbol,
    date,
    optionType,
    strike,
  );
  if (tc[0]?.fut_lot_size && tc[0].fut_lot_size > 0) return Number(tc[0].fut_lot_size);

  // Front-month FUTSTK (then OPTSTK) lot for the underlying. Lot revisions for a
  // handful of stocks mean the front-month lot may differ slightly from the
  // trade-date lot; the preserved contract above is exact when present.
  for (const instrument of ['FUTSTK', 'OPTSTK']) {
    const mc = await prisma.$queryRawUnsafe<{ lotSize: number | null }[]>(
      `SELECT lotSize FROM master_contracts
       WHERE underlying = ? AND instrument = ? AND lotSize > 0 ORDER BY expiryDate ASC LIMIT 1`,
      symbol,
      instrument,
    );
    if (mc[0]?.lotSize && mc[0].lotSize > 0) return Number(mc[0].lotSize);
  }
  return null;
}

interface Signals {
  futOiLevel20: number | null;
  optOiLevel20: number | null;
  futOiChange5: number | null;
  optOiChange5: number | null;
  optVolSurge: number | null;
  turnoverVsAvg: number | null;
  score: number;
  sessions: number;
  /** Price+OI quadrant of the futures (prev session → trade day). */
  futQuadrant: FuturesQuadrant;
  futBias: DirectionBias;
  /** Does the futures bias agree with the trade's CE/PE direction? */
  directionAgrees: boolean;
}

const r2 = (n: number | null): number | null => (n == null ? null : Math.round(n * 100) / 100);

/** Compute combined-OI signals (mirror of the data-downloader "Why this trade" thresholds). */
function computeSignals(rows: BhavRow[], tradeDate: string, optionType: 'CE' | 'PE'): Signals {
  const today = rows.find((r) => r.date === tradeDate) ?? null;
  const prior = rows.filter((r) => r.date < tradeDate); // newest-first, before trade day
  const avg = (vals: number[]) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);
  const level20 = (field: keyof BhavRow): number | null => {
    if (!today) return null;
    const vals = prior.map((r) => Number(r[field])).filter((v) => v > 0);
    if (vals.length < 5) return null; // too little history for a meaningful average
    const a = avg(vals);
    const t = Number(today[field]);
    return a > 0 && t > 0 ? t / a : null;
  };
  const ratioVsAvg = (field: keyof BhavRow): number | null => {
    if (!today) return null;
    const vals = prior.map((r) => Number(r[field])).filter((v) => v > 0);
    const a = avg(vals);
    const t = Number(today[field]);
    return a > 0 && t > 0 ? t / a : null;
  };
  // pct change from 5 sessions before the trade day → trade day
  const change5 = (field: keyof BhavRow): number | null => {
    if (!today) return null;
    const then = prior[4]; // prior[0] is the session right before trade day
    const from = then ? Number(then[field]) : 0;
    const to = Number(today[field]);
    return from > 0 ? ((to - from) / from) * 100 : null;
  };

  const futOiLevel20 = level20('futOi');
  const optOiLevel20 = level20('optOi');
  const futOiChange5 = change5('futOi');
  const optOiChange5 = change5('optOi');
  const optVolSurge = ratioVsAvg('optVolume');
  const turnoverVsAvg = ratioVsAvg('futTurnover');

  // Direction: underlying price + futures OI, day-over-day (prev session → trade
  // day). OI alone is not directional — price tells you which quadrant it is.
  const pct = (from: number, to: number): number | null => (from > 0 ? ((to - from) / from) * 100 : null);
  const prev = prior[0] ?? null; // session immediately before the trade day
  const priceChangePct = today && prev ? pct(prev.eqClose, today.eqClose) : null;
  const futOiChangePctDay = today && prev ? pct(prev.futOi, today.futOi) : null;
  const futClass = classifyFuturesOI({ priceChangePct, oiChangePct: futOiChangePctDay });
  const directionAgrees = reconcileWithLabel(futClass.bias, optionType).agree;

  const bullish = optionType === 'CE';
  let score = 0;
  if (futOiLevel20 != null && futOiLevel20 >= 1.1) score++;
  if (optOiLevel20 != null && optOiLevel20 >= 1.1) score++;
  if (optOiChange5 != null && optOiChange5 > 0) score++;
  if (optVolSurge != null && optVolSurge >= 1.2) score++;
  if (turnoverVsAvg != null && turnoverVsAvg >= 1.2) score++;
  if (futOiChange5 != null && (bullish ? futOiChange5 >= 0 : futOiChange5 <= 0)) score++;

  return {
    futOiLevel20: r2(futOiLevel20),
    optOiLevel20: r2(optOiLevel20),
    futOiChange5: r2(futOiChange5),
    optOiChange5: r2(optOiChange5),
    optVolSurge: r2(optVolSurge),
    turnoverVsAvg: r2(turnoverVsAvg),
    score,
    sessions: rows.length,
    futQuadrant: futClass.quadrant,
    futBias: futClass.bias,
    directionAgrees,
  };
}

export type GateBasis = 'optOi' | 'futOi' | 'score' | 'pillars' | 'none';

export interface PrepareOptions {
  createdAt: string; // ISO timestamp (passed in — Date.now() not available in some contexts)
  /** What the entry gate keys on. Default 'optOi' (combined option OI level). */
  gateBasis?: GateBasis;
  gateThreshold?: number; // OI-level multiple (e.g. 1.1) or, for 'score', a count (e.g. 4)
  profitTarget?: number; // ₹ profit target; default 5000
  entryHHMM?: string; // earliest entry / window start; default "09:45"
  windowEndHHMM?: string; // latest entry / window end; default "11:00"
  /** When true, download the option's trade-day 5-min bars if missing (hits Dhan). */
  download?: boolean;
  /** Explicit trade set. If omitted, loaded from the TF log (see verifiedOnly). */
  trades?: TFTrade[];
  /** When no explicit `trades`: true (default) = only humanReview-verified trades. */
  verifiedOnly?: boolean;
  onProgress?: (msg: string) => void;
}

export interface PrepareResult {
  runId: number;
  trades: number;
  taken: number;
  withCandles: number;
  missingCandles: string[];
  missingBhav: string[];
}

export async function prepareBacktest(opts: PrepareOptions): Promise<PrepareResult> {
  const gateBasis: GateBasis = opts.gateBasis ?? 'optOi';
  const gateThreshold = opts.gateThreshold ?? (gateBasis === 'score' ? 4 : 1.1);
  const profitTarget = opts.profitTarget ?? 5000;
  const entryHHMM = opts.entryHHMM ?? '09:45';
  const log = opts.onProgress ?? (() => {});

  // Default to the human-verified (broker-screenshot) trades — the trustworthy
  // basis — unless an explicit trade set is supplied.
  let trades = opts.trades;
  if (!trades) {
    const all = await loadAllTFTrades();
    trades = opts.verifiedOnly === false ? all.trades : all.trades.filter((t) => t.humanReview);
  }

  const [eh, em] = entryHHMM.split(':').map((x) => parseInt(x, 10));
  const entryTargetMin = eh * 60 + em; // window start (earliest entry)
  const windowEndHHMM = opts.windowEndHHMM ?? '11:00';
  const [weh, wem] = windowEndHHMM.split(':').map((x) => parseInt(x, 10));
  const windowEndMin = weh * 60 + wem; // window end (latest entry)

  await resetBt();
  await ensureBtTables();

  await btExecute(
    `INSERT INTO bt_run (created_at, gate, gate_threshold, profit_target, entry_hhmm, trades, taken)
     VALUES (?, ?, ?, ?, ?, 0, 0)`,
    [opts.createdAt, `${gateBasis}-${gateThreshold}`, gateThreshold, profitTarget, entryHHMM],
  );
  const runRow = await btQuery<{ id: number }>(`SELECT last_insert_rowid() as id`);
  const runId = Number(runRow[0].id);

  const missingCandles: string[] = [];
  const missingBhav: string[] = [];
  let takenCount = 0;
  let withCandles = 0;

  for (const t of trades) {
    const tag = `${t.symbol} ${t.date} ${t.optionType} ${t.strike}`;
    log(`Preparing ${tag}…`);

    // 1. Option 5-min bars for the trade day (the traded strike).
    let bars = await loadOptionBars(t);
    if (bars.length === 0 && opts.download && t.strike > 0) {
      log(`  no candles — downloading ${tag}`);
      try {
        await downloadOption5min(t.symbol, t.optionType, t.strike, t.date, t.date, { spotPrice: t.spotPrice });
        bars = await loadOptionBars(t);
      } catch (e) {
        log(`  download failed: ${(e as Error).message}`);
      }
    }

    // Entry = TF's ACTUAL entry time (real, from the broker-verified log),
    // clamped to the [windowStart, windowEnd] window (default 09:45–11:00).
    // Entering at the forced 09:45 open with a previous-candle-low stop gets
    // stopped out instantly; the real entry is later, once the move is set.
    const rawMin = parseClockMinutes(t.entryTime);
    const targetMin = rawMin != null ? Math.min(Math.max(rawMin, entryTargetMin), windowEndMin) : entryTargetMin;
    let entryBarIndex = barAtOrBefore(bars, targetMin);
    if (entryBarIndex < 1) entryBarIndex = bars.length > 6 ? 6 : -1; // need a prior bar for the stop
    const hasCandles = bars.length > entryBarIndex + 1 && entryBarIndex >= 1;
    if (!hasCandles) missingCandles.push(tag);
    else withCandles++;

    // 2. Combined-OI signals from bhavcopy (+ price+OI direction quadrant).
    const bhav = await loadBhav(t.symbol, t.date);
    if (!bhav.some((r) => r.date === t.date)) missingBhav.push(tag);
    const sig = computeSignals(bhav, t.date, t.optionType);

    // 2b. Traded-strike option flow (writing vs buying), best-effort (needs a
    // prior session in backtest_options; otherwise stays 'flat').
    const optEod = await loadOptionEod(t);
    const oToday = optEod.find((r) => r.date === t.date) ?? null;
    const oPrev = optEod.find((r) => r.date < t.date) ?? null;
    const pctOpt = (from: number, to: number): number | null => (from > 0 ? ((to - from) / from) * 100 : null);
    const optFlow: OptionFlow = classifyOptionFlow({
      premiumChangePct: oToday && oPrev ? pctOpt(oPrev.close, oToday.close) : null,
      oiChangePct: oToday && oPrev ? pctOpt(oPrev.oi, oToday.oi) : null,
      optionType: t.optionType,
    }).flow;

    // 3. Real lot size (no synced-today gate — historical backtest).
    const lotSize = await resolveLot(t.symbol, t.date, t.optionType, t.strike);

    // 4. Entry gate — basis-dependent (default: combined OPTION OI level).
    // 'pillars' = the user's framework: conviction (OI level) + quality (turnover)
    // + direction (futures price+OI agrees with the CE/PE). Spread/urgency is a
    // live-only signal and is deliberately NOT part of the historical gate.
    let taken: boolean;
    if (gateBasis === 'none') taken = true;
    else if (gateBasis === 'score') taken = sig.score >= gateThreshold;
    else if (gateBasis === 'futOi') taken = sig.futOiLevel20 != null && sig.futOiLevel20 >= gateThreshold;
    else if (gateBasis === 'pillars')
      taken =
        sig.optOiLevel20 != null &&
        sig.optOiLevel20 >= gateThreshold &&
        sig.turnoverVsAvg != null &&
        sig.turnoverVsAvg >= PILLAR_TURNOVER_MIN &&
        sig.directionAgrees;
    else taken = sig.optOiLevel20 != null && sig.optOiLevel20 >= gateThreshold; // 'optOi'
    if (taken) takenCount++;

    // 5. Persist bt_trade + bt_candle + bt_signal.
    await btExecute(
      `INSERT INTO bt_trade (run_id, symbol, date, option_type, strike, tf_pnl, lot_size, expiry, entry_bar_index, has_candles, taken)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        t.symbol,
        t.date,
        t.optionType,
        t.strike,
        t.pnl,
        lotSize,
        t.expiry ?? null,
        hasCandles ? entryBarIndex : null,
        hasCandles ? 1 : 0,
        taken ? 1 : 0,
      ],
    );
    const idRow = await btQuery<{ id: number }>(`SELECT last_insert_rowid() as id`);
    const tradeId = Number(idRow[0].id);

    if (hasCandles) {
      // Chunked insert of the per-trade candle copy (9 columns per row).
      const CHUNK = 200;
      for (let i = 0; i < bars.length; i += CHUNK) {
        const slice = bars.slice(i, i + CHUNK);
        const flat: unknown[] = [];
        slice.forEach((b, j) => {
          flat.push(tradeId, i + j, b.timestamp, b.open, b.high, b.low, b.close, b.volume, b.oi);
        });
        await btExecute(
          `INSERT INTO bt_candle (trade_id, bar_index, timestamp, open, high, low, close, volume, oi) VALUES ${slice
            .map(() => `(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .join(',')}`,
          flat,
        );
      }
    }

    await btExecute(
      `INSERT INTO bt_signal (trade_id, fut_oi_level20, opt_oi_level20, fut_oi_change5, opt_oi_change5, opt_vol_surge, turnover_vs_avg, score, sessions, fut_quadrant, fut_bias, opt_flow, direction_agrees)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tradeId,
        sig.futOiLevel20,
        sig.optOiLevel20,
        sig.futOiChange5,
        sig.optOiChange5,
        sig.optVolSurge,
        sig.turnoverVsAvg,
        sig.score,
        sig.sessions,
        sig.futQuadrant,
        sig.futBias,
        optFlow,
        sig.directionAgrees ? 1 : 0,
      ],
    );
  }

  await btExecute(`UPDATE bt_run SET trades = ?, taken = ? WHERE id = ?`, [trades.length, takenCount, runId]);

  return {
    runId,
    trades: trades.length,
    taken: takenCount,
    withCandles,
    missingCandles,
    missingBhav,
  };
}
