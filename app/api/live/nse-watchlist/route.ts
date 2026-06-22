import { NextResponse } from 'next/server';
import type { SectorLeadersResponse, SectorPick, WatchlistSource } from '@/app/live/_lib/types';
import type { ActiveStock, MoverStock, OiStock, WeekHighStock } from '@/lib/nse/pulse';
import { getPulseFeed } from '@/lib/nse/pulse-cache';
import { classifyFno, loadFnoUniverse, loadLiveFutureUnderlyings } from '../_lib/fno-universe';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/live/nse-watchlist?source=nse-oi|nse-gainers|nse-losers|nse-active-value|nse-active-volume|nse-52wh
 *
 * Builds a Live Urgency watchlist from one of NSE's live market-pulse feeds (the
 * same feeds the /nse/movers page shows), then gates it to the Live Urgency
 * universe: F&O stocks only, no 'avoid'-band names, and only symbols with a live
 * stock future (so the OI-level column resolves). NSE's ranked order is kept.
 *
 * Returns the same shape as /api/live/sector-leaders so the page renders both
 * source families identically.
 */

const MAX_SYMBOLS = 25;

/**
 * Produce [symbol, pct] in NSE's ranked order for the chosen source. Feeds come
 * through the shared 30s pulse cache, so this reuses whatever the Market Movers
 * page already warmed instead of hitting (and being throttled by) NSE again.
 */
async function rawMovers(source: WatchlistSource): Promise<{ symbol: string; pct: number }[]> {
  switch (source) {
    case 'nse-oi':
      return (await getPulseFeed<OiStock[]>('oiSpurts')).data.map((s) => ({ symbol: s.symbol, pct: s.changeInOiPct }));
    case 'nse-active-value':
      return (await getPulseFeed<ActiveStock[]>('mostActiveValue')).data.map((s) => ({ symbol: s.symbol, pct: s.pctChange }));
    case 'nse-active-volume':
      return (await getPulseFeed<ActiveStock[]>('mostActiveVolume')).data.map((s) => ({ symbol: s.symbol, pct: s.pctChange }));
    case 'nse-gainers':
      // FOSec = NSE's F&O-securities group (the equity-wide list mostly isn't F&O).
      return ((await getPulseFeed<Record<string, MoverStock[]>>('gainers')).data.FOSec ?? []).map((s) => ({ symbol: s.symbol, pct: s.pctChange }));
    case 'nse-losers':
      return ((await getPulseFeed<Record<string, MoverStock[]>>('losers')).data.FOSec ?? []).map((s) => ({ symbol: s.symbol, pct: s.pctChange }));
    case 'nse-52wh':
      return (await getPulseFeed<WeekHighStock[]>('week52High')).data.map((s) => ({ symbol: s.symbol, pct: s.pctChange }));
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
      if (picks.length >= MAX_SYMBOLS) break;
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
    return NextResponse.json(
      { success: false, picks: [], error: (error as Error).message } satisfies SectorLeadersResponse,
      { status: 500 },
    );
  }
}
