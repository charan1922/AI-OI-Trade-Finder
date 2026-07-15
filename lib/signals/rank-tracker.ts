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
 * via Prisma, mirrored by RankSnapshot in schema.prisma. The newest 20 recorded
 * sessions are retained so replay candidate membership is point-in-time rather
 * than reconstructed from an end-of-day survivor set.
 */

import { prisma } from '@/lib/db';
import type { ActiveStock, MoverStock, OiStock } from '@/lib/nse/pulse';
import { getPulseFeed } from '@/lib/nse/pulse-cache';

/** The tracked feeds. Keys are stable (stored in the table + API). */
export const RANK_FEEDS = ['oi', 'gainers', 'losers', 'active-value', 'active-volume'] as const;
export type RankFeed = (typeof RANK_FEEDS)[number];

/** Snapshots are floored to this grid (seconds) — matches the poller's 5-min cadence. */
const BUCKET_SEC = 300;

/** Only the top N of each feed are tracked. The race that matters is near the
 *  front of the board — a name crawling from #150 to #120 isn't a signal, and
 *  storing the whole ~180-name tail just adds noise (and rows). A name breaking
 *  INTO the top 50 surfaces as a new entrant, which is exactly the event we want. */
const TOP_N = 50;

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
      fullUniverse INTEGER,
      capturedAt TEXT    NOT NULL,
      PRIMARY KEY (date, bucketTs, feed, symbol)
    )
  `);
  const columns = new Set(
    (await prisma.$queryRawUnsafe<{ name: string }[]>(`PRAGMA table_info(rank_snapshots)`)).map((column) => column.name)
  );
  if (!columns.has('fullUniverse'))
    await prisma.$executeRawUnsafe(`ALTER TABLE rank_snapshots ADD COLUMN fullUniverse INTEGER`);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_rank_snapshots_date_feed ON rank_snapshots (date, feed, bucketTs)`
  );
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
    `SELECT symbol, tradeBand, isIndex FROM fno_stocks`
  );
  const liveFut = await prisma.$queryRawUnsafe<{ underlying: string | null }[]>(
    `SELECT DISTINCT underlying FROM master_contracts
       WHERE instrument = 'FUTSTK' AND segment = 'NSE_FNO' AND expiryDate >= date('now')`
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

const COLS = 8;
const BATCH_ROWS = 100; // 7 × 100 = 700 params, under SQLite's 999 limit

/**
 * Record one 5-min rank snapshot across all feeds. Best-effort and idempotent:
 * INSERT OR IGNORE on (date, bucketTs, feed, symbol) dedupes repeat calls in the
 * same bucket. Never throws — a feed hiccup must not break the poller cycle.
 * Returns rows attempted.
 */
export async function recordRankSnapshot(
  date: string,
  nowMs: number = Date.now(),
  fullUniverse: boolean | null = null
): Promise<number> {
  try {
    await ensureRankSnapshotTable();
    const tradeable = await tradeableFnoSet();
    const bucketTs = rankBucketFor(nowMs);
    const capturedAt = new Date(nowMs).toISOString();

    const rows: {
      feed: RankFeed;
      symbol: string;
      rank: number;
      value: number;
    }[] = [];
    for (const feed of RANK_FEEDS) {
      // Rank within the tradeable universe, then keep only the top N — the
      // front of the race is the part worth tracking.
      const ranked = (await rankedFeed(feed)).filter((r) => tradeable.has(r.symbol)).slice(0, TOP_N);
      ranked.forEach((r, i) => rows.push({ feed, symbol: r.symbol, rank: i + 1, value: r.value }));
    }
    if (rows.length === 0) return 0;

    for (let i = 0; i < rows.length; i += BATCH_ROWS) {
      const chunk = rows.slice(i, i + BATCH_ROWS);
      const placeholders = chunk.map(() => `(${Array(COLS).fill('?').join(',')})`).join(',');
      const params: unknown[] = [];
      for (const r of chunk)
        params.push(
          date,
          bucketTs,
          r.feed,
          r.symbol,
          r.rank,
          r.value,
          fullUniverse == null ? null : fullUniverse ? 1 : 0,
          capturedAt
        );
      await prisma.$executeRawUnsafe(
        `INSERT OR IGNORE INTO rank_snapshots (date, bucketTs, feed, symbol, rank, value, fullUniverse, capturedAt)
         VALUES ${placeholders}`,
        ...params
      );
    }
    return rows.length;
  } catch (err) {
    console.warn('[rank-tracker] recordRankSnapshot failed:', (err as Error).message);
    return 0;
  }
}

export interface RaceRunner {
  symbol: string;
  /** Rank in the latest (most recent) 5-min check. */
  rankNow: number;
  /** Rank at market open (the day's first healthy bucket); null = joined later. */
  rankOpen: number | null;
  /** rankOpen − rankNow. Positive = climbed since open. Null for new entrants. */
  deltaSinceOpen: number | null;
  valueNow: number;
  isNew: boolean;
  /** Rank at each healthy 5-min check, aligned to `bucketTimes` (null where the
   *  name wasn't in the top-N that check). The sparkline "track". */
  track: (number | null)[];
}

export interface RaceResult {
  feed: RankFeed;
  date: string;
  /** Market-open baseline bucket and the latest bucket (epoch seconds). */
  openTs: number | null;
  latestTs: number | null;
  /** Every healthy 5-min checkpoint today (epoch seconds), oldest → newest. */
  bucketTimes: number[];
  /** Climbers since open, biggest gain first. */
  runners: RaceRunner[];
  /** Names that entered the top-N after open, by current rank. */
  newEntrants: RaceRunner[];
}

/**
 * The running race measured FROM MARKET OPEN: for each name on the latest
 * board, its rank at every 5-min check today, its rank at the open, and how
 * many spots it has climbed since. Climbers are returned biggest-gain-first;
 * names that weren't on the board at open are split out as new entrants. Reads
 * local rank_snapshots only. Uses the same MIN_HEALTHY bucket guard as
 * getClimbers so a partially-captured cycle can't distort the baseline.
 */
export async function getRaceSinceOpen(date: string, feed: RankFeed, limit = 20, maxRank = 20): Promise<RaceResult> {
  await ensureRankSnapshotTable();
  const empty: RaceResult = {
    feed,
    date,
    openTs: null,
    latestTs: null,
    bucketTimes: [],
    runners: [],
    newEntrants: [],
  };

  const bucketRows = await prisma.$queryRawUnsafe<{ bucketTs: number; c: number }[]>(
    `SELECT bucketTs, COUNT(*) AS c FROM rank_snapshots WHERE date = ? AND feed = ? GROUP BY bucketTs ORDER BY bucketTs ASC`,
    date,
    feed
  );
  if (bucketRows.length === 0) return empty;
  const MIN_HEALTHY = 0.6;
  const maxCount = Math.max(...bucketRows.map((r) => Number(r.c)));
  const buckets = bucketRows.filter((r) => Number(r.c) >= MIN_HEALTHY * maxCount).map((r) => Number(r.bucketTs));
  if (buckets.length === 0) return empty;

  const openTs = buckets[0];
  const latestTs = buckets[buckets.length - 1];
  if (openTs === latestTs) return { ...empty, openTs, latestTs, bucketTimes: buckets }; // only one check so far

  const bucketIndex = new Map<number, number>();
  buckets.forEach((b, i) => bucketIndex.set(b, i));

  const placeholders = buckets.map(() => '?').join(',');
  const rows = await prisma.$queryRawUnsafe<{ symbol: string; rank: number; value: number; bucketTs: number }[]>(
    `SELECT symbol, rank, value, bucketTs FROM rank_snapshots WHERE date = ? AND feed = ? AND bucketTs IN (${placeholders})`,
    date,
    feed,
    ...buckets
  );

  const trackBy = new Map<string, (number | null)[]>();
  const valueNowBy = new Map<string, number>();
  for (const r of rows) {
    let track = trackBy.get(r.symbol);
    if (!track) {
      track = Array(buckets.length).fill(null) as (number | null)[];
      trackBy.set(r.symbol, track);
    }
    const idx = bucketIndex.get(Number(r.bucketTs));
    if (idx != null) track[idx] = Number(r.rank);
    if (Number(r.bucketTs) === latestTs) valueNowBy.set(r.symbol, Number(r.value));
  }

  const lastIdx = buckets.length - 1;
  const runners: RaceRunner[] = [];
  const newEntrants: RaceRunner[] = [];
  for (const [symbol, track] of trackBy) {
    const rankNow = track[lastIdx];
    if (rankNow == null) continue; // dropped off the latest board — not in the current race
    if (rankNow > maxRank) continue; // the race is the FINAL top-N — only names now near the front
    const rankOpen = track[0];
    const valueNow = valueNowBy.get(symbol) ?? 0;
    if (rankOpen == null) {
      newEntrants.push({
        symbol,
        rankNow,
        rankOpen: null,
        deltaSinceOpen: null,
        valueNow,
        isNew: true,
        track,
      });
    } else {
      const delta = rankOpen - rankNow; // + = climbed toward #1
      if (delta > 0)
        runners.push({
          symbol,
          rankNow,
          rankOpen,
          deltaSinceOpen: delta,
          valueNow,
          isNew: false,
          track,
        });
    }
  }
  runners.sort((a, b) => (b.deltaSinceOpen ?? 0) - (a.deltaSinceOpen ?? 0) || a.rankNow - b.rankNow);
  newEntrants.sort((a, b) => a.rankNow - b.rankNow);

  return {
    feed,
    date,
    openTs,
    latestTs,
    bucketTimes: buckets,
    runners: runners.slice(0, limit),
    newEntrants: newEntrants.slice(0, limit),
  };
}

/** Latest session date that has any rank snapshot, newest first. */
export async function getLatestRankDate(): Promise<string | null> {
  await ensureRankSnapshotTable();
  const rows = await prisma.$queryRawUnsafe<{ date: string }[]>(
    `SELECT date FROM rank_snapshots ORDER BY date DESC LIMIT 1`
  );
  return rows[0]?.date ?? null;
}

export const RANK_SNAPSHOT_RETENTION_SESSIONS = 20;

/** Retention: keep the newest N recorded sessions (poller-driven). */
export async function pruneRankSnapshots(): Promise<number> {
  await ensureRankSnapshotTable();
  return prisma.$executeRawUnsafe(
    `DELETE FROM rank_snapshots WHERE date NOT IN (
       SELECT DISTINCT date FROM rank_snapshots ORDER BY date DESC
       LIMIT ${RANK_SNAPSHOT_RETENTION_SESSIONS}
     )`
  );
}
