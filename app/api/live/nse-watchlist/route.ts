import { NextResponse } from 'next/server';
import type { SectorLeadersResponse, SectorPick, WatchlistSource } from '@/app/live/_lib/types';
import type { MoverStock } from '@/lib/nse/pulse';
import { LIVE_PATH_NSE_WAIT_MS } from '@/lib/nse/combined-oi';
import { activeMovers, filterToLiveUniverse, oiMovers } from '@/lib/nse/live-lists';
import { getPulseFeed } from '@/lib/nse/pulse-cache';
import { loadFnoUniverse, loadLiveFutureUnderlyings } from '../_lib/fno-universe';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/live/nse-watchlist?source=nse-oi|nse-gainers|nse-losers|nse-active-value|nse-active-volume
 *
 * Builds a Live Urgency watchlist from one of NSE's live market-pulse feeds — the
 * SAME lists the /nse/movers page shows, capped to the same sizes that page
 * displays (OI build-up = top 24; the rest are NSE's ~20-name lists). The /live
 * page loads one of these per category section.
 *
 * The result is gated to the Live Urgency universe: F&O stocks only, no
 * 'avoid'-band names, and only symbols with a live stock future (so the OI-level
 * column resolves). NSE's ranked order is kept.
 *
 * Returns the same shape as /api/live/sector-leaders. The quote API batches a
 * section's whole list into one request, so symbol count never multiplies Dhan calls.
 */

/**
 * Per-feed lists in NSE's ranked order, each EXACTLY what the matching /nse/movers
 * panel displays. Feeds come through the shared 30s pulse cache, so this reuses
 * whatever the Market Movers page already warmed instead of hitting (and being
 * throttled by) NSE again.
 *
 * Every read is capped at LIVE_PATH_NSE_WAIT_MS: this route builds the /live
 * watchlists, so it sits on the page's critical path alongside the quote poll,
 * and a stalled NSE miss (see lib/nse/pulse-cache.ts) must not hold the page.
 * Past the cap the last captured list is served and the fetch completes in the
 * background.
 */
const WAIT = { maxWaitMs: LIVE_PATH_NSE_WAIT_MS } as const;

async function moverGroup(kind: 'gainers' | 'losers'): Promise<{ symbol: string; pct: number }[]> {
  // FOSec = NSE's F&O-securities group (the equity-wide list mostly isn't F&O).
  return ((await getPulseFeed<Record<string, MoverStock[]>>(kind, WAIT)).data.FOSec ?? []).map((s) => ({ symbol: s.symbol, pct: s.pctChange }));
}

/** Produce [symbol, pct] in NSE's ranked order for the chosen source. */
async function rawMovers(source: WatchlistSource): Promise<{ symbol: string; pct: number }[]> {
  switch (source) {
    case 'nse-oi':
      return (await oiMovers()).movers;
    case 'nse-active-value':
      return (await activeMovers('value')).movers;
    case 'nse-active-volume':
      return (await activeMovers('volume')).movers;
    case 'nse-gainers':
      return moverGroup('gainers');
    case 'nse-losers':
      return moverGroup('losers');
    default:
      return [];
  }
}

export async function GET(req: Request) {
  try {
    const source = (new URL(req.url).searchParams.get('source') ?? '') as WatchlistSource;
    if (!source.startsWith('nse-')) {
      return NextResponse.json(
        { success: false, picks: [], error: `Unknown NSE source "${source}"` } satisfies SectorLeadersResponse,
        { status: 400 },
      );
    }

    const raw = await rawMovers(source);
    // DB-only (not Dhan) — safe to run together.
    const [fno, liveFut] = await Promise.all([loadFnoUniverse(), loadLiveFutureUnderlyings()]);

    // The SAME filter the auto-trader's 8th check uses (lib/nse/live-lists.ts), so the
    // page and the engine cannot disagree about who is in the visible list.
    const { picks: visible, excludedAvoid } = filterToLiveUniverse(raw, fno, liveFut);
    const picks: SectorPick[] = visible.map((p) => ({ symbol: p.symbol, sector: p.sector, retPct: p.pct }));

    const resp: SectorLeadersResponse = {
      success: true,
      picks,
      meta: {
        source,
        sectorsCovered: new Set(picks.map((p) => p.sector)).size,
        candidates: raw.length,
        excludedAvoid,
      },
    };
    return NextResponse.json(resp);
  } catch (error) {
    // A cold-cache miss while NSE is throttling/slow → the upstream fetch times
    // out (~9s). It's an NSE-side hiccup, not a bug — 502 (bad gateway), with a
    // message the page can show. Pre-warming on the live page makes this rare.
    return NextResponse.json(
      {
        success: false,
        picks: [],
        error: `NSE feed didn't respond (likely throttled) — try again in a moment. [${(error as Error).message}]`,
      } satisfies SectorLeadersResponse,
      { status: 502 },
    );
  }
}
