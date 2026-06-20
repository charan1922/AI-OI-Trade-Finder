import { NextResponse } from 'next/server';
import { fetchNseAllIndices } from '@/lib/nse/indices';
import { fetchMarketStatus } from '@/lib/nse/pulse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/nse/heatmap — official NSE indices + market status for the NSE heatmap.
 *
 * Pulls allIndices (sector/broad % change) and marketStatus (open/closed, GIFT
 * Nifty, market cap) from NSE's public feed — no Dhan auth. Both share the
 * cookie-cached client, and the result is cached briefly so many tabs collapse
 * into one upstream call.
 */

const CACHE_MS = 30_000;
let cache: { at: number; payload: Record<string, unknown> } | null = null;

export async function GET() {
  try {
    if (cache && Date.now() - cache.at < CACHE_MS) {
      return NextResponse.json(cache.payload);
    }
    const [{ timestamp, indices }, marketStatus] = await Promise.all([
      fetchNseAllIndices(),
      fetchMarketStatus().catch(() => null), // status is a nice-to-have; never fail the heatmap on it
    ]);
    const payload = { success: true, asOf: timestamp, count: indices.length, indices, marketStatus };
    cache = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 502 });
  }
}
