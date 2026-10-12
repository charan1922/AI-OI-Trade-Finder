/**
 * The two NSE lists the /live page shows — "F&O OI Build-up" and "Most Active" —
 * as ONE shared definition, so the page, the /live TF Climbers card and the
 * auto-trader's 8th selector check (operator, 2026-10-12) can never disagree
 * about who is "in the visible list".
 *
 * Visible means exactly what /live renders: NSE's ranked feed (OI Build-up =
 * the top 24 by OI change %, Most Active ≈ 20 names by value or volume) filtered
 * to the Live Urgency universe — F&O only, no indices, no 'avoid' lot band, and
 * a live stock future. NSE's rank order is kept (rank 1 = top of the list).
 *
 * LIVE ONLY. These are NSE's live feeds; there is no per-minute history of the
 * Most Active list (the OI list can be approximated from fyers_candles.nseOiPct,
 * see scripts/replay-tf-selector.ts). A stale list is refused, never served as
 * current: past NSE_LIST_MAX_AGE_MS the loader returns null and callers treat
 * the membership as UNKNOWN (the selector rejects on unknown).
 */
import {
  classifyFno,
  loadFnoUniverse,
  loadLiveFutureUnderlyings,
  type FnoMeta,
} from '@/app/api/live/_lib/fno-universe';
import { LIVE_PATH_NSE_WAIT_MS } from '@/lib/nse/combined-oi';
import type { ActiveStock, OiStock } from '@/lib/nse/pulse';
import { getPulseFeed } from '@/lib/nse/pulse-cache';

/** /nse/movers and /live show only the top 24 OI-build-up names. */
export const OI_DISPLAY = 24;
/** A list older than this is not "the visible list" any more — membership becomes unknown. */
export const NSE_LIST_MAX_AGE_MS = 10 * 60_000;

const WAIT = { maxWaitMs: LIVE_PATH_NSE_WAIT_MS } as const;

export interface RankedMover {
  symbol: string;
  pct: number;
}

/** OI Build-up in NSE's panel order: signed OI change desc, top 24. */
export async function oiMovers(): Promise<{ movers: RankedMover[]; fetchedAt: number }> {
  const feed = await getPulseFeed<OiStock[]>('oiSpurts', WAIT);
  const movers = [...feed.data]
    .sort((a, b) => b.changeInOiPct - a.changeInOiPct)
    .slice(0, OI_DISPLAY)
    .map((s) => ({ symbol: s.symbol, pct: s.changeInOiPct }));
  return { movers, fetchedAt: feed.fetchedAt };
}

/** Most Active in NSE's order, by traded value or by volume. */
export async function activeMovers(by: 'value' | 'volume'): Promise<{ movers: RankedMover[]; fetchedAt: number }> {
  const feed = await getPulseFeed<ActiveStock[]>(by === 'value' ? 'mostActiveValue' : 'mostActiveVolume', WAIT);
  return { movers: feed.data.map((s) => ({ symbol: s.symbol, pct: s.pctChange })), fetchedAt: feed.fetchedAt };
}

export interface VisiblePick {
  symbol: string;
  sector: string;
  pct: number;
}

/**
 * NSE's ranked list → the names /live actually shows. PURE. De-duplicates, drops
 * non-F&O / index / 'avoid' names and names without a live future, keeps NSE's
 * order. `excludedAvoid` feeds the page's "avoid band" counter.
 */
export function filterToLiveUniverse(
  raw: readonly RankedMover[],
  fno: ReadonlyMap<string, FnoMeta>,
  liveFut: ReadonlySet<string>
): { picks: VisiblePick[]; excludedAvoid: number } {
  const picks: VisiblePick[] = [];
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
    picks.push({ symbol, sector: meta!.sector, pct });
  }
  return { picks, excludedAvoid };
}

/** Which visible list(s) a name is in. Ranks are 1-based within the VISIBLE list. */
export interface NseListMembership {
  /** Rank in the visible F&O OI Build-up list, or null when not in it (or the list is unavailable). */
  oiBuildupRank: number | null;
  /** Best rank in the visible Most Active lists (value or volume), or null. */
  mostActiveRank: number | null;
  /**
   * True when EVERY list could be read fresh. A name found in no list is only
   * "in neither" when this is true; with a list missing it is UNKNOWN (the
   * selector rejects it as such, never as "not in the lists").
   */
  complete: boolean;
}

/** Each list is null when its feed was unavailable or older than NSE_LIST_MAX_AGE_MS. */
export interface VisibleNseLists {
  oiBuildup: readonly string[] | null;
  mostActiveValue: readonly string[] | null;
  mostActiveVolume: readonly string[] | null;
}

/** Membership of one symbol. PURE — shared by the card, the engine and the tests. */
export function listMembership(lists: VisibleNseLists, symbol: string): NseListMembership {
  const rank = (list: readonly string[] | null) => {
    if (list == null) return null;
    const i = list.indexOf(symbol);
    return i < 0 ? null : i + 1;
  };
  const value = rank(lists.mostActiveValue);
  const volume = rank(lists.mostActiveVolume);
  return {
    oiBuildupRank: rank(lists.oiBuildup),
    mostActiveRank: value == null ? volume : volume == null ? value : Math.min(value, volume),
    complete: lists.oiBuildup != null && lists.mostActiveValue != null && lists.mostActiveVolume != null,
  };
}

/** One NSE feed read: its ranked movers and when NSE was actually asked (not when we looked). */
export interface FeedRead {
  movers: RankedMover[];
  fetchedAt: number;
}

/**
 * The freshness + per-feed-failure rule, PURE so CI proves it. A feed that is
 * missing (null — it failed) or older than NSE_LIST_MAX_AGE_MS (exactly the limit
 * is still fresh) becomes a null list; the others still count. Returns null only
 * when NO feed is usable.
 */
export function assembleVisibleLists(
  reads: { oi: FeedRead | null; value: FeedRead | null; volume: FeedRead | null },
  fno: ReadonlyMap<string, FnoMeta>,
  liveFut: ReadonlySet<string>,
  nowMs: number
): VisibleNseLists | null {
  const visible = (read: FeedRead | null): string[] | null =>
    read == null || !(nowMs - read.fetchedAt <= NSE_LIST_MAX_AGE_MS)
      ? null
      : filterToLiveUniverse(read.movers, fno, liveFut).picks.map((p) => p.symbol);
  const lists = {
    oiBuildup: visible(reads.oi),
    mostActiveValue: visible(reads.value),
    mostActiveVolume: visible(reads.volume),
  };
  return lists.oiBuildup == null && lists.mostActiveValue == null && lists.mostActiveVolume == null ? null : lists;
}

/**
 * Load the visible lists NOW. Each feed stands alone (NSE blocks the box often): one
 * that throws becomes null and the others still count. Never throws.
 */
export async function loadVisibleNseLists(nowMs: number = Date.now()): Promise<VisibleNseLists | null> {
  try {
    const [fno, liveFut] = await Promise.all([loadFnoUniverse(), loadLiveFutureUnderlyings()]);
    const read = async (get: () => Promise<FeedRead>): Promise<FeedRead | null> => {
      try {
        return await get();
      } catch (error) {
        console.warn(`[NseLists] a feed is unavailable: ${(error as Error).message}`);
        return null;
      }
    };
    const [oi, value, volume] = await Promise.all([
      read(oiMovers),
      read(() => activeMovers('value')),
      read(() => activeMovers('volume')),
    ]);
    return assembleVisibleLists({ oi, value, volume }, fno, liveFut, nowMs);
  } catch (error) {
    console.warn(`[NseLists] visible lists unavailable: ${(error as Error).message}`);
    return null;
  }
}
