import { clearCachedToken, getDhanAccessToken, hasDhanAuth } from '@/lib/dhan/auth';
import { fetchWithTimeout, isAbortError } from '@/lib/dhan/fetch-timeout';
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
  /** Interactive/live quote callers waiting or executing. Shadow option-chain
   * work yields while this is non-zero so it cannot build a backlog ahead of
   * money-path quote reads. */
  foregroundPending: number;
}

const gateHost = globalThis as unknown as { __dhanQuoteGate?: QuoteGateState };
gateHost.__dhanQuoteGate ??= {
  tail: Promise.resolve(),
  lastDispatchAt: 0,
  cooldownUntil: 0,
  consecutive429: 0,
  foregroundPending: 0,
};
const gate = gateHost.__dhanQuoteGate;
gate.foregroundPending ??= 0;

/**
 * Run a Quote-API task one-at-a-time, spaced ≥ QUOTE_MIN_INTERVAL_MS from the
 * previous dispatch AND not before any active 429 cooldown. Serial execution +
 * spacing + shared cooldown together keep the whole process within Dhan's
 * per-account limit no matter how many tabs / routes call in.
 */
function throughQuoteGate<T>(task: () => Promise<T>): Promise<T> {
  gate.foregroundPending++;
  const run = gate.tail.then(async (): Promise<T> => {
    const target = Math.max(gate.lastDispatchAt + QUOTE_MIN_INTERVAL_MS, gate.cooldownUntil);
    const wait = target - Date.now();
    if (wait > 0) await sleep(wait);
    gate.lastDispatchAt = Date.now();
    return task();
  });
  gate.tail = run.then(
    () => undefined,
    () => undefined
  );
  return run.finally(() => {
    gate.foregroundPending = Math.max(0, gate.foregroundPending - 1);
  });
}

/**
 * Hard ceiling on a measurement-only request once it has been dispatched. The
 * task joins the same serial `gate.tail` as live quotes, so an unbounded shadow
 * request would wedge the queue and make a money-path quote wait behind it
 * forever. This caps that exposure; see SHADOW_REQUEST_TIMEOUT_MS's use in
 * fetchDetailedOptionChainShadow.
 */
export const SHADOW_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Best-effort low-priority gate for measurement-only option-chain snapshots.
 * It waits for the foreground queue to drain and for a quiet interval.
 *
 * A quote arriving after dispatch can still wait behind this ONE request, which
 * is why the request it wraps MUST be independently bounded — the gate cannot
 * cancel a task it has already started. As a second line of defence the queue is
 * only ever handed a settled-by-timeout promise, so `gate.tail` advances even if
 * the underlying socket never does.
 */
async function throughQuoteGateLowPriority<T>(task: () => Promise<T>): Promise<T | null> {
  const giveUpAt = Date.now() + 15_000;
  while (gate.foregroundPending > 0 || Date.now() - gate.lastDispatchAt < QUOTE_MIN_INTERVAL_MS) {
    if (Date.now() >= giveUpAt) return null;
    await sleep(250);
  }
  const run = gate.tail.then(async (): Promise<T> => {
    const target = Math.max(gate.lastDispatchAt + QUOTE_MIN_INTERVAL_MS, gate.cooldownUntil);
    const wait = target - Date.now();
    if (wait > 0) await sleep(wait);
    gate.lastDispatchAt = Date.now();
    return task();
  });
  // Belt and braces: whatever the task does, the queue moves on within the
  // shadow timeout budget so foreground quotes are never held hostage.
  gate.tail = Promise.race([
    run.then(
      () => undefined,
      () => undefined,
    ),
    sleep(SHADOW_REQUEST_TIMEOUT_MS + QUOTE_MIN_INTERVAL_MS),
  ]);
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

/**
 * Raw Dhan V2 market feed call.
 * The API expects numeric security IDs and returns nested structure:
 * { data: { SEGMENT: { "secId": { last_price, ohlc: { open, close, high, low }, volume?, oi? } } } }
 */
export async function dhanMarketFeed(
  endpoint: 'ohlc' | 'quote',
  securities: Record<string, number[]>
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
      console.warn(
        `[Dhan] marketfeed/${endpoint} HTTP 429 — cooling off ${Math.round((gate.cooldownUntil - Date.now()) / 100) / 10}s`
      );
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

export interface OptionChainGreeksRow {
  strike: number;
  callGamma: number;
  callOi: number;
  putGamma: number;
  putOi: number;
}

/** A single index option-chain snapshot for the OI-weighted gamma proxy. */
export interface OptionChainGreeksSnapshot {
  rows: OptionChainGreeksRow[];
  /** Dhan's index level from this response; never substitute a stock quote. */
  underlyingLastPrice: number | null;
}

const OPTION_CHAIN_GREEKS_CACHE_MS = 3 * 60_000;
type OptionChainGreeksCache = Map<string, { expiresAt: number; value: OptionChainGreeksSnapshot }>;
type OptionChainGreeksInFlight = Map<string, Promise<OptionChainGreeksSnapshot | null>>;
const optionChainGreeksHost = globalThis as unknown as {
  __optionChainGreeksCache?: OptionChainGreeksCache;
  __optionChainGreeksInFlight?: OptionChainGreeksInFlight;
};
optionChainGreeksHost.__optionChainGreeksCache ??= new Map();
optionChainGreeksHost.__optionChainGreeksInFlight ??= new Map();
const optionChainGreeksCache = optionChainGreeksHost.__optionChainGreeksCache;
const optionChainGreeksInFlight = optionChainGreeksHost.__optionChainGreeksInFlight;

type OptionExpiryCache = Map<string, { expiresAt: number; value: string[] }>;
const optionExpiryHost = globalThis as unknown as {
  __optionExpiryCache?: OptionExpiryCache;
};
optionExpiryHost.__optionExpiryCache ??= new Map();
const optionExpiryCache = optionExpiryHost.__optionExpiryCache;

/** Active option expiries from Dhan's documented expiry-list endpoint. */
export async function fetchOptionExpiries(
  underlyingSecId: number,
  underlyingSeg: 'IDX_I' | 'NSE_FNO'
): Promise<string[]> {
  if (!hasDhanAuth()) return [];
  const key = `${underlyingSecId}:${underlyingSeg}`;
  const cached = optionExpiryCache.get(key);
  if (cached != null && cached.expiresAt > Date.now()) return cached.value;
  const token = await getDhanAccessToken();
  const clientId = env.DHAN_CLIENT_ID!;
  const resp = await throughQuoteGate(() =>
    fetch('https://api.dhan.co/v2/optionchain/expirylist', {
      method: 'POST',
      headers: {
        'access-token': token,
        'client-id': clientId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        UnderlyingScrip: underlyingSecId,
        UnderlyingSeg: underlyingSeg,
      }),
    })
  );
  if (resp.status === 429) noteQuote429();
  if (!resp.ok) {
    console.warn(`[Dhan] optionchain/expirylist HTTP ${resp.status} for secId=${underlyingSecId}`);
    return [];
  }
  noteQuoteOk();
  const json = (await resp.json()) as { data?: unknown };
  const value = Array.isArray(json.data)
    ? json.data
        .map(String)
        .filter((expiry) => /^\d{4}-\d{2}-\d{2}$/.test(expiry))
        .sort()
    : [];
  if (value.length > 0) {
    optionExpiryCache.set(key, {
      expiresAt: Date.now() + 6 * 60 * 60_000,
      value,
    });
  }
  return value;
}

/**
 * Fetch NIFTY's option chain for the experimental OI-weighted gamma proxy.
 * NIFTY 50 is an index underlying: Dhan requires IDX_I for security ID 13.
 * Successful snapshots are cached for three minutes; concurrent callers share
 * one request through the existing app-wide quote gate.
 */
export async function fetchOptionChainGreeks(
  underlyingSecId: number,
  expiry: string
): Promise<OptionChainGreeksSnapshot | null> {
  if (!hasDhanAuth()) return null;
  const cacheKey = `${underlyingSecId}:IDX_I:${expiry}`;
  const cached = optionChainGreeksCache.get(cacheKey);
  if (cached != null && cached.expiresAt > Date.now()) return cached.value;
  const running = optionChainGreeksInFlight.get(cacheKey);
  if (running != null) return running;

  const request = fetchOptionChainGreeksSnapshot(underlyingSecId, expiry);
  optionChainGreeksInFlight.set(cacheKey, request);
  try {
    const snapshot = await request;
    if (snapshot != null) {
      optionChainGreeksCache.set(cacheKey, {
        expiresAt: Date.now() + OPTION_CHAIN_GREEKS_CACHE_MS,
        value: snapshot,
      });
    }
    return snapshot;
  } finally {
    optionChainGreeksInFlight.delete(cacheKey);
  }
}

async function fetchOptionChainGreeksSnapshot(
  underlyingSecId: number,
  expiry: string
): Promise<OptionChainGreeksSnapshot | null> {
  const token = await getDhanAccessToken();
  const clientId = env.DHAN_CLIENT_ID!;
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
        UnderlyingSeg: 'IDX_I',
        Expiry: expiry,
      }),
    })
  );
  if (resp.status === 429) noteQuote429();
  if (!resp.ok) {
    console.warn(`[Dhan] optionchain HTTP ${resp.status} for index secId=${underlyingSecId}`);
    return null;
  }
  noteQuoteOk();

  const json = (await resp.json()) as {
    data?: {
      last_price?: number;
      oc?: Record<
        string,
        {
          ce?: { greeks?: { gamma?: number }; oi?: number };
          pe?: { greeks?: { gamma?: number }; oi?: number };
          strikePrice?: string | number;
        }
      >;
    };
  };
  const oc = json.data?.oc;
  if (oc == null) return null;
  return {
    underlyingLastPrice: Number(json.data?.last_price) > 0 ? Number(json.data?.last_price) : null,
    rows: Object.entries(oc).map(([key, value]) => ({
      strike: parseFloat(String(value.strikePrice ?? key)),
      callGamma: value.ce?.greeks?.gamma ?? 0,
      callOi: value.ce?.oi ?? 0,
      putGamma: value.pe?.greeks?.gamma ?? 0,
      putOi: value.pe?.oi ?? 0,
    })),
  };
}

/** Aggregated option chain data for a single underlying */
export interface OptionChainSummary {
  totalCeVolume: number;
  totalPeVolume: number;
  totalOptOi: number;
  totalOptVolume: number;
  pcr: number; // PE volume / CE volume
}

export interface DetailedOptionSide {
  securityId: string | null;
  lastPrice: number;
  averagePrice: number;
  oi: number;
  previousOi: number;
  previousClosePrice: number;
  previousVolume: number;
  volume: number;
  impliedVolatility: number | null;
  topBidPrice: number | null;
  topBidQuantity: number | null;
  topAskPrice: number | null;
  topAskQuantity: number | null;
  greeks: { delta: number; gamma: number; theta: number; vega: number } | null;
}

export interface DetailedOptionStrike {
  strike: number;
  ce: DetailedOptionSide | null;
  pe: DetailedOptionSide | null;
}

export interface DetailedOptionChain {
  underlyingLastPrice: number;
  strikes: DetailedOptionStrike[];
  fetchedAt: string;
}

const finite = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const positiveOrNull = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

function parseDetailedOptionSide(raw: Record<string, unknown> | undefined): DetailedOptionSide | null {
  if (raw == null) return null;
  const greeksRaw = raw.greeks as Record<string, unknown> | undefined;
  return {
    securityId: raw.security_id == null ? null : String(raw.security_id),
    lastPrice: finite(raw.last_price),
    averagePrice: finite(raw.average_price),
    oi: finite(raw.oi),
    previousOi:
      raw.previous_oi != null
        ? finite(raw.previous_oi)
        : raw.oi_change != null
          ? finite(raw.oi) - finite(raw.oi_change)
          : 0,
    previousClosePrice: finite(raw.previous_close_price),
    previousVolume: finite(raw.previous_volume),
    volume: finite(raw.volume),
    impliedVolatility: positiveOrNull(raw.implied_volatility),
    topBidPrice: positiveOrNull(raw.top_bid_price),
    topBidQuantity: positiveOrNull(raw.top_bid_quantity),
    topAskPrice: positiveOrNull(raw.top_ask_price),
    topAskQuantity: positiveOrNull(raw.top_ask_quantity),
    greeks:
      greeksRaw == null
        ? null
        : {
            delta: finite(greeksRaw.delta),
            gamma: finite(greeksRaw.gamma),
            theta: finite(greeksRaw.theta),
            vega: finite(greeksRaw.vega),
          },
  };
}

/**
 * Full strike-aware chain for R-factor V2 shadow research. This is deliberately
 * low priority and returns null instead of delaying a busy live-quote queue.
 */
export async function fetchDetailedOptionChainShadow(
  underlyingSecId: number,
  expiry: string,
): Promise<DetailedOptionChain | null> {
  if (!hasDhanAuth()) return null;
  const token = await getDhanAccessToken();
  const clientId = env.DHAN_CLIENT_ID!;
  // Bounded: this shares the serial Quote-API queue with live quotes, so a
  // hung measurement request must never become an unbounded stall on the
  // trade path. On timeout we abandon the snapshot — evidence is optional,
  // a blocked quote is not.
  const resp = await throughQuoteGateLowPriority(() =>
    fetchWithTimeout(
      'https://api.dhan.co/v2/optionchain',
      {
        method: 'POST',
        headers: {
          'access-token': token,
          'client-id': clientId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ UnderlyingScrip: underlyingSecId, UnderlyingSeg: 'NSE_EQ', Expiry: expiry }),
      },
      SHADOW_REQUEST_TIMEOUT_MS,
    ),
  ).catch((error: unknown) => {
    if (isAbortError(error)) {
      console.warn(`[Dhan] shadow optionchain timed out after ${SHADOW_REQUEST_TIMEOUT_MS}ms for secId=${underlyingSecId}`);
      return null;
    }
    throw error;
  });
  if (resp == null) return null;
  if (resp.status === 429) noteQuote429();
  if (!resp.ok) {
    console.warn(`[Dhan] shadow optionchain HTTP ${resp.status} for secId=${underlyingSecId}`);
    return null;
  }
  noteQuoteOk();
  const json = (await resp.json()) as {
    status?: string;
    data?: { last_price?: number; oc?: Record<string, { ce?: Record<string, unknown>; pe?: Record<string, unknown> }> };
  };
  if (json.status !== 'success' || json.data?.oc == null) return null;
  const underlyingLastPrice = finite(json.data.last_price);
  if (!(underlyingLastPrice > 0)) return null;
  const strikes = Object.entries(json.data.oc)
    .map(([key, row]) => ({
      strike: finite(key),
      ce: parseDetailedOptionSide(row.ce),
      pe: parseDetailedOptionSide(row.pe),
    }))
    .filter((row) => row.strike > 0)
    .sort((a, b) => a.strike - b.strike);
  return { underlyingLastPrice, strikes, fetchedAt: new Date().toISOString() };
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
    })
  );

  if (resp.status === 429) noteQuote429();
  if (!resp.ok) {
    console.warn(`[Dhan] optionchain HTTP ${resp.status} for secId=${underlyingSecId}`);
    return null;
  }
  noteQuoteOk();

  const json = (await resp.json()) as {
    data?: {
      oc?: Record<
        string,
        {
          ce?: { volume?: number; oi?: number };
          pe?: { volume?: number; oi?: number };
        }
      >;
    };
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
