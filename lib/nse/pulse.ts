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

/** Groups we surface from the variations feed (each capped at ~20 by NSE). */
const MOVER_GROUPS = ['allSec', 'FOSec', 'NIFTY'] as const;

const moverRef = 'https://www.nseindia.com/market-data/top-gainers-losers';
const activeRef = 'https://www.nseindia.com/market-data/most-active-equities';

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

export async function fetchGainers(): Promise<Record<string, MoverStock[]>> {
  const json = await nseApiGet<Record<string, { data?: Record<string, unknown>[] }>>(
    '/api/live-analysis-variations?index=gainers',
    { referer: moverRef },
  );
  return mapMovers(json);
}

export async function fetchLosers(): Promise<Record<string, MoverStock[]>> {
  const json = await nseApiGet<Record<string, { data?: Record<string, unknown>[] }>>(
    '/api/live-analysis-variations?index=loosers',
    { referer: moverRef },
  );
  return mapMovers(json);
}

export async function fetchMostActiveValue(): Promise<ActiveStock[]> {
  const json = await nseApiGet<{ data?: Record<string, unknown>[] }>(
    '/api/live-analysis-most-active-securities?index=value',
    { referer: activeRef },
  );
  return mapActive(json);
}

export async function fetchMostActiveVolume(): Promise<ActiveStock[]> {
  const json = await nseApiGet<{ data?: Record<string, unknown>[] }>(
    '/api/live-analysis-most-active-securities?index=volume',
    { referer: activeRef },
  );
  return mapActive(json);
}

export async function fetchWeek52High(): Promise<WeekHighStock[]> {
  const json = await nseApiGet<{ data?: Record<string, unknown>[] }>('/api/live-analysis-data-52weekhighstock');
  return (json.data ?? []).map((d) => ({
    symbol: String(d.symbol ?? ''),
    company: String(d.comapnyName ?? ''), // NSE's field is misspelled
    ltp: num(d.ltp),
    pctChange: num(d.pChange),
  }));
}

export async function fetchOiSpurts(): Promise<OiStock[]> {
  const json = await nseApiGet<{ data?: Record<string, unknown>[] }>('/api/live-analysis-oi-spurts-underlyings');
  return (json.data ?? [])
    .map((d) => ({
      symbol: String(d.symbol ?? ''),
      changeInOiPct: num(d.avgInOI),
      changeInOi: num(d.changeInOI),
      volume: num(d.volume),
      underlyingValue: num(d.underlyingValue),
    }))
    .sort((a, b) => Math.abs(b.changeInOiPct) - Math.abs(a.changeInOiPct));
}

/**
 * Per-feed fetcher registry. Each feed is fetched independently so a feed NSE
 * throttles fails alone instead of blanking the whole page; the browser staggers
 * the calls (~350ms apart) to stay under NSE's burst limit. The cookie is shared
 * and cached in-process, so every feed reuses one warm-up.
 */
export const FEED_FETCHERS = {
  marketStatus: fetchMarketStatus,
  gainers: fetchGainers,
  losers: fetchLosers,
  mostActiveValue: fetchMostActiveValue,
  mostActiveVolume: fetchMostActiveVolume,
  week52High: fetchWeek52High,
  oiSpurts: fetchOiSpurts,
} as const;

export type FeedKey = keyof typeof FEED_FETCHERS;
export const FEED_KEYS = Object.keys(FEED_FETCHERS) as FeedKey[];
