import { classifyFuturesOI, type FuturesQuadrant } from '@/lib/signals/oi-direction';

/**
 * Point-in-time signal scanner over the FULL F&O universe (bhavcopy_days).
 *
 * This is the counterpart to the per-trade forensics on /data-downloader. That
 * page looks BACKWARD at trades TradeFinder took (selection-biased by design);
 * this scanner looks FORWARD: it replays every stock, every session, fires the
 * candidate rule on day D using ONLY data available at D's market close, then
 * "trades" the next session (enter at D+1 open, exit at close after the hold).
 *
 * No look-ahead, by construction:
 *  - 20-day baselines average sessions STRICTLY BEFORE the signal day.
 *  - The quadrant uses D-1 → D changes (both known at D's close).
 *  - Nothing from the entry day or later ever feeds the signal.
 *
 * Honesty constraints (mirrors the no-fabricated-data rule):
 *  - Trades the UNDERLYING at official NSE open/close — option premiums are NOT
 *    simulated (no per-strike data for the whole universe).
 *  - A flat per-trade cost approximates brokerage+slippage; the same cost is
 *    charged to the random baseline so the edge comparison stays fair.
 */

export interface ScanParams {
  /** Futures OI must be ≥ this multiple of its 20-session average (TF zone: 1.25+). */
  oiLevelMin: number;
  /** Futures turnover must be ≥ this multiple of its 20-session average. */
  turnoverMin: number;
  /** Which quadrant directions to trade. */
  direction: 'both' | 'long' | 'short';
  /** Also trade the weak quadrants (short-covering / long-unwinding). */
  includeWeak: boolean;
  /** Sessions held: 1 = enter D+1 open, exit D+1 close; 2 = exit D+2 close … */
  holdDays: number;
  /** Round-trip cost in % of position (brokerage + slippage approximation). */
  costPct: number;
}

export const DEFAULT_SCAN_PARAMS: ScanParams = {
  oiLevelMin: 1.25,
  turnoverMin: 1.5,
  direction: 'both',
  includeWeak: false,
  holdDays: 1,
  costPct: 0.1,
};

export interface ScanTrade {
  symbol: string;
  signalDate: string;
  entryDate: string;
  exitDate: string;
  direction: 'long' | 'short';
  quadrant: FuturesQuadrant;
  oiLevel: number;
  turnoverX: number;
  entry: number;
  exit: number;
  grossPct: number;
  netPct: number;
  win: boolean;
  /** Was this symbol in TradeFinder's top-20 R-Factor that day? null = no TF snapshot for the date. */
  tfTop20: boolean | null;
}

export interface BreakdownRow {
  key: string;
  trades: number;
  winRate: number;
  avgNetPct: number;
}

export interface ScanSummary {
  signals: number;
  trades: number;
  /** Signals dropped because the next session was missing or >5 calendar days away. */
  skippedNoEntry: number;
  wins: number;
  winRate: number;
  avgNetPct: number;
  medianNetPct: number;
  totalNetPct: number;
  /** Sum of winning netPct ÷ |sum of losing netPct|. null = no losing trades. */
  profitFactor: number | null;
  maxDrawdownPct: number;
  /** Random baseline: avg gross % of EVERY eligible stock-day, long, same hold. */
  baselineGrossPct: number;
  /** Baseline adjusted for this run's long/short mix, minus the same cost. */
  baselineNetPct: number;
  /** avgNetPct − baselineNetPct: the per-trade edge over a random pick. */
  edgePct: number;
  baselineDays: number;
  /** Trades on days with TF snapshots, and how many of those TF also ranked top-20. */
  tfComparable: number;
  tfMatches: number;
}

export interface ScanCoverage {
  symbols: number;
  sessions: number;
  from: string;
  to: string;
  tfSnapshotDates: number;
}

export interface ScanResult {
  params: ScanParams;
  coverage: ScanCoverage;
  summary: ScanSummary;
  byDirection: BreakdownRow[];
  byQuadrant: BreakdownRow[];
  /** Cumulative net % (equal weight per trade) in entry-date order. */
  curve: { date: string; cum: number }[];
  trades: ScanTrade[];
}

interface DayRow {
  date: string;
  symbol: string;
  eqOpen: number;
  eqClose: number;
  futOi: number;
  futTurnover: number;
}

const BASELINE_WINDOW = 20;
const MIN_HISTORY = 10;
/** Entry must happen within this many calendar days of the signal (else stale). */
const MAX_ENTRY_GAP_DAYS = 5;
const TF_TOP_N = 20;

function pct(from: number, to: number): number | null {
  return from > 0 ? ((to - from) / from) * 100 : null;
}

function calendarDayDiff(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(toISO) - Date.parse(fromISO)) / 86_400_000);
}

function avg(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

function breakdown(trades: ScanTrade[], keyOf: (t: ScanTrade) => string): BreakdownRow[] {
  const groups = new Map<string, ScanTrade[]>();
  for (const t of trades) {
    const k = keyOf(t);
    const g = groups.get(k);
    if (g) g.push(t);
    else groups.set(k, [t]);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      trades: g.length,
      winRate: (g.filter((t) => t.win).length / g.length) * 100,
      avgNetPct: avg(g.map((t) => t.netPct)),
    }))
    .sort((a, b) => b.trades - a.trades);
}

/** Clamp user-supplied params into sane, non-degenerate ranges. */
export function sanitizeScanParams(raw: Partial<ScanParams> | undefined): ScanParams {
  const d = DEFAULT_SCAN_PARAMS;
  const num = (v: unknown, fallback: number, min: number, max: number) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    return Math.min(max, Math.max(min, n));
  };
  const direction = raw?.direction === 'long' || raw?.direction === 'short' ? raw.direction : 'both';
  return {
    oiLevelMin: num(raw?.oiLevelMin, d.oiLevelMin, 1, 5),
    turnoverMin: num(raw?.turnoverMin, d.turnoverMin, 1, 10),
    direction,
    includeWeak: raw?.includeWeak === true,
    holdDays: Math.round(num(raw?.holdDays, d.holdDays, 1, 5)),
    costPct: num(raw?.costPct, d.costPct, 0, 2),
  };
}

/**
 * Run the scan. Loads the full bhavcopy table (~25k rows — fine in memory),
 * walks each symbol's session sequence in date order, and simulates each fired
 * signal as one equal-sized trade on the underlying.
 */
export async function runSignalScan(params: ScanParams): Promise<ScanResult> {
  const { prisma } = await import('@/lib/db');

  const rows = await prisma.$queryRawUnsafe<DayRow[]>(
    `SELECT date, symbol, eqOpen, eqClose, futOi, futTurnover
     FROM bhavcopy_days
     WHERE eqOpen > 0 AND eqClose > 0
     ORDER BY symbol, date`,
  );

  // TradeFinder's actual top-20 per snapshot date (for the overlap check).
  const tfRows = await prisma.$queryRawUnsafe<{ date: string; symbol: string; rFactor: number }[]>(
    `SELECT date, symbol, rFactor FROM tf_snapshots ORDER BY date, rFactor DESC`,
  );
  const tfTopByDate = new Map<string, Set<string>>();
  for (const r of tfRows) {
    let set = tfTopByDate.get(r.date);
    if (!set) {
      set = new Set();
      tfTopByDate.set(r.date, set);
    }
    if (set.size < TF_TOP_N) set.add(r.symbol); // rows arrive rFactor-descending per date
  }

  // Group per symbol — dates are YYYY-MM-DD so string order is chronological.
  const bySymbol = new Map<string, DayRow[]>();
  for (const r of rows) {
    const list = bySymbol.get(r.symbol);
    if (list) list.push(r);
    else bySymbol.set(r.symbol, [r]);
  }

  const allDates = new Set<string>();
  for (const r of rows) allDates.add(r.date);
  const sortedDates = [...allDates].sort();

  const trades: ScanTrade[] = [];
  let signals = 0;
  let skippedNoEntry = 0;

  // Baseline accumulators: every stock-day that COULD have been traded (long,
  // same hold, no signal condition) — what a dart-throwing monkey averages.
  let baselineSum = 0;
  let baselineCount = 0;

  for (const days of bySymbol.values()) {
    for (let i = 1; i < days.length; i++) {
      const entryIdx = i + 1;
      const exitIdx = i + params.holdDays;
      if (exitIdx >= days.length) continue;

      const d = days[i]; // signal day D — all numbers below exist at D's close
      const entryRow = days[entryIdx];
      const exitRow = days[exitIdx];

      // Stale-entry guard: symbol data gaps (left F&O, suspension) make "next
      // session" weeks later — that is not a tradeable signal.
      const tradeable = calendarDayDiff(d.date, entryRow.date) <= MAX_ENTRY_GAP_DAYS;

      if (tradeable) {
        const b = pct(entryRow.eqOpen, exitRow.eqClose);
        if (b != null) {
          baselineSum += b;
          baselineCount++;
        }
      }

      // ── Signal computation (data ≤ day D only) ──────────────────────────
      const prior = days.slice(Math.max(0, i - BASELINE_WINDOW), i);
      const priorOi = prior.map((p) => p.futOi).filter((v) => v > 0);
      const priorTurn = prior.map((p) => p.futTurnover).filter((v) => v > 0);
      if (priorOi.length < MIN_HISTORY || priorTurn.length < MIN_HISTORY) continue;
      if (d.futOi <= 0 || d.futTurnover <= 0) continue;

      const oiLevel = d.futOi / avg(priorOi);
      const turnoverX = d.futTurnover / avg(priorTurn);
      if (oiLevel < params.oiLevelMin || turnoverX < params.turnoverMin) continue;

      const cls = classifyFuturesOI({
        priceChangePct: pct(days[i - 1].eqClose, d.eqClose),
        oiChangePct: pct(days[i - 1].futOi, d.futOi),
      });
      if (cls.bias === 'neutral') continue;
      if (cls.strength === 'weak' && !params.includeWeak) continue;

      const direction: 'long' | 'short' = cls.bias === 'bullish' ? 'long' : 'short';
      if (params.direction !== 'both' && params.direction !== direction) continue;

      signals++;
      if (!tradeable) {
        skippedNoEntry++;
        continue;
      }

      // ── Trade simulation (entry day onward — never feeds the signal) ────
      const entry = entryRow.eqOpen;
      const exit = exitRow.eqClose;
      const grossPct = direction === 'long' ? ((exit - entry) / entry) * 100 : ((entry - exit) / entry) * 100;
      const netPct = grossPct - params.costPct;

      trades.push({
        symbol: d.symbol,
        signalDate: d.date,
        entryDate: entryRow.date,
        exitDate: exitRow.date,
        direction,
        quadrant: cls.quadrant,
        oiLevel,
        turnoverX,
        entry,
        exit,
        grossPct,
        netPct,
        win: netPct > 0,
        tfTop20: tfTopByDate.has(d.date) ? (tfTopByDate.get(d.date)?.has(d.symbol) ?? false) : null,
      });
    }
  }

  trades.sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0));

  // Cumulative curve + max drawdown (equal capital per trade ⇒ % points add).
  const curve: { date: string; cum: number }[] = [];
  let cum = 0;
  let peak = 0;
  let maxDrawdownPct = 0;
  for (const t of trades) {
    cum += t.netPct;
    peak = Math.max(peak, cum);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak - cum);
    curve.push({ date: t.entryDate, cum });
  }

  const wins = trades.filter((t) => t.win).length;
  const nets = trades.map((t) => t.netPct).sort((a, b) => a - b);
  const winSum = trades.filter((t) => t.netPct > 0).reduce((s, t) => s + t.netPct, 0);
  const lossSum = trades.filter((t) => t.netPct < 0).reduce((s, t) => s + t.netPct, 0);

  const baselineGrossPct = baselineCount > 0 ? baselineSum / baselineCount : 0;
  // A random LONG pick averages the baseline; a random SHORT pick averages its
  // mirror. Weight by this run's actual direction mix, charge the same cost.
  const nLong = trades.filter((t) => t.direction === 'long').length;
  const nShort = trades.length - nLong;
  const mixedBaselineGross =
    trades.length > 0 ? (nLong * baselineGrossPct + nShort * -baselineGrossPct) / trades.length : 0;
  const baselineNetPct = mixedBaselineGross - params.costPct;

  const avgNetPct = trades.length > 0 ? avg(trades.map((t) => t.netPct)) : 0;
  const tfComparable = trades.filter((t) => t.tfTop20 != null).length;
  const tfMatches = trades.filter((t) => t.tfTop20 === true).length;

  return {
    params,
    coverage: {
      symbols: bySymbol.size,
      sessions: sortedDates.length,
      from: sortedDates[0] ?? '',
      to: sortedDates[sortedDates.length - 1] ?? '',
      tfSnapshotDates: tfTopByDate.size,
    },
    summary: {
      signals,
      trades: trades.length,
      skippedNoEntry,
      wins,
      winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      avgNetPct,
      medianNetPct: median(nets),
      totalNetPct: cum,
      profitFactor: lossSum < 0 ? winSum / -lossSum : null,
      maxDrawdownPct,
      baselineGrossPct,
      baselineNetPct,
      edgePct: trades.length > 0 ? avgNetPct - baselineNetPct : 0,
      baselineDays: baselineCount,
      tfComparable,
      tfMatches,
    },
    byDirection: breakdown(trades, (t) => t.direction),
    byQuadrant: breakdown(trades, (t) => t.quadrant),
    curve,
    trades,
  };
}
