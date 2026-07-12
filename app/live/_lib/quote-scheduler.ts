import type { LiveQuoteResponse } from './types';

/**
 * Dhan's Quote API is capped at 1 request/second. The Live Urgency page polls
 * several category sections independently (OI build-up, most active, gainers,
 * losers), each fetching live depth for its own symbol set. Left uncoordinated,
 * their timers can align and fire four quote requests in the same instant → an
 * immediate 429.
 *
 * Every section's quote fetch passes through this single choke point: requests run
 * one at a time (chained) AND no sooner than MIN_INTERVAL_MS after the previous
 * dispatch, so the page can never exceed Dhan's limit no matter how the section
 * timers line up. State is module-level on purpose — one queue shared across all
 * sections / hook instances on the page.
 */

const MIN_INTERVAL_MS = 1100; // a hair over 1s to absorb timer jitter
// Cap a single request so one hung quote can't stall every section behind it in
// the serial queue (the dispatch then errors out and the queue moves on).
const FETCH_TIMEOUT_MS = 8000;

// Tail of the serial chain; each new request appends to it. Never rejects (a
// failed task is isolated below) so one section's error can't stall the queue.
let tail: Promise<unknown> = Promise.resolve();
let lastDispatchAt = 0;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Enqueue a POST /api/live/quote for `symbols`. Resolves with the parsed response
 * once this request reaches the front of the queue and ≥ MIN_INTERVAL_MS has
 * elapsed since the previous dispatch. Start-to-start spacing + serial execution
 * together guarantee ≤ 1 request/second.
 *
 * `fresh` marks a MANUAL refresh ("Refresh all"): it bypasses the server's
 * shared response cache (app/api/live/_lib/quote-response-cache.ts) so the
 * click keeps returning brand-new quotes exactly as it did before that cache
 * existed. Steady polls omit it and share results across windows/users.
 */
export function scheduleQuote(symbols: string[], fresh = false): Promise<LiveQuoteResponse> {
  const run = tail.then(async (): Promise<LiveQuoteResponse> => {
    const wait = lastDispatchAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastDispatchAt = Date.now();
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
  });
  // Keep the chain alive regardless of this task's outcome.
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
