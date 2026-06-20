import { NextResponse } from 'next/server';
import { fetchNsePulse, type NsePulse } from '@/lib/nse/pulse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/nse/pulse — market-movers dashboard data from NSE's public feeds.
 *
 * One build = ~7 upstream NSE calls. NSE throttles per-endpoint, so a refresh can
 * come back with some feeds populated and others momentarily empty. We never
 * fabricate — instead:
 *  1. cache a fresh build for FRESH_MS,
 *  2. per-feed backfill: any feed that returns empty is filled from the last good
 *     fetch and the payload is marked `stale`, so a throttled endpoint doesn't
 *     blank a whole panel, and
 *  3. on a total failure, serve the last cached payload rather than a 502.
 */

const FRESH_MS = 60_000;
let cache: { at: number; payload: Record<string, unknown> } | null = null;
let lastGood: NsePulse | null = null;

const hasGroups = (r?: Record<string, unknown[]>) =>
  !!r && Object.values(r).some((a) => Array.isArray(a) && a.length > 0);

/** Fill empty feeds from the previous good fetch; flag `stale` if anything was backfilled. */
function merge(fresh: NsePulse): { pulse: NsePulse; stale: boolean } {
  const prev = lastGood;
  if (!prev) return { pulse: fresh, stale: false };
  let stale = false;
  const arr = <T,>(a: T[], b: T[]): T[] => {
    if (a.length === 0 && b.length > 0) {
      stale = true;
      return b;
    }
    return a;
  };
  if (!fresh.marketStatus && prev.marketStatus) stale = true;
  const gainersEmpty = !hasGroups(fresh.gainers) && hasGroups(prev.gainers);
  const losersEmpty = !hasGroups(fresh.losers) && hasGroups(prev.losers);
  if (gainersEmpty || losersEmpty) stale = true;

  const pulse: NsePulse = {
    asOf: fresh.asOf ?? prev.asOf,
    marketStatus: fresh.marketStatus ?? prev.marketStatus,
    gainers: gainersEmpty ? prev.gainers : fresh.gainers,
    losers: losersEmpty ? prev.losers : fresh.losers,
    mostActiveValue: arr(fresh.mostActiveValue, prev.mostActiveValue),
    mostActiveVolume: arr(fresh.mostActiveVolume, prev.mostActiveVolume),
    week52High: arr(fresh.week52High, prev.week52High),
    oiSpurts: arr(fresh.oiSpurts, prev.oiSpurts),
  };
  return { pulse, stale };
}

export async function GET() {
  if (cache && Date.now() - cache.at < FRESH_MS) {
    return NextResponse.json(cache.payload);
  }
  try {
    const fresh = await fetchNsePulse();
    const { pulse, stale } = merge(fresh);
    lastGood = pulse; // best-known value per feed
    const payload = { success: true, ...pulse, stale };
    cache = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch (error) {
    if (cache) {
      return NextResponse.json({ ...cache.payload, stale: true });
    }
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 502 });
  }
}
