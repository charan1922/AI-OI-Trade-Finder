import type { LiveQuoteResponse } from './types';

/**
 * One POST /api/live/quote for one /live section — called by each section on
 * its own, with no queue shared between them (operator request, 2026-10-08:
 * the four tables must be independent, so one slow table never holds up the
 * other three).
 *
 * Why no queue: the route makes NO broker call any more. It reads the
 * `fyers_candles` rows the Fyers poller records every 5 minutes, plus SQLite
 * baselines and the 30s NSE cache. The serial 1-request-per-1.1s queue this
 * replaced existed only to keep Dhan's Quote API under 1 req/sec; after the
 * Fyers migration it protected nothing and made every section wait behind the
 * others — up to FETCH_TIMEOUT_MS each when one stalled. Server-side, identical
 * symbol sets still share one computation (app/api/live/_lib/quote-response-cache.ts).
 *
 * `fresh` marks a MANUAL refresh ("Refresh all"): it bypasses that shared
 * response cache. Steady polls omit it.
 */

/** Per-request cap, so a stalled request ends as an error instead of a spinner. */
export const FETCH_TIMEOUT_MS = 8000;

export async function fetchLiveQuote(symbols: string[], fresh = false): Promise<LiveQuoteResponse> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch('/api/live/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fresh ? { symbols, fresh: true } : { symbols }),
      signal: ctrl.signal,
    });
    return (await res.json()) as LiveQuoteResponse;
  } finally {
    clearTimeout(timeout);
  }
}
