import { NextResponse } from 'next/server';
import type { SectorLeadersResponse, SectorPick, WatchlistSource } from '@/app/live/_lib/types';
import type { ActiveStock, MoverStock, OiStock } from '@/lib/nse/pulse';
import { LIVE_PATH_NSE_WAIT_MS } from '@/lib/nse/combined-oi';
import { getPulseFeed } from '@/lib/nse/pulse-cache';
import { classifyFno, loadFnoUniverse, loadLiveFutureUnderlyings } from '../_lib/fno-universe';

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

// /nse/movers shows only the top 24 OI-build-up names (oiBuildup.slice(0, 24));
// mirror that here so /live matches the page instead of dumping the 216-row feed.
const OI_DISPLAY = 24;

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

async function oiMovers(): Promise<{ symbol: string; pct: number }[]> {
  // Signed change desc (biggest OI gains first), top 24 — the panel's exact view.
  const oi = (await getPulseFeed<OiStock[]>('oiSpurts', WAIT)).data;
  return [...oi]
    .sort((a, b) => b.changeInOiPct - a.changeInOiPct)
    .slice(0, OI_DISPLAY)
    .map((s) => ({ symbol: s.symbol, pct: s.changeInOiPct }));
}

async function activeMovers(by: 'value' | 'volume'): Promise<{ symbol: string; pct: number }[]> {
  const feed = by === 'value' ? 'mostActiveValue' : 'mostActiveVolume';
  return (await getPulseFeed<ActiveStock[]>(feed, WAIT)).data.map((s) => ({ symbol: s.symbol, pct: s.pctChange }));
}

async function moverGroup(kind: 'gainers' | 'losers'): Promise<{ symbol: string; pct: number }[]> {
  // FOSec = NSE's F&O-securities group (the equity-wide list mostly isn't F&O).
  return ((await getPulseFeed<Record<string, MoverStock[]>>(kind, WAIT)).data.FOSec ?? []).map((s) => ({ symbol: s.symbol, pct: s.pctChange }));
}

/** Produce [symbol, pct] in NSE's ranked order for the chosen source. */
async function rawMovers(source: WatchlistSource): Promise<{ symbol: string; pct: number }[]> {
  switch (source) {
    case 'nse-oi':
      return oiMovers();
    case 'nse-active-value':
      return activeMovers('value');
    case 'nse-active-volume':
      return activeMovers('volume');
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

    const picks: SectorPick[] = [];
    const seen = new Set<string>();
    let excludedAvoid = 0;
    for (const { symbol, pct } of raw) {
      if (seen.has(symbol)) continue;
      const meta = fno.get(symbol);
      const cls = classifyFno(meta);
      if (!cls.ok) {
        if (cls.reason === 'avoid') excludedAvoid++;
        continue;
      }
      if (!liveFut.has(symbol)) continue; // no live future → OI level can't resolve
      seen.add(symbol);
      picks.push({ symbol, sector: meta!.sector, retPct: pct });
    }

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
