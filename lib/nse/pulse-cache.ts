/**
 * Shared 30s in-process cache for NSE pulse feeds.
 *
 * Both the /api/nse/pulse/[feed] route (Market Movers page) and the live
 * watchlist builder (/api/live/nse-watchlist) go through here, so they share ONE
 * upstream NSE call per feed per 30s instead of each hitting NSE independently —
 * which is what trips NSE's burst throttle ("operation was aborted"). On a fetch
 * failure the last good value is served (flagged `stale`) if we have one; we
 * never fabricate.
 */

import { FEED_FETCHERS, type FeedKey } from '@/lib/nse/pulse';

const FRESH_MS = 30_000;

type Entry = { at: number; data: unknown };
const cache = new Map<FeedKey, Entry>();

export interface FeedResult<T> {
  data: T;
  fetchedAt: number;
  cached: boolean;
  stale: boolean;
}

// Health signal: when the last upstream NSE fetch succeeded, and whether the
// most recent attempt fell back to a stale value (NSE throttling / down).
let lastSuccessAt = 0;
let lastError: string | null = null;

/** Fetch one NSE pulse feed through the shared cache. Throws only on a cold miss + fetch failure. */
export async function getPulseFeed<T = unknown>(feed: FeedKey): Promise<FeedResult<T>> {
  const hit = cache.get(feed);
  if (hit && Date.now() - hit.at < FRESH_MS) {
    return { data: hit.data as T, fetchedAt: hit.at, cached: true, stale: false };
  }
  try {
    const data = await FEED_FETCHERS[feed]();
    const at = Date.now();
    cache.set(feed, { at, data });
    lastSuccessAt = at;
    lastError = null;
    return { data: data as T, fetchedAt: at, cached: false, stale: false };
  } catch (err) {
    lastError = (err as Error).message;
    if (hit) {
      // NSE throttled this feed — serve its last good value rather than failing.
      return { data: hit.data as T, fetchedAt: hit.at, cached: true, stale: true };
    }
    throw err;
  }
}

/** Freshness snapshot for the health indicator (no upstream call). */
export function getPulseCacheStatus(): { lastSuccessAt: number; feedsCached: number; lastError: string | null } {
  return { lastSuccessAt, feedsCached: cache.size, lastError };
}
