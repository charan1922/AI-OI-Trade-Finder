/**
 * NSE "market pulse" feeds — the free, reachable per-stock / market-wide
 * endpoints beyond allIndices, used by the Market Movers page and the heatmap's
 * status strip. All go through the shared, cookie-cached client.
 *
 * Verified-reachable endpoints (others like equity-stockIndices/quote-equity 404/403):
 *   /api/marketStatus                                  → open/closed, GIFT Nifty, mkt cap
 *   /api/live-analysis-variations?index=gainers|loosers→ top movers by group (FOSec, NIFTY…)
 *   /api/live-analysis-most-active-securities?index=…  → most active by value / volume
 *   /api/live-analysis-data-52weekhighstock            → stocks at a 52-week high
 *   /api/live-analysis-oi-spurts-underlyings           → F&O OI build-up (216 underlyings)
 */

import { num, nseApiGet } from '@/lib/nse/client';

export interface MarketStatus {
  status: string; // "Open" | "Close"
  message: string;
  tradeDate: string;
  nifty50: { last: number; pctChange: number };
  giftNifty: { last: number; pctChange: number; expiry: string } | null;
  marketCap: { lacCrore: string; trillionUsd: number } | null;
}

export interface MoverStock {
  symbol: string;
  ltp: number;
  prevClose: number;
  pctChange: number;
  /** Raw NSE `turnover` value, as provided (unit not displayed, so left unconverted). */
  turnover: number;
}

export interface ActiveStock {
  symbol: string;
  lastPrice: number;
  pctChange: number;
  tradedValue: number; // ₹
  volume: number;
}

export interface WeekHighStock {
  symbol: string;
  company: string;
  ltp: number;
  pctChange: number;
}

export interface OiStock {
  symbol: string;
  changeInOiPct: number;
  changeInOi: number;
  volume: number;
  underlyingValue: number;
}

export interface NsePulse {
  asOf: string | null;
  marketStatus: MarketStatus | null;
  /** Keyed by NSE group: "allSec" | "FOSec" | "NIFTY". */
  gainers: Record<string, MoverStock[]>;
  losers: Record<string, MoverStock[]>;
  mostActiveValue: ActiveStock[];
  mostActiveVolume: ActiveStock[];
  week52High: WeekHighStock[];
  oiSpurts: OiStock[];
}

/** Groups we surface from the variations feed (each capped at ~20 by NSE). */
const MOVER_GROUPS = ['allSec', 'FOSec', 'NIFTY'] as const;

const moverRef = 'https://www.nseindia.com/market-data/top-gainers-losers';
const activeRef = 'https://www.nseindia.com/market-data/most-active-equities';

/** Run a feed fetch, swallowing failures to null so one bad feed can't blank the page. */
async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export async function fetchMarketStatus(): Promise<MarketStatus> {
  const j = await nseApiGet<{
    marketState?: Record<string, unknown>[];
    giftnifty?: Record<string, unknown>;
    marketcap?: Record<string, unknown>;
  }>('/api/marketStatus');

  const cap = j.marketState?.find((m) => m.market === 'Capital Market') ?? j.marketState?.[0] ?? {};
  const g = j.giftnifty;
  const mc = j.marketcap;

  return {
    status: String(cap.marketStatus ?? 'Unknown'),
    message: String(cap.marketStatusMessage ?? ''),
    tradeDate: String(cap.tradeDate ?? ''),
    nifty50: { last: num(cap.last), pctChange: num(cap.percentChange) },
    giftNifty: g
      ? { last: num(g.LASTPRICE), pctChange: num(g.PERCHANGE), expiry: String(g.EXPIRYDATE ?? '') }
      : null,
    marketCap: mc
      ? {
          lacCrore: String(mc.marketCapinLACCRRupeesFormatted ?? ''),
          trillionUsd: num(mc.marketCapinTRDollars),
        }
      : null,
  };
}

function mapMovers(json: Record<string, { data?: Record<string, unknown>[] }>): Record<string, MoverStock[]> {
  const out: Record<string, MoverStock[]> = {};
  for (const g of MOVER_GROUPS) {
    out[g] = (json[g]?.data ?? []).map((d) => ({
      symbol: String(d.symbol ?? ''),
      ltp: num(d.ltp),
      prevClose: num(d.prev_price),
      pctChange: num(d.perChange),
      turnover: num(d.turnover),
    }));
  }
  return out;
}

function mapActive(json: { data?: Record<string, unknown>[] }): ActiveStock[] {
  return (json.data ?? []).map((d) => ({
    symbol: String(d.symbol ?? ''),
    lastPrice: num(d.lastPrice),
    pctChange: num(d.pChange),
    tradedValue: num(d.totalTradedValue),
    volume: num(d.totalTradedVolume ?? d.quantityTraded),
  }));
}

/** Fetch every pulse feed sequentially (cookie is cached, so each is one request). */
export async function fetchNsePulse(): Promise<NsePulse> {
  const marketStatus = await safe(fetchMarketStatus);

  const gainersJson = await safe(() =>
    nseApiGet<Record<string, { data?: Record<string, unknown>[] }>>(
      '/api/live-analysis-variations?index=gainers',
      { referer: moverRef },
    ),
  );
  const losersJson = await safe(() =>
    nseApiGet<Record<string, { data?: Record<string, unknown>[] }>>(
      '/api/live-analysis-variations?index=loosers',
      { referer: moverRef },
    ),
  );
  const mavJson = await safe(() =>
    nseApiGet<{ data?: Record<string, unknown>[] }>(
      '/api/live-analysis-most-active-securities?index=value',
      { referer: activeRef },
    ),
  );
  const mvolJson = await safe(() =>
    nseApiGet<{ data?: Record<string, unknown>[] }>(
      '/api/live-analysis-most-active-securities?index=volume',
      { referer: activeRef },
    ),
  );
  const whJson = await safe(() =>
    nseApiGet<{ data?: Record<string, unknown>[] }>('/api/live-analysis-data-52weekhighstock'),
  );
  const oiJson = await safe(() =>
    nseApiGet<{ data?: Record<string, unknown>[] }>('/api/live-analysis-oi-spurts-underlyings'),
  );

  const week52High: WeekHighStock[] = (whJson?.data ?? []).map((d) => ({
    symbol: String(d.symbol ?? ''),
    company: String(d.comapnyName ?? ''), // NSE's field is misspelled
    ltp: num(d.ltp),
    pctChange: num(d.pChange),
  }));

  const oiSpurts: OiStock[] = (oiJson?.data ?? [])
    .map((d) => ({
      symbol: String(d.symbol ?? ''),
      changeInOiPct: num(d.avgInOI),
      changeInOi: num(d.changeInOI),
      volume: num(d.volume),
      underlyingValue: num(d.underlyingValue),
    }))
    .sort((a, b) => Math.abs(b.changeInOiPct) - Math.abs(a.changeInOiPct));

  return {
    asOf: marketStatus?.tradeDate ?? null,
    marketStatus,
    gainers: gainersJson ? mapMovers(gainersJson) : {},
    losers: losersJson ? mapMovers(losersJson) : {},
    mostActiveValue: mavJson ? mapActive(mavJson) : [],
    mostActiveVolume: mvolJson ? mapActive(mvolJson) : [],
    week52High,
    oiSpurts,
  };
}
