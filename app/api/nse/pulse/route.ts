import { NextResponse } from 'next/server';
import { fetchNsePulse } from '@/lib/nse/pulse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/nse/pulse — market-movers dashboard data from NSE's public feeds:
 * top gainers/losers, most-active (value & volume), 52-week highs, F&O OI spurts,
 * plus market status. All NSE-only, no Dhan auth. Cached ~45s.
 */

const CACHE_MS = 45_000;
let cache: { at: number; payload: Record<string, unknown> } | null = null;

export async function GET() {
  try {
    if (cache && Date.now() - cache.at < CACHE_MS) {
      return NextResponse.json(cache.payload);
    }
    const pulse = await fetchNsePulse();
    const payload = { success: true, ...pulse };
    cache = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 502 });
  }
}
