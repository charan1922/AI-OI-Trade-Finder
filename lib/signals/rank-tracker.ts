/**
 * Rank tracker — the "running race" leaderboard over time.
 *
 * Every ~5 min (driven by the Fyers poller during market hours) this freezes
 * each F&O name's RANK in each NSE pulse feed (OI-spurts, gainers, losers,
 * most-active). The signal it unlocks is rank *velocity*, not rank *level*: a
 * name climbing #25 → #6 in OI-build over half an hour is getting crowded into
 * RIGHT NOW — the crowd is arriving, and catching it mid-climb front-runs them.
 *
 * Important honesty rules baked in:
 *  - Ranks are within the SAME F&O-tradeable universe /live shows (fno_stocks,
 *    non-'avoid', non-index, live stock future) — a climber you can't trade is
 *    noise. This is ~180 of NSE's ~216-name feed, not our ~70 tracked names.
 *  - A name absent `windowMin` ago is a NEW ENTRANT, flagged separately — never
 *    dressed up as a huge climb (the survivorship trap).
 *  - Participation-side only, same axis as R-Factor: it says WHO is getting
 *    crowded earlier, NOT when to enter. Entry still needs the price gates.
 *
 * Derived-table convention (see oi-intraday.ts): raw CREATE TABLE IF NOT EXISTS
 * via Prisma, mirrored by RankSnapshot in schema.prisma. Retention: today only,
 * pruned by the poller (pruneToDate) — the last session survives the weekend
 * until the next open's first cycle, exactly like fyers_candles.
 */

import { prisma } from '@/lib/db';
import type { ActiveStock, MoverStock, OiStock } from '@/lib/nse/pulse';
import { getPulseFeed } from '@/lib/nse/pulse-cache';

/** The tracked feeds. Keys are stable (stored in the table + API). */
export const RANK_FEEDS = ['oi', 'gainers', 'losers', 'active-value', 'active-volume'] as const;
export type RankFeed = (typeof RANK_FEEDS)[number];

/** Snapshots are floored to this grid (seconds) — matches the poller's 5-min cadence. */
const BUCKET_SEC = 300;

let tableReady = false;

export async function ensureRankSnapshotTable(): Promise<void> {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rank_snapshots (
      date       TEXT    NOT NULL,
      bucketTs   INTEGER NOT NULL,
      feed       TEXT    NOT NULL,
      symbol     TEXT    NOT NULL,
      rank       INTEGER NOT NULL,
      value      REAL,
      capturedAt TEXT    NOT NULL,
      PRIMARY KEY (date, bucketTs, feed, symbol)
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_rank_snapshots_date_feed ON rank_snapshots (date, feed, bucketTs)`);
  tableReady = true;
}

/** Floor an epoch-ms wall clock to the 5-min bucket grid (epoch seconds). */
export function rankBucketFor(nowMs: number): number {
  return Math.floor(nowMs / 1000 / BUCKET_SEC) * BUCKET_SEC;
}

/** The F&O-tradeable gate — same rule as /api/live/nse-watchlist, inlined so
 *  this module stays in lib (no lib→app import). Returns the allowed symbol set. */
async function tradeableFnoSet(): Promise<Set<string>> {
  const fno = await prisma.$queryRawUnsafe<{ symbol: string; tradeBand: string; isIndex: number }[]>(
    `SELECT symbol, tradeBand, isIndex FROM fno_stocks`,
  );
  const liveFut = await prisma.$queryRawUnsafe<{ underlying: string | null }[]>(
    `SELECT DISTINCT underlying FROM master_contracts
       WHERE instrument = 'FUTSTK' AND segment = 'NSE_FNO' AND expiryDate >= date('now')`,
  );
  const hasFut = new Set(liveFut.map((r) => r.underlying).filter((u): u is string => !!u));
  const ok = new Set<string>();
  for (const r of fno) {
    if (Number(r.isIndex) === 1 || r.tradeBand === 'avoid') continue;
    if (!hasFut.has(r.symbol)) continue;
    ok.add(r.symbol);
  }
  return ok;
}

/** One feed's ranked [symbol, value] in NSE's own order (the order /live shows). */
async function rankedFeed(feed: RankFeed): Promise<{ symbol: string; value: number }[]> {
  switch (feed) {
    case 'oi': {
      const oi = (await getPulseFeed<OiStock[]>('oiSpurts')).data ?? [];
      return [...oi]
        .filter((s) => s.symbol && Number.isFinite(s.changeInOiPct))
        .sort((a, b) => b.changeInOiPct - a.changeInOiPct)
        .map((s) => ({ symbol: s.symbol, value: s.changeInOiPct }));
    }
    case 'gainers':
    case 'losers': {
      const grp = (await getPulseFeed<Record<string, MoverStock[]>>(feed)).data.FOSec ?? [];
      return grp.filter((s) => s.symbol).map((s) => ({ symbol: s.symbol, value: s.pctChange }));
    }
    case 'active-value': {
      const a = (await getPulseFeed<ActiveStock[]>('mostActiveValue')).data ?? [];
      return a.filter((s) => s.symbol).map((s) => ({ symbol: s.symbol, value: s.tradedValue }));
    }
    case 'active-volume': {
      const a = (await getPulseFeed<ActiveStock[]>('mostActiveVolume')).data ?? [];
      return a.filter((s) => s.symbol).map((s) => ({ symbol: s.symbol, value: s.volume }));
    }
  }
}

const COLS = 7;
const BATCH_ROWS = 100; // 7 × 100 = 700 params, under SQLite's 999 limit

/**
 * Record one 5-min rank snapshot across all feeds. Best-effort and idempotent:
 * INSERT OR IGNORE on (date, bucketTs, feed, symbol) dedupes repeat calls in the
 * same bucket. Never throws — a feed hiccup must not break the poller cycle.
 * Returns rows attempted.
 */
export async function recordRankSnapshot(date: string, nowMs: number = Date.now()): Promise<number> {
  try {
    await ensureRankSnapshotTable();
    const tradeable = await tradeableFnoSet();
    const bucketTs = rankBucketFor(nowMs);
    const capturedAt = new Date(nowMs).toISOString();

    const rows: { feed: RankFeed; symbol: string; rank: number; value: number }[] = [];
    for (const feed of RANK_FEEDS) {
      const ranked = (await rankedFeed(feed)).filter((r) => tradeable.has(r.symbol));
      ranked.forEach((r, i) => rows.push({ feed, symbol: r.symbol, rank: i + 1, value: r.value }));
    }
    if (rows.length === 0) return 0;

    for (let i = 0; i < rows.length; i += BATCH_ROWS) {
      const chunk = rows.slice(i, i + BATCH_ROWS);
      const placeholders = chunk.map(() => `(${Array(COLS).fill('?').join(',')})`).join(',');
      const params: unknown[] = [];
      for (const r of chunk) params.push(date, bucketTs, r.feed, r.symbol, r.rank, r.value, capturedAt);
      await prisma.$executeRawUnsafe(
        `INSERT OR IGNORE INTO rank_snapshots (date, bucketTs, feed, symbol, rank, value, capturedAt)
         VALUES ${placeholders}`,
        ...params,
      );
    }
    return rows.length;
  } catch (err) {
    console.warn('[rank-tracker] recordRankSnapshot failed:', (err as Error).message);
    return 0;
  }
}

export interface Climber {
  symbol: string;
  rankNow: number;
  /** Rank `windowMin` ago; null when the name wasn't on the board then (new entrant). */
  rankThen: number | null;
  /** Positive = climbed (rank improved). Null for new entrants. */
  delta: number | null;
  valueNow: number;
  isNew: boolean;
}

export interface ClimbersResult {
  feed: RankFeed;
  date: string;
  /** Latest snapshot time (epoch seconds) and the baseline it's compared against. */
  latestTs: number | null;
  baselineTs: number | null;
  windowMin: number;
  climbers: Climber[];
  /** Names new to the board within the window (surfaced separately, never as huge climbs). */
  newEntrants: Climber[];
}

/**
 * Biggest rank *improvements* for `feed` over the trailing `windowMin`. Compares
 * the latest snapshot to the one closest to `windowMin` ago (≥ half the window
 * back, else the oldest available). Climbers (rank went up) sorted by gain;
 * new-to-board names split out separately.
 */
export async function getClimbers(date: string, feed: RankFeed, windowMin = 30, limit = 15): Promise<ClimbersResult> {
  await ensureRankSnapshotTable();
  const empty: ClimbersResult = { feed, date, latestTs: null, baselineTs: null, windowMin, climbers: [], newEntrants: [] };

  // Only compare against HEALTHY buckets. A poller cycle can partially fail (auth
  // hiccup, NSE feed flake) and capture just a handful of names; using such a
  // bucket as "now" or the baseline would flag the whole board as new/climbing
  // (real: reconstructed Jul-10 had 5-name buckets between 166-name ones). Skip
  // any bucket under MIN_HEALTHY of the day's fullest board.
  const bucketRows = await prisma.$queryRawUnsafe<{ bucketTs: number; c: number }[]>(
    `SELECT bucketTs, COUNT(*) AS c FROM rank_snapshots WHERE date = ? AND feed = ? GROUP BY bucketTs ORDER BY bucketTs ASC`,
    date,
    feed,
  );
  if (bucketRows.length === 0) return empty;
  const MIN_HEALTHY = 0.6;
  const maxCount = Math.max(...bucketRows.map((r) => Number(r.c)));
  const buckets = bucketRows.filter((r) => Number(r.c) >= MIN_HEALTHY * maxCount).map((r) => Number(r.bucketTs));
  if (buckets.length === 0) return empty;

  const latestTs = buckets[buckets.length - 1];
  const targetTs = latestTs - windowMin * 60;
  // Newest healthy bucket at or before the target; else the oldest that's ≥ half a window back.
  let baselineTs: number | null = null;
  for (let i = buckets.length - 1; i >= 0; i--) {
    if (buckets[i] <= targetTs) { baselineTs = buckets[i]; break; }
  }
  if (baselineTs == null) {
    const oldest = buckets[0];
    if (latestTs - oldest >= (windowMin * 60) / 2) baselineTs = oldest;
  }
  if (baselineTs == null || baselineTs === latestTs) return { ...empty, latestTs }; // too young to say

  const rows = await prisma.$queryRawUnsafe<{ symbol: string; rank: number; value: number; bucketTs: number }[]>(
    `SELECT symbol, rank, value, bucketTs FROM rank_snapshots
       WHERE date = ? AND feed = ? AND bucketTs IN (?, ?)`,
    date,
    feed,
    latestTs,
    baselineTs,
  );
  const nowBy = new Map<string, { rank: number; value: number }>();
  const thenBy = new Map<string, number>();
  for (const r of rows) {
    if (Number(r.bucketTs) === latestTs) nowBy.set(r.symbol, { rank: Number(r.rank), value: Number(r.value) });
    else thenBy.set(r.symbol, Number(r.rank));
  }

  const climbers: Climber[] = [];
  const newEntrants: Climber[] = [];
  for (const [symbol, cur] of nowBy) {
    const rankThen = thenBy.get(symbol) ?? null;
    if (rankThen == null) {
      newEntrants.push({ symbol, rankNow: cur.rank, rankThen: null, delta: null, valueNow: cur.value, isNew: true });
    } else {
      const delta = rankThen - cur.rank; // + = improved (moved toward #1)
      if (delta > 0) climbers.push({ symbol, rankNow: cur.rank, rankThen, delta, valueNow: cur.value, isNew: false });
    }
  }
  climbers.sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0) || a.rankNow - b.rankNow);
  // New entrants that landed high are the interesting ones — sort by current rank.
  newEntrants.sort((a, b) => a.rankNow - b.rankNow);

  return { feed, date, latestTs, baselineTs, windowMin, climbers: climbers.slice(0, limit), newEntrants: newEntrants.slice(0, limit) };
}

/** Latest session date that has any rank snapshot, newest first. */
export async function getLatestRankDate(): Promise<string | null> {
  await ensureRankSnapshotTable();
  const rows = await prisma.$queryRawUnsafe<{ date: string }[]>(
    `SELECT date FROM rank_snapshots ORDER BY date DESC LIMIT 1`,
  );
  return rows[0]?.date ?? null;
}

/** Retention: drop snapshots for any date other than `today` (poller-driven). */
export async function pruneRankSnapshots(today: string): Promise<number> {
  await ensureRankSnapshotTable();
  return prisma.$executeRawUnsafe(`DELETE FROM rank_snapshots WHERE date != ?`, today);
}
