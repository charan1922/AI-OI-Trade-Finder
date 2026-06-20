import { NextResponse } from 'next/server';
import { fetchNsePulse } from '@/lib/nse/pulse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/nse/pulse — market-movers dashboard data from NSE's public feeds:
 * top gainers/losers, most-active (value & volume), 52-week highs, F&O OI spurts,
 * plus market status. All NSE-only, no Dhan auth.
 *
 * One build = ~7 upstream NSE calls, so cache generously (FRESH_MS); and if a
 * refresh fails, serve the last good payload marked `stale` rather than a 502.
 */

const FRESH_MS = 60_000;
let cache: { at: number; payload: Record<string, unknown> } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < FRESH_MS) {
    return NextResponse.json(cache.payload);
  }
  try {
    const pulse = await fetchNsePulse();
    const payload = { success: true, ...pulse, stale: false };
    cache = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch (error) {
    if (cache) {
      return NextResponse.json({ ...cache.payload, stale: true, staleSince: cache.at });
    }
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 502 });
  }
}
