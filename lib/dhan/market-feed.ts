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

// ─── Quote-API rate gate (server-side, per Dhan account) ─────────────────────
// Dhan's Quote APIs (/marketfeed/quote, /marketfeed/ohlc, /optionchain) share a
// strict 1 req/sec limit enforced PER ACCOUNT — not per browser tab. The /live
// page's client scheduler only spaces a single tab's polls; multiple tabs, a page
// reload, the /heatmap page, and option-chain fetches all hit the same Dhan
// account and collide → HTTP 429 (code 805, which then puts the account in a
// penalty box that keeps 429-ing even compliant traffic). This gate is the single
// server-side choke point: every Quote-API call runs one-at-a-time, ≥
// QUOTE_MIN_INTERVAL_MS apart, and a 429 trips an escalating cooldown that pauses
// ALL quote traffic so the penalty box can clear instead of being poked again.
//
// State lives on globalThis (not a module `let`): Turbopack HMR re-evaluates this
// module on every hot reload — and separate route bundles can hold their own copy
// — which would reset/duplicate the queue. globalThis is the one thing shared
// across all of them in a single server process (auth.ts persists for the same
// reason). One queue, one account, one rate limit.
const QUOTE_MIN_INTERVAL_MS = 1500; // ~0.67 req/sec — a safety margin under 1/sec, not the boundary
const QUOTE_BACKOFF_BASE_MS = 4000; // first 429 cool-off; doubles on each consecutive 429
const QUOTE_BACKOFF_MAX_MS = 30_000; // cap the escalation

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface QuoteGateState {
  /** Tail of the serial chain; each new task appends. Never rejects. */
  tail: Promise<unknown>;
  /** When the last task was dispatched (start-to-start spacing anchor). */
  lastDispatchAt: number;
  /** No task dispatches before this time — set/extended by a 429. */
  cooldownUntil: number;
  /** Consecutive 429s; drives the exponential backoff, reset on any success. */
  consecutive429: number;
}

const gateHost = globalThis as unknown as { __dhanQuoteGate?: QuoteGateState };
gateHost.__dhanQuoteGate ??= { tail: Promise.resolve(), lastDispatchAt: 0, cooldownUntil: 0, consecutive429: 0 };
const gate = gateHost.__dhanQuoteGate;

/**
 * Run a Quote-API task one-at-a-time, spaced ≥ QUOTE_MIN_INTERVAL_MS from the
 * previous dispatch AND not before any active 429 cooldown. Serial execution +
 * spacing + shared cooldown together keep the whole process within Dhan's
 * per-account limit no matter how many tabs / routes call in.
 */
function throughQuoteGate<T>(task: () => Promise<T>): Promise<T> {
  const run = gate.tail.then(async (): Promise<T> => {
    const target = Math.max(gate.lastDispatchAt + QUOTE_MIN_INTERVAL_MS, gate.cooldownUntil);
    const wait = target - Date.now();
    if (wait > 0) await sleep(wait);
    gate.lastDispatchAt = Date.now();
    return task();
  });
  gate.tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** A 429 was seen — escalate the cooldown so every subsequent dispatch waits it out. */
function noteQuote429(): void {
  gate.consecutive429 = Math.min(gate.consecutive429 + 1, 8);
  const backoff = Math.min(QUOTE_BACKOFF_BASE_MS * 2 ** (gate.consecutive429 - 1), QUOTE_BACKOFF_MAX_MS);
  gate.cooldownUntil = Date.now() + backoff;
}

/** A Quote-API call succeeded — clear the escalation. */
function noteQuoteOk(): void {
  gate.consecutive429 = 0;
}

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

  // Serialize through the per-account Quote-API gate. We do NOT retry on a 429 —
  // retrying just pokes the penalty box again. Instead we trip an escalating
  // cooldown (noteQuote429) so the NEXT gated dispatch — this poll's natural
  // successor 5s later — waits the account out. Drop this poll and return empty.
  return throughQuoteGate(async () => {
    const resp = await fetch(`https://api.dhan.co/v2/marketfeed/${endpoint}`, {
      method: 'POST',
      headers: {
        'access-token': token,
        'client-id': clientId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestPayload),
    });

    if (resp.status === 429) {
      noteQuote429();
      console.warn(`[Dhan] marketfeed/${endpoint} HTTP 429 — cooling off ${Math.round((gate.cooldownUntil - Date.now()) / 100) / 10}s`);
      return {};
    }

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
    noteQuoteOk();
    return responsePayload as MarketFeedResponse;
  });
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

  // Option chain is a Quote-API endpoint sharing the same per-account 1 req/sec
  // limit as marketfeed/quote — gate it so it can't collide with live polls.
  const resp = await throughQuoteGate(() =>
    fetch('https://api.dhan.co/v2/optionchain', {
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
    }),
  );

  if (resp.status === 429) noteQuote429();
  if (!resp.ok) {
    console.warn(`[Dhan] optionchain HTTP ${resp.status} for secId=${underlyingSecId}`);
    return null;
  }
  noteQuoteOk();

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
