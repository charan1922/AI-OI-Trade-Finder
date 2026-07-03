/**
 * Morning intraday context for the Live Urgency R-Factor — the breakout factor's
 * reference levels (opening range 9:15–9:45 IST, plus day high/low).
 *
 * Fyers-backed: bars come from the `fyers_candles` store, which the autonomous
 * Fyers poller (lib/fyers/poller.ts) fills full-day every 5 minutes — no Dhan
 * candle calls at all. Symbols not yet tracked are enrolled into the Fyers
 * universe here, so their series (including the opening range, which predates
 * enrollment) backfills on the next 5-min cycle.
 *
 * The derived SessionContext is cached in memory for the per-row, per-poll hot
 * path (computeRFactor reads it synchronously); the refresh cadence matches the
 * poller's 5-min cycle since the underlying data only changes that often.
 */

import { todayIST } from '@/lib/dhan/market-feed';
import { getFyersCandles } from '@/lib/fyers/candle-store';
import { addToUniverse } from '@/lib/fyers/symbols';
import { deriveSessionContext, type SessionContext } from '@/lib/signals/session-context';

/** Re-derive a symbol's context at most this often (fyers_candles updates per 5-min cycle). */
const REFRESH_MS = 5 * 60 * 1000;

interface CachedContext extends SessionContext {
  fetchedAt: number;
}

const cache = new Map<string, CachedContext>();
const inflight = new Set<string>();

const keyFor = (symbol: string): string => `${todayIST()}:${symbol}`;

/** Synchronous read — the cached opening-range / day context for today (or null). */
export function getMorningContext(symbol: string): SessionContext | null {
  return cache.get(keyFor(symbol)) ?? null;
}

/**
 * Ensure this symbol's morning context is derived (or refreshed if stale) from
 * the Fyers store, and that the symbol is enrolled in the Fyers download
 * universe. Returns immediately; the DB read runs in the background. Safe to
 * call often — it no-ops when the cache is fresh or a read is in flight.
 */
export function ensureMorningContext(symbol: string): void {
  const key = keyFor(symbol);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < REFRESH_MS) return;
  if (inflight.has(key)) return;
  inflight.add(key);

  void (async () => {
    try {
      const date = todayIST();
      await addToUniverse([symbol], date);
      const bars = await getFyersCandles(symbol, date, 'EQ');
      if (bars.length > 0) cache.set(key, { ...deriveSessionContext(bars), fetchedAt: Date.now() });
    } catch {
      // Store hiccup — leave the cache as-is; the next poll retries.
    } finally {
      inflight.delete(key);
    }
  })();
}
