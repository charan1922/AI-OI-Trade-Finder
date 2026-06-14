import { clearCachedToken, getDhanAccessToken, hasDhanAuth } from '@/lib/dhan/auth';
import { env } from '@/lib/env';

/** One level of the order-book ladder (Dhan quote `depth.buy[]` / `depth.sell[]`). */
export interface DepthLevel {
  price: number;
  quantity: number;
  orders: number;
}

export interface MarketFeedQuote {
  last_price: number;
  ohlc: { open: number; close: number; high: number; low: number };
  volume?: number;
  oi?: number;
  average_price?: number; // VWAP — available from Quote endpoint, not OHLC
  net_change?: number; // LTP − previous close (Quote endpoint) → prev close = last_price − net_change
  // Order-book fields — present on the /marketfeed/quote response (NOT /ohlc).
  // Optional + parsed defensively: absent during off-hours or on the ohlc endpoint.
  buy_quantity?: number; // total resting bid quantity (top of book aggregate)
  sell_quantity?: number; // total resting ask quantity
  depth?: { buy?: DepthLevel[]; sell?: DepthLevel[] };
}

export type MarketFeedResponse = Record<string, Record<string, MarketFeedQuote>>;

/**
 * Best bid/ask + spread from a quote's depth ladder. Returns null when the book
 * is absent or degenerate (off-hours, ohlc endpoint, or a one-sided/zero book) —
 * never a fabricated price. spreadPct is relative to the mid (×100).
 */
export function bestBidAsk(
  q: MarketFeedQuote | undefined | null,
): { bid: number; ask: number; mid: number; spreadAbs: number; spreadPct: number } | null {
  const bid = q?.depth?.buy?.[0]?.price ?? 0;
  const ask = q?.depth?.sell?.[0]?.price ?? 0;
  if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
  const mid = (bid + ask) / 2;
  const spreadAbs = ask - bid;
  return { bid, ask, mid, spreadAbs, spreadPct: mid > 0 ? (spreadAbs / mid) * 100 : 0 };
}

/**
 * Order-book imbalance = bid qty ÷ (bid qty + ask qty), in [0, 1]. > 0.5 means
 * more resting demand than supply (a better order-flow / "urgency" read than the
 * spread width). Uses the aggregate buy/sell quantities, falling back to the sum
 * of the visible depth levels. Returns null when neither side is available.
 */
export function depthImbalance(q: MarketFeedQuote | undefined | null): number | null {
  let bidQty = q?.buy_quantity ?? 0;
  let askQty = q?.sell_quantity ?? 0;
  if (!(bidQty > 0) && !(askQty > 0)) {
    bidQty = (q?.depth?.buy ?? []).reduce((s, l) => s + (l.quantity ?? 0), 0);
    askQty = (q?.depth?.sell ?? []).reduce((s, l) => s + (l.quantity ?? 0), 0);
  }
  const total = bidQty + askQty;
  return total > 0 ? bidQty / total : null;
}

/**
 * Check if Indian market is currently open.
 * IST = UTC+5:30, market hours 9:15–15:30.
 */
export function isMarketHours(): boolean {
  const ist = getIST();
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const time = ist.getHours() * 60 + ist.getMinutes();
  return time >= 9 * 60 + 15 && time <= 15 * 60 + 30;
}

/**
 * Check if today is a trading day (weekday) AND market has opened at least once today.
 * Dhan OHLC data remains valid after 15:30 — it holds the day's closing prices.
 * Use this to decide whether Dhan data represents "today" vs stale weekend data.
 */
export function isTradingDay(): boolean {
  const ist = getIST();
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  // After 9:15 IST on a weekday, Dhan has today's data
  const time = ist.getHours() * 60 + ist.getMinutes();
  return time >= 9 * 60 + 15;
}

/** Current IST date as YYYY-MM-DD string */
export function todayIST(): string {
  const d = getIST();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getIST(): Date {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcMs + 5.5 * 3600000);
}

/**
 * Raw Dhan V2 market feed call.
 * The API expects numeric security IDs and returns nested structure:
 * { data: { SEGMENT: { "secId": { last_price, ohlc: { open, close, high, low }, volume?, oi? } } } }
 */
export async function dhanMarketFeed(
  endpoint: 'ohlc' | 'quote',
  securities: Record<string, number[]>,
): Promise<MarketFeedResponse> {
  if (!hasDhanAuth()) return {};
  const token = await getDhanAccessToken();
  const clientId = env.DHAN_CLIENT_ID!;

  const requestPayload = securities;

  const resp = await fetch(`https://api.dhan.co/v2/marketfeed/${endpoint}`, {
    method: 'POST',
    headers: {
      'access-token': token,
      'client-id': clientId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestPayload),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.warn(`[Dhan] marketfeed/${endpoint} HTTP ${resp.status}: ${body}`);
    if (resp.status === 401 || resp.status === 400) {
      clearCachedToken();
    }
    return {};
  }

  const json = (await resp.json()) as {
    data?: Record<string, Record<string, unknown>>;
    Data?: Record<string, Record<string, unknown>>;
    status?: string;
  };
  const responsePayload = json.data ?? json.Data;
  if ((json.status ?? '').toLowerCase() !== 'success' || !responsePayload) return {};
  return responsePayload as MarketFeedResponse;
}

// ─── Intraday Charts ─────────────────────────────────────────────────────────

/** 5-min OHLC candle from Dhan intraday charts API */
export interface IntradayCandle {
  high: number;
  low: number;
  close: number;
  timestamp: number;
}

/**
 * Fetch 5-min intraday candles for a security.
 * Returns today's candles sorted by time. Requires equity securityId.
 */
export async function fetchIntradayCandles(
  securityId: number,
  interval: '1' | '5' | '15' | '25' | '60' = '5',
): Promise<IntradayCandle[]> {
  if (!hasDhanAuth()) return [];
  const token = await getDhanAccessToken();
  const clientId = env.DHAN_CLIENT_ID!;
  const today = todayIST();

  const resp = await fetch('https://api.dhan.co/v2/charts/intraday', {
    method: 'POST',
    headers: {
      'access-token': token,
      'client-id': clientId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      securityId: String(securityId),
      exchangeSegment: 'NSE_EQ',
      instrument: 'EQUITY',
      interval,
      fromDate: today,
      toDate: today,
    }),
  });

  if (!resp.ok) return [];
  const json = await resp.json();
  if (!json.high || !json.low || !json.close) return [];

  const candles: IntradayCandle[] = [];
  const n = Math.min(json.high.length, json.low.length, json.close.length);
  for (let i = 0; i < n; i++) {
    candles.push({
      high: json.high[i],
      low: json.low[i],
      close: json.close[i],
      timestamp: json.timestamp?.[i] ?? 0,
    });
  }
  return candles;
}

// ─── Option Chain ────────────────────────────────────────────────────────────

/** Aggregated option chain data for a single underlying */
export interface OptionChainSummary {
  totalCeVolume: number;
  totalPeVolume: number;
  totalOptOi: number;
  totalOptVolume: number;
  pcr: number; // PE volume / CE volume
}

/**
 * Fetch option chain for a single underlying and aggregate CE/PE volumes.
 * Rate limit: 1 request per 3 seconds.
 *
 * @param underlyingSecId - Security ID of the underlying (equity)
 * @param expiry - Expiry date in YYYY-MM-DD format (nearest F&O expiry)
 */
export async function fetchOptionChain(underlyingSecId: number, expiry: string): Promise<OptionChainSummary | null> {
  if (!hasDhanAuth()) return null;
  const token = await getDhanAccessToken();
  const clientId = env.DHAN_CLIENT_ID!;

  const resp = await fetch('https://api.dhan.co/v2/optionchain', {
    method: 'POST',
    headers: {
      'access-token': token,
      'client-id': clientId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      UnderlyingScrip: underlyingSecId,
      UnderlyingSeg: 'NSE_FNO',
      Expiry: expiry,
    }),
  });

  if (!resp.ok) {
    console.warn(`[Dhan] optionchain HTTP ${resp.status} for secId=${underlyingSecId}`);
    return null;
  }

  const json = (await resp.json()) as {
    data?: { oc?: Record<string, { ce?: { volume?: number; oi?: number }; pe?: { volume?: number; oi?: number } }> };
    status: string;
  };

  if (json.status !== 'success' || !json.data?.oc) return null;

  let totalCeVolume = 0;
  let totalPeVolume = 0;
  let totalOptOi = 0;

  for (const strike of Object.values(json.data.oc)) {
    if (strike.ce) {
      totalCeVolume += strike.ce.volume ?? 0;
      totalOptOi += strike.ce.oi ?? 0;
    }
    if (strike.pe) {
      totalPeVolume += strike.pe.volume ?? 0;
      totalOptOi += strike.pe.oi ?? 0;
    }
  }

  const totalOptVolume = totalCeVolume + totalPeVolume;
  const pcr = totalCeVolume > 0 ? totalPeVolume / totalCeVolume : 0;

  return { totalCeVolume, totalPeVolume, totalOptOi, totalOptVolume, pcr };
}
