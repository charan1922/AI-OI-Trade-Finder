import { NextResponse } from 'next/server';
import { fetchNseAllIndices } from '@/lib/nse/indices';
import { fetchMarketStatus } from '@/lib/nse/pulse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/nse/heatmap — official NSE indices + market status for the NSE heatmap.
 *
 * Resilience: NSE intermittently slow-walks requests (esp. concurrent ones), so
 *  1. the two upstream calls run SEQUENTIALLY (concurrent hits get throttled),
 *  2. a fresh result is cached for FRESH_MS, and
 *  3. if a refresh fails we serve the LAST GOOD payload marked `stale` rather
 *     than a 502 — the page never blanks once it has loaded once.
 */

const FRESH_MS = 60_000;
let cache: { at: number; payload: Record<string, unknown> } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < FRESH_MS) {
    return NextResponse.json(cache.payload);
  }
  try {
    // Sequential, not Promise.all — NSE throttles concurrent calls on one session.
    const { timestamp, indices } = await fetchNseAllIndices();
    const marketStatus = await fetchMarketStatus().catch(() => null);
    const payload = { success: true, asOf: timestamp, count: indices.length, indices, marketStatus, stale: false };
    cache = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch (error) {
    if (cache) {
      // Serve the last good data instead of failing the page.
      return NextResponse.json({ ...cache.payload, stale: true, staleSince: cache.at });
    }
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 502 });
  }
}
