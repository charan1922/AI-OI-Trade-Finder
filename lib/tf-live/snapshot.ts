/**
 * TradeFinder's own R-Factor board, ranked, for a given IST trading date.
 *
 * This is the CORROBORATION feed: our engine computes its own R-Factor from
 * Dhan/NSE inputs, and TradeFinder computes theirs from their own. Where the
 * two boards agree on a name, two independent pipelines saw the same
 * participation. Where they disagree, at least one of them is wrong and the
 * name deserves less confidence, not more.
 *
 * WHAT R-FACTOR MEASURES — AND WHAT IT DOES NOT
 * ---------------------------------------------
 * R-Factor is a SIZE-OF-PARTICIPATION number: how much big money is building
 * or adding in a name. It is DIRECTIONLESS. A high R-Factor says "large players
 * are active here", never "this is going up". CROMPTON topped TradeFinder's own
 * board on 2026-08-07 while trading −6.39% on the day — heavy participation, in
 * a fall.
 *
 * So a top rank is never a reason to buy, and a low rank is never a reason to
 * sell. Direction comes from our own signals (bias, breakout, VWAP/Supertrend,
 * OI direction); TradeFinder's rank only corroborates that something worth
 * trading is happening in the name at all. Every string this module produces is
 * worded to keep that distinction, because a rank presented as an endorsement
 * is exactly how a directionless number turns into a bad entry.
 *
 * HARD RULES this module keeps:
 * - It is scoped to ONE DATE. A capture from a previous session is never served
 *   as today's board — an empty result says "no TF data today", which is the
 *   truth, rather than yesterday's ranking dressed as live.
 * - It NEVER fabricates. No captures, an unparseable payload, or a DB error all
 *   return `available: false` with an empty map. Callers must treat that as
 *   missing evidence, not as a pass.
 * - It is evidence only. Nothing here gates, sizes, or selects a trade; the
 *   deterministic scanner in lib/trade-suggest/ still owns every decision.
 *
 * Freshness matters and is reported: `ageMinutes` is how old the capture is.
 * TradeFinder tokens are short-lived and pasted by hand on /tf, so a stale
 * board is a normal state, and a consumer that ignores the age would quietly
 * rank today's trades on a two-hour-old picture.
 */
import { prisma } from '@/lib/db';
import { parseAllSector } from '@/lib/tf-live/parse';

export interface TfSymbolSnapshot {
  rFactor: number;
  /** 1 = highest R-Factor on TradeFinder's board that capture. */
  rank: number;
  pctChange: number | null;
}

export interface TfSnapshot {
  date: string;
  /** False when there is no usable TF capture for this date — treat as no evidence. */
  available: boolean;
  capturedAt: string | null;
  /** Minutes between the capture and `asOfMs`. Null when unavailable. */
  ageMinutes: number | null;
  /** Symbols on the board (ranked). */
  total: number;
  bySymbol: Map<string, TfSymbolSnapshot>;
}

const EMPTY = (date: string): TfSnapshot => ({
  date,
  available: false,
  capturedAt: null,
  ageMinutes: null,
  total: 0,
  bySymbol: new Map(),
});

/** Parsing a ~33KB payload per scan is wasteful when the collector only writes
 *  every 5 min, so the ranked board is memoized briefly. Keyed by date and
 *  invalidated by the capture timestamp, so a fresh capture is never masked. */
interface CacheEntry {
  at: number;
  snapshot: TfSnapshot;
}
const CACHE_TTL_MS = 60_000;
const cacheStore = globalThis as unknown as { __tfSnapshotCache?: Map<string, CacheEntry> };
cacheStore.__tfSnapshotCache ??= new Map();

/**
 * The latest successful `all_sector` capture for `date`, flattened and ranked
 * by TradeFinder's R-Factor (rank 1 = highest).
 */
export async function getTfSnapshot(date: string, asOfMs: number = Date.now()): Promise<TfSnapshot> {
  const cached = cacheStore.__tfSnapshotCache?.get(date);
  if (cached && asOfMs - cached.at < CACHE_TTL_MS) {
    return {
      ...cached.snapshot,
      ageMinutes:
        cached.snapshot.capturedAt == null
          ? null
          : Math.round((asOfMs - new Date(cached.snapshot.capturedAt).getTime()) / 60_000),
    };
  }

  let rows: { capturedAt: string; payloadJson: string | null }[] = [];
  try {
    rows = (await prisma.$queryRawUnsafe(
      `
      SELECT capturedAt, payloadJson
      FROM tf_live_captures
      WHERE endpoint = 'all_sector' AND status = 'success'
        AND date(datetime(capturedAt, '+5 hours', '+30 minutes')) = ?
      ORDER BY capturedAt DESC
      LIMIT 1
    `,
      date
    )) as { capturedAt: string; payloadJson: string | null }[];
  } catch {
    // The table may not exist yet on a box that has never run the collector.
    // Missing TF data must never break a scan.
    return EMPTY(date);
  }

  const row = rows[0];
  if (!row?.payloadJson) return EMPTY(date);

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payloadJson);
  } catch {
    return EMPTY(date);
  }

  const scored = parseAllSector(parsed)
    .filter((r): r is typeof r & { rFactor: number } => r.rFactor != null && Number.isFinite(r.rFactor))
    .sort((a, b) => b.rFactor - a.rFactor);
  if (scored.length === 0) return EMPTY(date);

  const bySymbol = new Map<string, TfSymbolSnapshot>();
  scored.forEach((r, index) => {
    bySymbol.set(r.symbol.toUpperCase(), { rFactor: r.rFactor, rank: index + 1, pctChange: r.pctChange });
  });

  const snapshot: TfSnapshot = {
    date,
    available: true,
    capturedAt: row.capturedAt,
    ageMinutes: Math.round((asOfMs - new Date(row.capturedAt).getTime()) / 60_000),
    total: scored.length,
    bySymbol,
  };
  cacheStore.__tfSnapshotCache?.set(date, { at: asOfMs, snapshot });
  return snapshot;
}

/** Test/ops hook — drops the memoized board so the next read hits the DB. */
export function clearTfSnapshotCache(): void {
  cacheStore.__tfSnapshotCache?.clear();
}

export interface TfCorroboration {
  rFactor: number;
  rank: number;
  total: number;
  /** True when the name sits inside TradeFinder's own top slice. */
  topBoard: boolean;
  ageMinutes: number | null;
  detail: string;
}

/** How many of TradeFinder's ranks count as "on their board" for corroboration. */
export const TF_TOP_BOARD_RANK = 20;

/**
 * Look one pick up against the board. Returns null when TF has nothing for the
 * name — which is genuinely different from "TF ranks it badly", and callers
 * must not conflate the two.
 */
export function corroborateWithTf(snapshot: TfSnapshot, symbol: string): TfCorroboration | null {
  if (!snapshot.available) return null;
  const hit = snapshot.bySymbol.get(symbol.toUpperCase());
  if (!hit) return null;
  const topBoard = hit.rank <= TF_TOP_BOARD_RANK;
  const age = snapshot.ageMinutes == null ? '' : `, TF board ${snapshot.ageMinutes} min old`;
  // Wording is deliberate: "activity/participation", never "confirms the
  // trade". R-Factor is directionless (see the module note) — the top name on
  // TF's board on 2026-08-07 was down 6.4% on the day.
  return {
    rFactor: hit.rFactor,
    rank: hit.rank,
    total: snapshot.total,
    topBoard,
    ageMinutes: snapshot.ageMinutes,
    detail: topBoard
      ? `TradeFinder independently ranks it #${hit.rank} of ${snapshot.total} for big-money ACTIVITY (their R-Factor ${hit.rFactor.toFixed(2)}${age}) — size of participation, not a direction call`
      : `TradeFinder ranks it #${hit.rank} of ${snapshot.total} for big-money activity (their R-Factor ${hit.rFactor.toFixed(2)}${age}) — little institutional participation by their measure; that is a weak-interest flag, NOT a bearish/bullish signal`,
  };
}
