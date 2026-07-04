/**
 * Live-market data assembly for the assistant's tools — the bot's eyes on the
 * CURRENT session. Everything is read through the same internal routes and
 * stores the /live, /nse/movers and /trade-suggest pages use, so the assistant
 * cites exactly what the user sees on screen — never a parallel computation,
 * never an invented number. Post-market, the quote route serves the recorded
 * closing snapshot, so these tools stay truthful after hours too.
 */

import type { LiveQuoteResponse, LiveUrgencyRow, SectorLeadersResponse, WatchlistSource } from '@/app/live/_lib/types';
import { isMarketHours, todayIST } from '@/lib/dhan/market-feed';
import { getFyersCandles } from '@/lib/fyers/candle-store';
import { getNseCombinedOiPctMap } from '@/lib/nse/combined-oi';
import { atr, sessionVwap, supertrend } from '@/lib/signals/indicators';
import { deriveSessionContext } from '@/lib/signals/session-context';
import { loadFactorBaselines } from '@/lib/trade-suggest/engine';
import { getSuggestions } from '@/lib/trade-suggest/store';

/** Same-process origin for internal route fetches (dev server on 5001). */
export const SELF_ORIGIN = `http://127.0.0.1:${process.env.PORT ?? 5001}`;

const round = (v: number | null | undefined, d = 2): number | null =>
  v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d));

// ─── Market pulse ────────────────────────────────────────────────────────────

/** The same five NSE pulse lists the /nse/movers page shows, F&O-gated. */
const PULSE_SOURCES: { source: WatchlistSource; label: string; pctMeans: 'oiChangePct' | 'priceChangePct' }[] = [
  { source: 'nse-oi', label: 'OI build-up (combined futures+options OI change)', pctMeans: 'oiChangePct' },
  { source: 'nse-gainers', label: 'Top F&O gainers', pctMeans: 'priceChangePct' },
  { source: 'nse-losers', label: 'Top F&O losers', pctMeans: 'priceChangePct' },
  { source: 'nse-active-value', label: 'Most active by value', pctMeans: 'priceChangePct' },
  { source: 'nse-active-volume', label: 'Most active by volume', pctMeans: 'priceChangePct' },
];

export interface MarketPulse {
  marketOpen: boolean;
  date: string;
  note: string;
  lists: {
    source: WatchlistSource;
    label: string;
    /** What `pct` on each name means for THIS list. */
    pctMeans: 'oiChangePct' | 'priceChangePct';
    names: { symbol: string; sector: string; pct: number }[];
  }[];
  /** Per-sector count of names on the gainers vs losers lists (price-based breadth). */
  sectorBreadth: { sector: string; gainers: number; losers: number; net: number }[];
}

/**
 * Market-wide overview from NSE's live pulse feeds (the exact /nse/movers
 * lists, F&O-gated). NSE serves the last session's lists after hours, so this
 * works post-market too — the `note` says which reading it is.
 */
export async function getMarketPulse(topN = 10): Promise<MarketPulse> {
  const marketOpen = isMarketHours();
  const lists: MarketPulse['lists'] = [];
  for (const src of PULSE_SOURCES) {
    try {
      const res = await fetch(`${SELF_ORIGIN}/api/live/nse-watchlist?source=${src.source}`, { cache: 'no-store' });
      const j = (await res.json()) as SectorLeadersResponse;
      lists.push({
        source: src.source,
        label: src.label,
        pctMeans: src.pctMeans,
        names: (j.picks ?? []).slice(0, topN).map((p) => ({
          symbol: p.symbol,
          sector: p.sector,
          pct: round(p.retPct) ?? 0,
        })),
      });
    } catch {
      lists.push({ source: src.source, label: `${src.label} (feed unavailable)`, pctMeans: src.pctMeans, names: [] });
    }
  }

  // Price-based sector breadth: appearances on the gainers vs losers lists.
  const breadth = new Map<string, { gainers: number; losers: number }>();
  for (const list of lists) {
    if (list.source !== 'nse-gainers' && list.source !== 'nse-losers') continue;
    for (const n of list.names) {
      if (!n.sector) continue;
      const b = breadth.get(n.sector) ?? { gainers: 0, losers: 0 };
      if (list.source === 'nse-gainers') b.gainers++;
      else b.losers++;
      breadth.set(n.sector, b);
    }
  }

  return {
    marketOpen,
    date: todayIST(),
    note: marketOpen
      ? 'Live NSE pulse lists (market open).'
      : "Market closed — NSE serves the LAST session's lists; treat every number as that session's final reading.",
    lists,
    sectorBreadth: [...breadth.entries()]
      .map(([sector, b]) => ({ sector, ...b, net: b.gainers - b.losers }))
      .sort((a, b) => b.net - a.net),
  };
}

// ─── Symbol snapshot ─────────────────────────────────────────────────────────

export interface SymbolSnapshot {
  found: boolean;
  symbol: string;
  reason?: string;
  marketOpen?: boolean;
  /** True when the quote is the recorded end-of-session state, not live depth. */
  snapshot?: boolean;
  sessionDate?: string;
  quote?: {
    ltp: number | null;
    changePctOpen: number | null;
    spreadPct: number | null;
    /** Bid-side share of the order book [0,1]; >0.5 = buy pressure. Null post-market. */
    imbalance: number | null;
    futOi: number | null;
    /** Futures OI ÷ its 20-session average. */
    oiLevel: number | null;
    turnover: number | null;
    /** Intraday OI build metrics (session series). */
    sessionOiChangePct: number | null;
    oiUrgency: number | null;
    /** R-Factor on the 1–8 scale + directional bias + factor agreement. */
    rFactor: number | null;
    rFactorBias: string | null;
    rFactorConfidence: number | null;
    /** Per-factor breakdown (label, score, vote, availability). */
    factors: { label: string; score: number; vote: string; available: boolean }[] | null;
  };
  session?: {
    openRangeHigh: number | null;
    openRangeLow: number | null;
    openRangeComplete: boolean;
    /** LTP vs the completed opening range: the price-action read. */
    openingRangeState: 'above-range' | 'below-range' | 'inside-range' | 'unknown';
    dayHigh: number | null;
    dayLow: number | null;
    /** 5-min bars recorded today (0 = Fyers recorder hasn't covered this name/date). */
    barsRecorded: number;
  };
  /** Classic indicators from the recorded 5-min bars (standard formulations). */
  indicators?: {
    vwap: number | null;
    /** LTP side of VWAP: 'above' = buyers paid up on average, 'below' = supply. */
    vwapSide: 'above' | 'below' | null;
    supertrend: 'up' | 'down' | null;
    supertrendLine: number | null;
    /** ATR(14) of the 5-min series — the noise unit for stop placement. */
    atr: number | null;
    atrPct: number | null;
  };
  /** Participation vs 20-day baselines (bhavcopy). */
  flow?: {
    /** Live equity turnover ÷ time-adjusted 20-day avg (mornings over-read ~2× — U-shaped volume). */
    eqTurnoverRatio: number | null;
    /** DERIVED combined fut+opt OI vs 20-day avg (yesterday's total × NSE live %). */
    combinedOiLevel: number | null;
  };
  /** NSE's combined (futures+options) OI %-change — the options-led-build signal. */
  nseCombinedOiPct?: number | null;
  /** Today's persisted /trade-suggest calls on this symbol, if any. */
  suggestedToday?: { optionType: string; strike: number; spotAtSuggest: number; suggestedAt: string; timesSeen: number }[];
}

/**
 * One-symbol deep dive: the /live quote row (live during market hours, the
 * recorded closing snapshot after), opening-range/price-action state from the
 * Fyers 5-min store, NSE combined OI, and any suggestion made on it today.
 */
export async function getSymbolSnapshot(symbolRaw: string): Promise<SymbolSnapshot> {
  const symbol = symbolRaw.trim().toUpperCase();
  if (!symbol) return { found: false, symbol, reason: 'Empty symbol.' };

  const res = await fetch(`${SELF_ORIGIN}/api/live/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbols: [symbol] }),
    cache: 'no-store',
  });
  const q = (await res.json()) as LiveQuoteResponse;
  if (!q.success) return { found: false, symbol, reason: q.error ?? 'Quote path failed.' };

  const excluded = q.excluded?.find((e) => e.symbol === symbol);
  if (excluded) return { found: false, symbol, reason: `Not in the tradeable F&O universe: ${excluded.reason}` };

  const row: LiveUrgencyRow | undefined = q.rows.find((r) => r.symbol === symbol) ?? q.rows[0];
  if (!row) {
    return {
      found: false,
      symbol,
      reason: q.marketOpen
        ? 'No quote returned this pass — Dhan feed hiccup; retry.'
        : 'Market closed and nothing recorded for this name in the last session.',
    };
  }

  const sessionDate = (q.snapshot ? q.snapshotDate : undefined) ?? todayIST();
  const bars = await getFyersCandles(symbol, sessionDate, 'EQ');
  const sc = deriveSessionContext(bars);
  const ltp = row.ltp ?? 0;
  const openingRangeState: NonNullable<SymbolSnapshot['session']>['openingRangeState'] =
    !sc.openRangeComplete || sc.openRangeHigh == null || sc.openRangeLow == null || ltp <= 0
      ? 'unknown'
      : ltp > sc.openRangeHigh
        ? 'above-range'
        : ltp < sc.openRangeLow
          ? 'below-range'
          : 'inside-range';

  const nseOiMap = await getNseCombinedOiPctMap();
  // Suggestions for the SNAPSHOT's session — on a weekend the closing snapshot
  // shows Friday, so Friday's calls are the relevant ones, not "today's".
  const todaysSuggestions = await getSuggestions(sessionDate);

  // Indicators + participation vs 20-day baselines, from the recorded bars.
  const vw = sessionVwap(bars);
  const st = supertrend(bars);
  const a14 = atr(bars);
  const nsePct = nseOiMap.get(symbol) ?? null;
  const fb = (await loadFactorBaselines([symbol])).get(symbol);
  // Session fraction: full day post-market; minutes since 09:15 ÷ 375 live.
  const ist = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60_000);
  const frac = q.marketOpen ? Math.min(1, Math.max(0.02, (ist.getHours() * 60 + ist.getMinutes() - (9 * 60 + 15)) / 375)) : 1;
  const eqTurnNow = bars.reduce((acc, b) => acc + b.close * b.volume, 0);

  return {
    found: true,
    symbol,
    marketOpen: q.marketOpen,
    snapshot: q.snapshot === true,
    sessionDate,
    quote: {
      ltp: round(row.ltp),
      changePctOpen: round(row.changePctOpen),
      spreadPct: round(row.spreadPct, 3),
      imbalance: round(row.imbalance, 3),
      futOi: row.futOi,
      oiLevel: round(row.oiLevel, 3),
      turnover: round(row.turnover),
      sessionOiChangePct: round(row.sessionOiChangePct),
      oiUrgency: round(row.oiUrgency, 1),
      rFactor: round(row.rFactor),
      rFactorBias: row.rFactorBias,
      rFactorConfidence: round(row.rFactorConfidence),
      factors:
        row.rFactors?.map((f) => ({
          label: f.label,
          score: round(f.score) ?? 0,
          vote: f.vote,
          available: f.available,
        })) ?? null,
    },
    session: {
      openRangeHigh: round(sc.openRangeHigh),
      openRangeLow: round(sc.openRangeLow),
      openRangeComplete: sc.openRangeComplete,
      openingRangeState,
      dayHigh: round(sc.dayHigh),
      dayLow: round(sc.dayLow),
      barsRecorded: bars.length,
    },
    indicators: {
      vwap: round(vw),
      vwapSide: vw == null || ltp <= 0 ? null : ltp >= vw ? 'above' : 'below',
      supertrend: st?.direction ?? null,
      supertrendLine: round(st?.line ?? null),
      atr: round(a14),
      atrPct: a14 == null || ltp <= 0 ? null : round((a14 / ltp) * 100),
    },
    flow: {
      eqTurnoverRatio:
        fb?.eqTurnover20dAvg != null && eqTurnNow > 0 ? round(eqTurnNow / (fb.eqTurnover20dAvg * frac)) : null,
      combinedOiLevel:
        fb?.combinedOiPrev != null && fb.combinedOi20dAvg != null && nsePct != null
          ? round((fb.combinedOiPrev * (1 + nsePct / 100)) / fb.combinedOi20dAvg, 3)
          : null,
    },
    nseCombinedOiPct: round(nsePct),
    suggestedToday: todaysSuggestions
      .filter((s) => s.symbol === symbol)
      .map((s) => ({
        optionType: s.optionType,
        strike: s.strike,
        spotAtSuggest: s.spotAtSuggest,
        suggestedAt: s.suggestedAt,
        timesSeen: s.timesSeen,
      })),
  };
}
