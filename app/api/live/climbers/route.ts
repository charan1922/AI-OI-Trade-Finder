import { type NextRequest, NextResponse } from 'next/server';
import { isMarketHours, todayIST } from '@/lib/dhan/market-feed';
import { getClimbers, getLatestRankDate, RANK_FEEDS, type RankFeed } from '@/lib/signals/rank-tracker';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/live/climbers?feed=oi&window=30
 *
 * The "running race" — biggest RANK IMPROVEMENTS in an NSE pulse feed over the
 * trailing window, from the 5-min rank_snapshots the Fyers poller records. Reads
 * local SQLite only (no Dhan/NSE cost). During market hours it uses today; off
 * hours it serves the last recorded session (frozen), matching the rest of /live.
 *
 * feed:   oi | gainers | losers | active-value | active-volume  (default oi)
 * window: minutes to look back, 10..120                          (default 30)
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const feedParam = (sp.get('feed') ?? 'oi') as RankFeed;
    const feed: RankFeed = RANK_FEEDS.includes(feedParam) ? feedParam : 'oi';
    const window = Math.min(120, Math.max(10, Number(sp.get('window')) || 30));

    // Live during market hours; otherwise the last session that has snapshots.
    const date = isMarketHours() ? todayIST() : ((await getLatestRankDate()) ?? todayIST());
    const result = await getClimbers(date, feed, window);

    return NextResponse.json({ success: true, marketOpen: isMarketHours(), ...result });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
