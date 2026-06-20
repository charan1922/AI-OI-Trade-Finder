import { NextResponse } from 'next/server';
import { fetchNseAllIndices } from '@/lib/nse/indices';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/nse-heatmap — official NSE index data for the NSE Heatmap page.
 *
 * Pure passthrough of NSE's public `allIndices` feed (broad + sectoral + thematic
 * indices, each with NSE's own % change vs the prior close). Works 24/7, no Dhan
 * auth involved. Cached briefly so multiple tabs collapse into one upstream call.
 */

const CACHE_MS = 30_000;
let cache: { at: number; payload: Record<string, unknown> } | null = null;

export async function GET() {
  try {
    if (cache && Date.now() - cache.at < CACHE_MS) {
      return NextResponse.json(cache.payload);
    }
    const { timestamp, indices } = await fetchNseAllIndices();
    const payload = {
      success: true,
      asOf: timestamp,
      count: indices.length,
      indices,
    };
    cache = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 502 },
    );
  }
}
