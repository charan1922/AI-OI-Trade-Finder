/**
 * Trade-data access layer for the assistant's tools. Every number the bot can cite
 * comes from here — and here it comes ONLY from our validated pipeline
 * (loadAllTFTrades + getDailyContext), never from the model. No fabrication.
 */

import { getDailyContext } from '@/lib/backtest/backtest-evaluator';
import { loadAllTFTrades, type TFTrade } from '@/lib/backtest/data-downloader';

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** Accepts "2026-05-29" or "29 May 2026" → "2026-05-29" (or returns input if unmatched). */
function normalizeDate(raw: string): string {
  const s = (raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})$/);
  if (m) {
    const mm = MONTHS[m[2].toLowerCase()];
    if (mm) return `${m[3]}-${mm}-${m[1].padStart(2, '0')}`;
  }
  return s;
}

const round = (v: number | null | undefined, d = 2) =>
  v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d));

export interface ListTradesArgs {
  verifiedOnly?: boolean;
  search?: string;
  limit?: number;
}

/** Compact list of trades for "which/list/compare" questions. */
export async function listTrades(args: ListTradesArgs) {
  const { trades } = await loadAllTFTrades();
  let list: TFTrade[] = trades;
  if (args.verifiedOnly) list = list.filter((t) => t.humanReview);
  if (args.search) {
    const q = args.search.toLowerCase();
    list = list.filter((t) => t.symbol.toLowerCase().includes(q) || t.date.includes(q));
  }
  list = [...list].sort((a, b) => b.date.localeCompare(a.date));
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 100);
  return {
    total: list.length,
    shown: Math.min(limit, list.length),
    trades: list.slice(0, limit).map((t) => ({
      symbol: t.symbol,
      date: t.date,
      option: `${t.optionType} ${t.strike}`,
      expiry: t.expiry ?? null,
      pnl: t.pnl,
      humanVerified: Boolean(t.humanReview),
    })),
  };
}

/** Run an async mapper over items with a bounded concurrency (DB-friendly). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export type RankMetric = 'oi_buildup' | 'oi_level' | 'pnl';

interface RankedRow {
  symbol: string;
  date: string;
  option: string;
  optionOIBuildupPct: number | null;
  oiLevel: number | null;
  dataBias: string;
  agreesWithTrade: boolean;
  pnl: number;
  humanVerified: boolean;
}

// Batch context is expensive (one getDailyContext per trade), but the inputs are
// static historical data — so we compute once per (verifiedOnly) scope and reuse.
const rankCache = new Map<string, RankedRow[]>();

/**
 * Rank trades by a data metric (option OI buildup, OI level, or P&L). Computes the
 * metric server-side for every trade in scope in ONE call, so the model never has
 * to fan out per-trade. Defaults to verified trades — the audited, high-confidence set.
 */
export async function rankTrades(args: { metric?: RankMetric; verifiedOnly?: boolean; limit?: number }) {
  const metric: RankMetric = args.metric ?? 'oi_buildup';
  const verifiedOnly = args.verifiedOnly !== false; // default true
  const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);
  const cacheKey = verifiedOnly ? 'verified' : 'all';

  let rows = rankCache.get(cacheKey);
  if (!rows) {
    const { trades } = await loadAllTFTrades();
    const pool = verifiedOnly ? trades.filter((t) => t.humanReview) : trades;
    rows = await mapLimit(pool, 8, async (t): Promise<RankedRow> => {
      const base = {
        symbol: t.symbol,
        date: t.date,
        option: `${t.optionType} ${t.strike}`,
        pnl: t.pnl,
        humanVerified: Boolean(t.humanReview),
      };
      try {
        const ctx = await getDailyContext({
          symbol: t.symbol, date: t.date, optionType: t.optionType, strike: t.strike, days: 30, expiry: t.expiry,
        });
        const i = ctx.insight;
        return {
          ...base,
          optionOIBuildupPct: round(i.optOIChangePctTradeDay, 1),
          oiLevel: round(i.optOILevel20d),
          dataBias: i.futBias,
          agreesWithTrade: i.directionAgrees,
        };
      } catch {
        return { ...base, optionOIBuildupPct: null, oiLevel: null, dataBias: 'unknown', agreesWithTrade: false };
      }
    });
    rankCache.set(cacheKey, rows);
  }

  const keyOf = (r: RankedRow): number | null =>
    metric === 'pnl' ? r.pnl : metric === 'oi_level' ? r.oiLevel : r.optionOIBuildupPct;
  const ranked = rows
    .filter((r) => keyOf(r) != null)
    .sort((a, b) => (keyOf(b) as number) - (keyOf(a) as number));

  return {
    metric,
    verifiedOnly,
    scopeCount: rows.length,
    ranked: rows.length - ranked.length, // how many lacked the metric (excluded)
    shown: Math.min(limit, ranked.length),
    trades: ranked.slice(0, limit).map((r, idx) => ({ rank: idx + 1, ...r })),
  };
}

/** Rich, beginner-readable context for ONE trade — the bot's main grounding source. */
export async function getTradeContext(symbol: string, dateInput: string) {
  const { trades } = await loadAllTFTrades();
  const date = normalizeDate(dateInput);
  const t = trades.find((x) => x.symbol.toUpperCase() === symbol.toUpperCase() && x.date === date);
  if (!t) {
    return {
      found: false,
      message: `No trade found for ${symbol} on ${dateInput}. Call list_trades to see available symbols and dates.`,
    };
  }

  const ctx = await getDailyContext({
    symbol: t.symbol,
    date: t.date,
    optionType: t.optionType,
    strike: t.strike,
    days: 30,
    expiry: t.expiry,
  });
  const i = ctx.insight;
  const ret =
    t.entryPrice && t.exitPrice && t.entryPrice > 0
      ? round(((t.exitPrice - t.entryPrice) / t.entryPrice) * 100, 0)
      : null;

  return {
    found: true,
    trade: {
      symbol: t.symbol,
      date: t.date,
      optionType: t.optionType, // CE = bullish bet, PE = bearish bet
      strike: t.strike,
      contractExpiry: t.expiry ?? null,
      pnl: t.pnl,
      entryPrice: t.entryPrice ?? null,
      exitPrice: t.exitPrice ?? null,
      entryTime: t.entryTime ?? null,
      exitTime: t.exitTime ?? null,
      optionReturnPct: ret,
      humanVerified: Boolean(t.humanReview),
    },
    direction: {
      dataBias: i.futBias, // bullish | bearish | neutral (from price+OI quadrant)
      futuresQuadrant: i.futQuadrantLabel,
      optionFlow: i.optFlowLabel,
      priceChangePctTradeDay: round(i.priceChangePctTradeDay, 1),
      agreesWithTrade: i.directionAgrees, // does the data bias match the CE/PE taken?
      note: i.directionNote,
    },
    optionOI: {
      // Whole-stock option OI — every strike & expiry, in contracts (the
      // institutional footprint). NOT specific to the traded strike, so never
      // attribute these to "the contract".
      stockwideLevelVsCycleAvg: round(i.optOILevel20d), // null right after a monthly expiry
      stockwideChange5SessionsPct: round(i.optOIChangePct, 1),
      monthlyExpiryInWindow: i.optExpiryInWindow,
      // Traded contract ONLY — the exact month bought; the clean fresh-positioning signal.
      tradedContract: i.optContractExpiry,
      tradedContractBuildupPctTradeDay: round(i.optOIChangePctTradeDay, 1),
      tradedContractDataAvailable: i.optContractDataAvailable,
    },
    futuresOI: {
      levelVs20dAverage: round(i.futOILevel20d), // sustained accumulation signal (TF top picks ~1.25-1.35x)
      change5SessionsPct: round(i.futOIChangePct, 1),
      turnoverVsAverage: round(i.turnoverVsAvg),
    },
    coverage: ctx.calendar
      ? {
          sessions: ctx.calendar.sessions,
          holidays: ctx.calendar.holidays.map((h) => `${h.date}${h.occasion ? ` (${h.occasion})` : ''}`),
          dataGaps: ctx.calendar.symbolGaps,
        }
      : null,
  };
}
