import { NextResponse } from 'next/server';
import { FEED_FETCHERS, type FeedKey } from '@/lib/nse/pulse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/nse/pulse/[feed] — a single NSE market-pulse feed, fetched independently.
 *
 * One feed = one upstream NSE call. Each feed is cached on its own so a throttled
 * feed fails alone instead of blanking the page, and a fresh request for one feed
 * doesn't re-pull the others. We never fabricate: on a fetch failure we serve the
 * last good cached value (flagged `stale`) if we have one, else a 502.
 */

const FRESH_MS = 30_000;

type Entry = { at: number; data: unknown };
const cache = new Map<FeedKey, Entry>();

export async function GET(_req: Request, ctx: { params: Promise<{ feed: string }> }) {
  const { feed } = await ctx.params;
  const fetcher = FEED_FETCHERS[feed as FeedKey];
  if (!fetcher) {
    return NextResponse.json({ success: false, error: `Unknown feed "${feed}"` }, { status: 404 });
  }
  const key = feed as FeedKey;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) {
    return NextResponse.json({ success: true, feed: key, data: hit.data, fetchedAt: hit.at, cached: true });
  }

  try {
    const data = await fetcher();
    const at = Date.now();
    cache.set(key, { at, data });
    return NextResponse.json({ success: true, feed: key, data, fetchedAt: at, cached: false });
  } catch (error) {
    if (hit) {
      // NSE throttled this one feed — serve its last good value rather than blanking it.
      return NextResponse.json({ success: true, feed: key, data: hit.data, fetchedAt: hit.at, stale: true });
    }
    return NextResponse.json({ success: false, feed: key, error: (error as Error).message }, { status: 502 });
  }
}
