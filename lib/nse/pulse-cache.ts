/**
 * Shared 30s in-process cache for NSE pulse feeds.
 *
 * Both the /api/nse/pulse/[feed] route (Market Movers page) and the live
 * watchlist builder (/api/live/nse-watchlist) go through here, so they share ONE
 * upstream NSE call per feed per 30s instead of each hitting NSE independently —
 * which is what trips NSE's burst throttle ("operation was aborted"). On a fetch
 * failure the last good value is served (flagged `stale`) if we have one; we
 * never fabricate.
 *
 * ── Why this file also owns coalescing, a failure cooldown and a wait cap ─────
 *
 * A cold miss here is NOT cheap. lib/nse/client.ts warms a session cookie by
 * visiting two nseindia.com pages (6s timeout each) before the 9s API call, and
 * retries the whole thing once on a 401/403 — so a single blocked/slow miss can
 * block its caller for **up to ~42s**. From a datacentre IP (the AWS box) NSE
 * blocks or stalls often, so that is the normal case, not the rare one.
 *
 * That cost used to land inside POST /api/live/quote, which awaited the
 * oi-spurts feed for its display columns. The /live client aborts a quote after
 * 8s (FETCH_TIMEOUT_MS in app/live/_lib/quote-scheduler.ts), so every poll was
 * cancelled mid-flight while the server kept burning a Dhan quote-gate slot —
 * the page showed a wall of `(canceled)` requests with nothing actually broken
 * on the Dhan side. Three guards, all here so every caller gets them:
 *
 *   - **In-flight coalescing.** Concurrent misses share ONE upstream fetch.
 *     Without it, four /live sections × N open windows each started their own
 *     cookie warm-up — the exact stampede that gets us throttled in the first
 *     place.
 *   - **Failure cooldown.** After an upstream failure we serve the last good
 *     value and do not re-attempt for FAILURE_COOLDOWN_MS. Otherwise a blocked
 *     NSE makes *every* request pay the full multi-second penalty, forever.
 *   - **`maxWaitMs`.** A caller can cap how long it is willing to block. On
 *     timeout it gets the cached value (flagged stale) and the fetch keeps
 *     running in the background to populate the cache for the next caller.
 *     Latency-sensitive callers (the /live money path) pass a small cap;
 *     background jobs that must record a genuinely current reading (the Fyers
 *     poller, the trade-suggest scanner) pass nothing and keep blocking.
 *
 * Freshness stays honest: `stale`/`fetchedAt` describe exactly what is being
 * returned, so a caller can never mistake a held-over value for a live one.
 */

import { FEED_FETCHERS, type FeedKey } from '@/lib/nse/pulse';

const FRESH_MS = 30_000;

/**
 * How long to sit out upstream attempts after a failure. Long enough that a
 * blocked NSE costs one slow call per minute instead of one per request; short
 * enough that a transient blip self-heals well inside a trading session.
 */
const FAILURE_COOLDOWN_MS = 60_000;

/**
 * A cached value older than this is not worth serving in place of a real
 * answer: past it, a caller that asked to block waits for the fetch (or fails)
 * rather than being handed something from a different part of the session.
 */
const MAX_SERVE_AGE_MS = 15 * 60_000;

type Entry = { at: number; data: unknown };
const cache = new Map<FeedKey, Entry>();
/** One upstream fetch per feed at a time — every concurrent miss awaits this. */
const inFlight = new Map<FeedKey, Promise<unknown>>();
/** No upstream attempt for this feed before this time (set by a failure). */
const cooldownUntil = new Map<FeedKey, number>();

export interface FeedResult<T> {
  data: T;
  fetchedAt: number;
  cached: boolean;
  stale: boolean;
}

export interface PulseFeedOptions {
  /**
   * Hard cap on how long this caller will block on an upstream fetch. Omit to
   * wait for the fetch to settle (the original behaviour — correct for
   * background jobs that persist the reading). On timeout the cached value is
   * returned flagged `stale`; if there is none, the call throws.
   */
  maxWaitMs?: number;
}

// Health signal: when the last upstream NSE fetch succeeded, and whether the
// most recent attempt fell back to a stale value (NSE throttling / down).
let lastSuccessAt = 0;
let lastError: string | null = null;

/**
 * Indirection so the bench can drive this cache without touching NSE. Real code
 * never reassigns it — scripts/verify-nse-pulse-cache.ts does, via the test seam
 * at the bottom of this file.
 */
let fetchers: Record<string, () => Promise<unknown>> = FEED_FETCHERS;

/**
 * Start (or join) the single upstream fetch for `feed`. Never rejects to the
 * shared slot's joiners in a way that leaves the slot occupied — the slot is
 * always cleared in `finally`.
 */
function refresh(feed: FeedKey): Promise<unknown> {
  const existing = inFlight.get(feed);
  if (existing) return existing;

  const run = (async () => {
    try {
      const data = await fetchers[feed]();
      const at = Date.now();
      cache.set(feed, { at, data });
      cooldownUntil.delete(feed);
      lastSuccessAt = at;
      lastError = null;
      return data;
    } catch (err) {
      lastError = (err as Error).message;
      cooldownUntil.set(feed, Date.now() + FAILURE_COOLDOWN_MS);
      throw err;
    } finally {
      inFlight.delete(feed);
    }
  })();

  inFlight.set(feed, run);
  // A background joiner may be the only holder; keep an unhandled rejection from
  // escaping when every real caller has already timed out and walked away.
  run.catch(() => {});
  return run;
}

/** Fetch one NSE pulse feed through the shared cache. Throws only when it has
 *  nothing to serve — a cold miss whose fetch failed, was cooling down, or
 *  exceeded the caller's `maxWaitMs`. */
export async function getPulseFeed<T = unknown>(
  feed: FeedKey,
  opts: PulseFeedOptions = {},
): Promise<FeedResult<T>> {
  const hit = cache.get(feed);
  const now = Date.now();
  if (hit && now - hit.at < FRESH_MS) {
    return { data: hit.data as T, fetchedAt: hit.at, cached: true, stale: false };
  }

  const servable = hit && now - hit.at < MAX_SERVE_AGE_MS ? hit : null;

  // Cooling off after a failure: don't touch NSE, serve what we have.
  const coolingDown = (cooldownUntil.get(feed) ?? 0) > now && !inFlight.has(feed);
  if (coolingDown) {
    if (servable) return { data: servable.data as T, fetchedAt: servable.at, cached: true, stale: true };
    throw new Error(`NSE ${feed} unavailable (cooling off): ${lastError ?? 'unknown error'}`);
  }

  const pending = refresh(feed);

  try {
    const data = opts.maxWaitMs != null ? await withDeadline(pending, opts.maxWaitMs) : await pending;
    const entry = cache.get(feed);
    const at = entry?.at ?? Date.now();
    return { data: data as T, fetchedAt: at, cached: false, stale: false };
  } catch (err) {
    // Failed, or this caller's deadline expired while the fetch continues in the
    // background. Either way: serve the last good value rather than nothing.
    if (servable) return { data: servable.data as T, fetchedAt: servable.at, cached: true, stale: true };
    throw err;
  }
}

/** Resolve with `p`, or reject once `ms` has elapsed. `p` keeps running — its
 *  result still populates the cache for whoever asks next. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`NSE feed timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Freshness snapshot for the health indicator (no upstream call). */
export function getPulseCacheStatus(): { lastSuccessAt: number; feedsCached: number; lastError: string | null } {
  return { lastSuccessAt, feedsCached: cache.size, lastError };
}

/** Test seam. Never called by application code. */
export function __resetPulseCacheForTest(stub?: Record<string, () => Promise<unknown>>): void {
  cache.clear();
  inFlight.clear();
  cooldownUntil.clear();
  lastSuccessAt = 0;
  lastError = null;
  fetchers = stub ?? FEED_FETCHERS;
}

/** Test seam: plant a cached value of a chosen age, so the bench can exercise
 *  the stale-fallback paths without waiting FRESH_MS in real time. */
export function __seedPulseCacheForTest(feed: FeedKey, data: unknown, ageMs: number): void {
  cache.set(feed, { at: Date.now() - ageMs, data });
}

/** Test seam: the tuning constants the bench asserts against. */
export const __PULSE_CACHE_TUNING = { FRESH_MS, FAILURE_COOLDOWN_MS, MAX_SERVE_AGE_MS } as const;
