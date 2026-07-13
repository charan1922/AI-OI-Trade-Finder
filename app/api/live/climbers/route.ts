import { type NextRequest, NextResponse } from 'next/server';
import { isMarketHours, todayIST } from '@/lib/dhan/market-feed';
import { getLatestRankDate, getRaceSinceOpen, RANK_FEEDS, type RankFeed } from '@/lib/signals/rank-tracker';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/live/climbers?feed=oi
 *
 * The "running race" measured FROM MARKET OPEN — each F&O name's rank at every
 * 5-min check today, how far it has climbed since the open, re-ranked biggest
 * climber first. Built from the 5-min rank_snapshots the Fyers poller records.
 * Reads local SQLite only (no Dhan/NSE cost). During market hours it uses today;
 * off hours it serves the last recorded session (frozen), like the rest of /live.
 *
 * feed: oi | gainers | losers | active-value | active-volume  (default oi)
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const feedParam = (sp.get('feed') ?? 'oi') as RankFeed;
    const feed: RankFeed = RANK_FEEDS.includes(feedParam) ? feedParam : 'oi';

    // Live during market hours; otherwise the last session that has snapshots.
    const date = isMarketHours() ? todayIST() : ((await getLatestRankDate()) ?? todayIST());
    const result = await getRaceSinceOpen(date, feed, 15, 20); // top 15 climbers now inside the top 20

    return NextResponse.json({ success: true, marketOpen: isMarketHours(), ...result });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
