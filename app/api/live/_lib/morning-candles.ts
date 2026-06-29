/**
 * Morning intraday context for the Live Urgency R-Factor — the breakout factor's
 * reference levels (opening range 9:15–9:45 IST, plus day high/low).
 *
 * This is the Dhan-aware companion to the pure DB store in
 * `lib/signals/intraday-candles.ts`. It:
 *   1. fetches a stock's day-so-far 5-min bars from Dhan (charts/intraday) — needed
 *      because the opening range may predate when /live started polling,
 *   2. PERSISTS them to `intraday_candles` (authoritative 'rest' bars), so the
 *      series is durable and available to the agent / endpoint at any time,
 *   3. caches the derived SessionContext in memory for the per-row, per-poll hot
 *      path (computeRFactor reads it synchronously).
 *
 * Fetching is bounded by the caller (on-demand or top-N), NOT one-per-displayed
 * stock — so candle load is decoupled from universe size. The live quote route
 * additionally folds each poll into the same store (`upsertLiveBar`), keeping the
 * current bar fresh between these REST refreshes with zero extra Dhan calls.
 */

import { fetchIntradayCandles, todayIST } from '@/lib/dhan/market-feed';
import {
  type Candle,
  deriveSessionContext,
  getIntradayCandles,
  recordBackfill,
  type SessionContext,
} from '@/lib/signals/intraday-candles';

/** Re-fetch a symbol's Dhan bars at most this often (extends the day range). */
const REFRESH_MS = 10 * 60 * 1000;
/** Space background Dhan fetches ≥150ms apart (Data API is 10/sec). */
const RATE_MS = 150;

interface CachedContext extends SessionContext {
  fetchedAt: number;
}

const cache = new Map<string, CachedContext>();
const inflight = new Set<string>();
let fetchChain: Promise<unknown> = Promise.resolve();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const keyFor = (symbol: string): string => `${todayIST()}:${symbol}`;

/** Synchronous read — the cached opening-range / day context for today (or null). */
export function getMorningContext(symbol: string): SessionContext | null {
  return cache.get(keyFor(symbol)) ?? null;
}

/**
 * Fetch a symbol's day-so-far 5-min bars from Dhan, persist them to the store, and
 * return them. The single Dhan touch-point for candles; everything else reads the
 * store. Returns [] if auth/data is unavailable.
 */
export async function fetchAndStoreCandles(symbol: string, equitySecurityId: number): Promise<Candle[]> {
  const date = todayIST();
  const raw = await fetchIntradayCandles(equitySecurityId, '5');
  if (raw.length > 0) {
    await recordBackfill(
      symbol,
      date,
      raw.map((c) => ({
        bucketTs: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
    );
  }
  return getIntradayCandles(symbol, date);
}

/**
 * Ensure this symbol's morning context is fetched (or refreshed if stale). Returns
 * immediately; the fetch runs on a background, rate-limited chain. Safe to call
 * often — it no-ops when the cache is fresh or a fetch is already in flight.
 */
export function ensureMorningContext(symbol: string, equitySecurityId: number): void {
  if (!(equitySecurityId > 0)) return;
  const key = keyFor(symbol);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < REFRESH_MS) return;
  if (inflight.has(key)) return;
  inflight.add(key);

  fetchChain = fetchChain.then(async () => {
    try {
      await sleep(RATE_MS);
      const bars = await fetchAndStoreCandles(symbol, equitySecurityId);
      if (bars.length > 0) cache.set(key, { ...deriveSessionContext(bars), fetchedAt: Date.now() });
    } catch {
      // Transient Dhan/Data-API hiccup — leave the cache as-is; the next poll retries.
    } finally {
      inflight.delete(key);
    }
  });
}
