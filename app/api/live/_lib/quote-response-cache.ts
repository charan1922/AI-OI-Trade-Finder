/**
 * Shared response cache for POST /api/live/quote — the "N viewers cost the same
 * as 1" layer.
 *
 * Every open /live window polls the same four category watchlists every 7s
 * (QUOTE_POLL_MS in app/live/_hooks/use-category-urgency.ts). Uncached, five
 * windows mean 5× the Dhan quote batches queueing behind the 1 req/sec gate in
 * lib/dhan/market-feed.ts — nothing breaks, but everyone's data goes stale as
 * the queue grows. This cache makes the FIRST request for a symbol list do the
 * real work and every identical request within the TTL share that result:
 *
 *   - TTL 6.5s sits just under the client's 7s poll, so a SINGLE window's own
 *     polls always land after expiry and recompute — its behavior is exactly
 *     what it was before this cache existed. Only additional windows/users hit
 *     the cached copy (they'd have seen data of the same age on their screens
 *     anyway, it just no longer costs extra Dhan calls).
 *   - In-flight coalescing: identical requests that arrive while a compute is
 *     running await the SAME promise instead of starting another compute.
 *   - `fresh: true` (the "Refresh all" button) bypasses a cached entry — a
 *     manual refresh keeps returning brand-new quotes, exactly like today —
 *     but still joins an in-flight compute (that data is being fetched right
 *     now; nothing newer is possible) and stores its result for others.
 *   - Errors are never cached: a failed compute clears its in-flight slot and
 *     propagates, so the next poll retries — same as before.
 *
 * Side effects (recordIntradayOi, addToUniverse, context warming) run inside
 * the compute, i.e. once per TTL per watchlist — the same cadence a single
 * window produced before; the oi_intraday INSERT OR IGNORE bucket dedupe made
 * extra windows harmless anyway, this just stops them from happening.
 *
 * State lives on globalThis (same reason as the Dhan quote gate): Turbopack HMR
 * re-evaluates modules and separate route bundles can hold their own copy — one
 * cache, one process.
 */

/** Just under the /live client's 7s quote poll — see the module comment. */
export const QUOTE_CACHE_TTL_MS = 6_500;

interface CacheEntry {
  at: number;
  payload: unknown;
}

interface CacheState {
  entries: Map<string, CacheEntry>;
  inFlight: Map<string, Promise<unknown>>;
}

const host = globalThis as unknown as { __liveQuoteResponseCache?: CacheState };

function state(): CacheState {
  host.__liveQuoteResponseCache ??= { entries: new Map(), inFlight: new Map() };
  return host.__liveQuoteResponseCache;
}

/** Drop expired entries so the map stays bounded (a handful of watchlist keys). */
function prune(s: CacheState, now: number): void {
  for (const [key, entry] of s.entries) {
    if (now - entry.at >= QUOTE_CACHE_TTL_MS) s.entries.delete(key);
  }
}

/**
 * Return the cached response payload for `key` (the normalized symbol list), or
 * run `compute` and share its result with every identical concurrent request.
 * The payload must be treated as immutable by callers — it is shared.
 */
export async function cachedQuoteResponse<T>(key: string, fresh: boolean, compute: () => Promise<T>): Promise<T> {
  const s = state();

  if (!fresh) {
    const hit = s.entries.get(key);
    if (hit && Date.now() - hit.at < QUOTE_CACHE_TTL_MS) return hit.payload as T;
  }

  // A compute for this exact list is already running — join it (also for
  // `fresh`: that request is fetching live data right now).
  const pending = s.inFlight.get(key);
  if (pending) return pending as Promise<T>;

  const run = (async () => {
    try {
      const payload = await compute();
      const now = Date.now();
      s.entries.set(key, { at: now, payload });
      prune(s, now);
      return payload;
    } finally {
      s.inFlight.delete(key);
    }
  })();
  s.inFlight.set(key, run);
  return run;
}
