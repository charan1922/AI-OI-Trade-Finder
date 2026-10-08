/**
 * Fyers data-API client — thin wrappers over the fyers-api-v3 SDK behind a
 * serial rate gate.
 *
 * The gate clones lib/dhan/market-feed.ts's __dhanQuoteGate: every Fyers call
 * in the process runs one-at-a-time, ≥ MIN_INTERVAL_MS apart (start-to-start),
 * and a 429 trips an escalating cooldown shared by all callers. State lives on
 * globalThis because Turbopack HMR re-evaluates modules (same rationale
 * documented in market-feed.ts).
 *
 * FYERS reserves the right to adjust endpoint limits. This client therefore
 * enforces its own conservative 350ms dispatch spacing and reacts to observed
 * 429s with a shared escalating cooldown; concurrency never bypasses either.
 */

import { fyersModel } from 'fyers-api-v3';
import path from 'node:path';
import { FyersAuthError, clearFyersToken, fyersAppId, getFyersAccessToken } from '@/lib/fyers/auth';
import { fyersDataLimits } from '@/lib/market-data/provider';

const TAG = '[FyersClient]';
const MIN_INTERVAL_MS = 350; // configured ceiling ≈2.8 dispatches/sec (≈171/min)
const BACKOFF_BASE_MS = 2000; // first 429 cool-off; doubles per consecutive 429
const BACKOFF_MAX_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Serial rate gate (globalThis — one queue per server process) ────────────

interface FyersGateState {
  tail: Promise<unknown>;
  lastDispatchAt: number;
  cooldownUntil: number;
  consecutive429: number;
  dispatched?: number[];
  day?: string;
  dayCount?: number;
}

const gateHost = globalThis as unknown as {
  __fyersGate?: FyersGateState;
  __fyersModel?: fyersModel;
};
gateHost.__fyersGate ??= {
  tail: Promise.resolve(),
  lastDispatchAt: 0,
  cooldownUntil: 0,
  consecutive429: 0,
};
const gate = gateHost.__fyersGate;

function throughFyersGate<T>(task: () => Promise<T>, deadline = Date.now() + 60_000): Promise<T> {
  // Serialize DISPATCH times, not whole HTTP response times. Callers may use a
  // small bounded worker pool without increasing the configured request rate;
  // slow responses no longer create avoidable head-of-line blocking.
  const dispatch = gate.tail.then(async (): Promise<void> => {
    const limits = fyersDataLimits();
    const day = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
    if (gate.day !== day) { gate.day = day; gate.dayCount = 0; }
    if ((gate.dayCount ?? 0) >= limits.perDay) throw new Error('Fyers daily data request budget exhausted');
    gate.dispatched = (gate.dispatched ?? []).filter((at) => at > Date.now() - 60_000);
    const minuteAt = gate.dispatched.length >= limits.perMinute ? gate.dispatched[0] + 60_001 : 0;
    const target = Math.max(gate.lastDispatchAt + Math.max(MIN_INTERVAL_MS, 1000 / limits.perSecond), gate.cooldownUntil, minuteAt);
    if (Math.max(Date.now(), target) > deadline) throw new Error('Fyers data capacity unavailable within request deadline; reduce polling');
    const wait = target - Date.now();
    if (wait > 0) await sleep(wait);
    gate.lastDispatchAt = Date.now();
    gate.dispatched.push(gate.lastDispatchAt);
    gate.dayCount = (gate.dayCount ?? 0) + 1;
  });
  gate.tail = dispatch.then(
    () => undefined,
    () => undefined
  );
  return dispatch.then(task);
}

/** Strict REST boundary for migrated data paths. Never returns success-shaped empty data on an API error. */
export async function requestFyersData(
  endpoint: string,
  params: Record<string, string | number>,
  deadline = Date.now() + 8_000,
): Promise<Record<string, unknown>> {
  if (!['history', 'quotes', 'depth', 'options-chain-v3', 'history/fno/expired/expiry-dates',
    'history/fno/expired/underlying-symbols', 'history/fno/expired/historical-data'].includes(endpoint)) {
    throw new Error(`Unsupported Fyers data endpoint: ${endpoint}`);
  }
  const token = await getFyersAccessToken();
  const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
  const response = await throughFyersGate(() => fetch(`https://api-t1.fyers.in/data/${endpoint}?${query}`, {
    headers: { Authorization: `${fyersAppId()}:${token}` },
    signal: AbortSignal.timeout(Math.max(1, Math.min(8_000, deadline - Date.now()))),
    cache: 'no-store',
  }), deadline);
  if (response.status === 429) { noteFyers429(); throw new Error('Fyers data rate limit; cooling down'); }
  if (response.status === 401 || response.status === 403) {
    clearFyersToken();
    throw new FyersAuthError(`Fyers data access HTTP ${response.status}; check token and API entitlement`);
  }
  if (!response.ok) throw new Error(`Fyers ${endpoint} HTTP ${response.status}`);
  const result = await response.json() as Record<string, unknown>;
  if (result.s !== 'ok') {
    const failure = classifyFailure(result);
    throw new Error(`Fyers ${endpoint}: ${failure.message}`);
  }
  noteFyersOk();
  return result;
}

function noteFyers429(): void {
  gate.consecutive429 = Math.min(gate.consecutive429 + 1, 8);
  gate.cooldownUntil = Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** (gate.consecutive429 - 1), BACKOFF_MAX_MS);
}

function noteFyersOk(): void {
  gate.consecutive429 = 0;
}

// ─── SDK instance ────────────────────────────────────────────────────────────

/** Lazily-built shared SDK instance; token re-set on every use (it may rotate mid-day). */
async function getFyers(): Promise<fyersModel> {
  if (!gateHost.__fyersModel) {
    gateHost.__fyersModel = new fyersModel({
      path: path.join(process.cwd(), 'data'),
      enableLogging: false, // SDK default is TRUE and writes a daily log file — keep it off
    });
  }
  const fyers = gateHost.__fyersModel;
  fyers.setAppId(fyersAppId());
  fyers.setAccessToken(await getFyersAccessToken());
  return fyers;
}

// ─── Response handling ───────────────────────────────────────────────────────

/**
 * Classify a Fyers response/rejection. Auth failures clear the cached token and
 * throw FyersAuthError (poller regenerates + retries once); rate limits note the
 * gate cooldown and report `rateLimited`; anything else is a plain error string.
 */
function classifyFailure(res: Record<string, unknown>): {
  rateLimited: boolean;
  message: string;
} {
  const code = Number(res.code ?? 0);
  const message = String(res.message ?? JSON.stringify(res).slice(0, 200));
  if (code === -15 || code === -16 || code === -17 || /authenticate|token.*(invalid|expired)/i.test(message)) {
    clearFyersToken();
    throw new FyersAuthError(`${TAG} auth failure (code ${code}): ${message}`);
  }
  if (code === 429 || /rate|limit exceeded|too many/i.test(message)) {
    noteFyers429();
    return { rateLimited: true, message };
  }
  return { rateLimited: false, message };
}

/** One completed 5-min bar as returned by the Fyers history API. */
export interface FyersBar {
  /** Bar-START epoch seconds (Fyers native), already on the 300s grid. */
  bucketTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Full-day (or partial-day so far) 5-min candles for one Fyers symbol.
 * Returns [] on any non-auth failure — a single symbol must never kill a cycle;
 * the next cycle's full-day refetch self-heals. Throws only FyersAuthError.
 */
export async function fetchHistory5m(fyersSymbol: string, date: string): Promise<FyersBar[]> {
  const fyers = await getFyers();
  let res: Record<string, unknown>;
  try {
    res = await throughFyersGate(() =>
      fyers.getHistory({
        symbol: fyersSymbol,
        resolution: '5',
        date_format: '1',
        range_from: date,
        range_to: date,
        cont_flag: '1',
      })
    );
  } catch (err) {
    if (err instanceof FyersAuthError) throw err;
    res = (err ?? {}) as Record<string, unknown>; // SDK rejects with {s:'error', code, message}
  }

  if (res.s !== 'ok') {
    const { message } = classifyFailure(res);
    console.warn(`${TAG} history failed for ${fyersSymbol} (${date}): ${message}`);
    return [];
  }
  noteFyersOk();

  const candles = Array.isArray(res.candles) ? (res.candles as number[][]) : [];
  return candles
    .filter((c) => Array.isArray(c) && c.length >= 6)
    .map((c) => ({
      bucketTs: c[0],
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5],
    }));
}

/**
 * Live depth snapshot of a futures contract — everything useful the ONE
 * existing getMarketDepth call carries (verified against a raw response on
 * this plan, 2026-07-03). OI is the anchor; the rest are nullable extras.
 */
export interface FutDepthSnapshot {
  /** Open interest (required — the whole snapshot is dropped without it). */
  oi: number;
  /** Previous-day OI → day OI change without diffing buckets. */
  pdoi: number | null;
  /** Fyers' own OI %-change vs previous day. */
  oiPct: number | null;
  /** Day VWAP of the future; turnover ≈ atp × dayVolume (no explicit field exists). */
  atp: number | null;
  /** Day cumulative traded volume of the future (shares). */
  dayVolume: number | null;
  /** Resting order-book totals → buy/sell pressure. */
  buyQty: number | null;
  sellQty: number | null;
  /** Futures last traded price → basis vs the equity close. */
  futLtp: number | null;
}

/** A positive finite number or null — absent fields are never fabricated. */
function posOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Live futures depth via the depth API (the only Fyers endpoint that carries
 * OI; one symbol per call). Null on failure or when the response has no OI —
 * never fabricated. Throws FyersAuthError.
 */
export async function fetchFutDepth(fyersSymbol: string): Promise<FutDepthSnapshot | null> {
  const fyers = await getFyers();
  let res: Record<string, unknown>;
  try {
    res = await throughFyersGate(() => fyers.getMarketDepth({ symbol: [fyersSymbol], ohlcv_flag: 1 }));
  } catch (err) {
    if (err instanceof FyersAuthError) throw err;
    res = (err ?? {}) as Record<string, unknown>;
  }

  if (res.s !== 'ok') {
    const { message } = classifyFailure(res);
    console.warn(`${TAG} depth failed for ${fyersSymbol}: ${message}`);
    return null;
  }
  noteFyersOk();

  const bySymbol = (res.d ?? {}) as Record<string, Record<string, unknown>>;
  const entry = bySymbol[fyersSymbol] ?? Object.values(bySymbol)[0];
  const oi = posOrNull(entry?.oi);
  if (oi === null) return null;
  return {
    oi,
    pdoi: posOrNull(entry?.pdoi),
    // oipercent can legitimately be 0 or negative — only null when absent
    oiPct: entry?.oipercent == null || !Number.isFinite(Number(entry.oipercent)) ? null : Number(entry.oipercent),
    atp: posOrNull(entry?.atp),
    dayVolume: posOrNull(entry?.v),
    buyQty: posOrNull(entry?.totalbuyqty),
    sellQty: posOrNull(entry?.totalsellqty),
    futLtp: posOrNull(entry?.ltp),
  };
}
