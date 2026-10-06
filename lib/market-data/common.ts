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

export function bestBidAsk(q: MarketFeedQuote | undefined | null): {
  bid: number;
  ask: number;
  mid: number;
  spreadAbs: number;
  spreadPct: number;
} | null {
  const bid = q?.depth?.buy?.[0]?.price ?? 0;
  const ask = q?.depth?.sell?.[0]?.price ?? 0;
  if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
  const mid = (bid + ask) / 2;
  const spreadAbs = ask - bid;
  return {
    bid,
    ask,
    mid,
    spreadAbs,
    spreadPct: mid > 0 ? (spreadAbs / mid) * 100 : 0,
  };
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
 * IST hour at/after which a trading day's NSE EOD bhavcopy is treated as
 * published. NSE finalises the day's files overnight (post-midnight), NOT in the
 * evening — so both the autonomous EOD sync (lib/fyers/poller.ts) and the
 * staleness banner (app/api/bhavcopy) only expect a session's file from this
 * hour on the FOLLOWING calendar day. 1 = 01:00 IST (small buffer past midnight).
 */
export const EOD_PUBLISH_HOUR_IST = 1;

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

