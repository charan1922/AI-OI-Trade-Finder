import { NextResponse } from 'next/server';
import { FEED_FETCHERS, type FeedKey } from '@/lib/nse/pulse';
import { getPulseFeed } from '@/lib/nse/pulse-cache';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/nse/pulse/[feed] — a single NSE market-pulse feed, fetched independently.
 *
 * One feed = one upstream NSE call, shared through a 30s in-process cache (see
 * lib/nse/pulse-cache) so a fresh request for one feed doesn't re-pull the others
 * and the live watchlist builder reuses the same warm data. We never fabricate:
 * on a fetch failure we serve the last good cached value (flagged `stale`) if we
 * have one, else a 502.
 */

export async function GET(_req: Request, ctx: { params: Promise<{ feed: string }> }) {
  const { feed } = await ctx.params;
  if (!FEED_FETCHERS[feed as FeedKey]) {
    return NextResponse.json({ success: false, error: `Unknown feed "${feed}"` }, { status: 404 });
  }
  const key = feed as FeedKey;

  try {
    const r = await getPulseFeed(key);
    return NextResponse.json({
      success: true,
      feed: key,
      data: r.data,
      fetchedAt: r.fetchedAt,
      cached: r.cached,
      stale: r.stale,
    });
  } catch (error) {
    return NextResponse.json({ success: false, feed: key, error: (error as Error).message }, { status: 502 });
  }
}
