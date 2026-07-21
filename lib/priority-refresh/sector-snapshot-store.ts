/**
 * Per-cycle sector snapshot for the shadow plan — read WITHOUT any Dhan call on
 * the critical path (plan §12-13, §31). Written after the scan/AI are released;
 * read at the start of the NEXT cycle's shadow plan.
 *
 * Two tables (derived-table convention, mirrored in schema.prisma):
 *  - priority_sector_batches: ONE marker row per (date, bucketTs), written EVERY
 *    production even when zero sectors qualify. This is what "latest snapshot"
 *    means — so a cycle that qualifies nothing correctly reads as "no active
 *    sectors this cycle", never falling back to an older cycle's rows (PR#11
 *    review B4).
 *  - priority_sector_snapshots: the qualified signal rows for that batch.
 *
 * Each production REPLACES the bucket atomically (delete rows → write marker →
 * insert rows, in ONE transaction), so a partial write is never read as complete
 * and sectors that dropped out don't linger (PR#11 review B5). Writes are
 * best-effort — a failure NEVER propagates into the poller.
 */
import { prisma } from '@/lib/db';
import { PRIORITY_RETENTION_SESSIONS } from './config';
import type { ActiveSectorSignal } from './types';

let tablesReady = false;

async function ensureTables(): Promise<void> {
  if (tablesReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS priority_sector_batches (
      date        TEXT    NOT NULL,
      bucketTs    INTEGER NOT NULL,
      asOfMs      INTEGER NOT NULL,
      signalCount INTEGER NOT NULL,
      createdAt   TEXT    NOT NULL,
      PRIMARY KEY (date, bucketTs)
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS priority_sector_snapshots (
      date           TEXT    NOT NULL,
      bucketTs       INTEGER NOT NULL,
      sector         TEXT    NOT NULL,
      direction      TEXT    NOT NULL,
      weightedPct    REAL    NOT NULL,
      totalTurnover  REAL    NOT NULL,
      turnoverRank   INTEGER NOT NULL,
      advanceRatio   REAL,
      stocks         INTEGER NOT NULL,
      officialNsePct REAL,
      asOfMs         INTEGER NOT NULL,
      createdAt      TEXT    NOT NULL,
      PRIMARY KEY (date, bucketTs, sector)
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_priority_sector_snapshots_latest ON priority_sector_snapshots (date, bucketTs DESC)`
  );
  tablesReady = true;
}

/**
 * Persist one cycle's sector snapshot — ALWAYS writes the batch marker (even for
 * zero signals) and replaces the bucket atomically. `asOfMs` is when the snapshot
 * was produced (the reader ages the signals against it). Best-effort.
 */
export async function recordSectorSnapshot(
  date: string,
  bucketTs: number,
  asOfMs: number,
  signals: ActiveSectorSignal[]
): Promise<void> {
  try {
    await ensureTables();
    const now = new Date().toISOString();
    const ops = [
      prisma.$executeRawUnsafe(`DELETE FROM priority_sector_snapshots WHERE date = ? AND bucketTs = ?`, date, bucketTs),
      prisma.$executeRawUnsafe(
        `INSERT INTO priority_sector_batches (date, bucketTs, asOfMs, signalCount, createdAt) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(date, bucketTs) DO UPDATE SET asOfMs = excluded.asOfMs, signalCount = excluded.signalCount, createdAt = excluded.createdAt`,
        date,
        bucketTs,
        asOfMs,
        signals.length,
        now
      ),
      ...signals.map((s) =>
        prisma.$executeRawUnsafe(
          `INSERT INTO priority_sector_snapshots
             (date, bucketTs, sector, direction, weightedPct, totalTurnover, turnoverRank, advanceRatio, stocks, officialNsePct, asOfMs, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          date,
          bucketTs,
          s.sector,
          s.direction,
          s.weightedPct,
          s.totalTurnover,
          s.turnoverRank,
          s.advanceRatio,
          s.stocks,
          s.officialNsePct,
          asOfMs,
          now
        )
      ),
    ];
    await prisma.$transaction(ops);
  } catch (err) {
    console.warn(`[priority-refresh] sector snapshot write failed: ${(err as Error).message}`);
  }
}

/**
 * The signals of the NEWEST batch for `date` (may be [] when the latest cycle
 * qualified nothing — distinct from "no batch at all", which returns []). Reads
 * the latest BATCH, then that batch's rows, so an empty newest cycle never
 * surfaces an older cycle's signals. Best-effort ([] on any error).
 */
export async function getLatestSectorSnapshot(date: string): Promise<ActiveSectorSignal[]> {
  try {
    await ensureTables();
    const batch = (
      await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT bucketTs FROM priority_sector_batches WHERE date = ? ORDER BY bucketTs DESC LIMIT 1`,
        date
      )
    )[0];
    if (!batch) return [];
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT sector, direction, weightedPct, totalTurnover, turnoverRank, advanceRatio, stocks, officialNsePct, asOfMs
         FROM priority_sector_snapshots WHERE date = ? AND bucketTs = ?`,
      date,
      Number(batch.bucketTs)
    );
    return rows.map((r) => ({
      sector: String(r.sector),
      direction: r.direction === 'bearish' ? 'bearish' : 'bullish',
      weightedPct: Number(r.weightedPct),
      totalTurnover: Number(r.totalTurnover),
      turnoverRank: Number(r.turnoverRank),
      advanceRatio: r.advanceRatio == null ? null : Number(r.advanceRatio),
      stocks: Number(r.stocks),
      officialNsePct: r.officialNsePct == null ? null : Number(r.officialNsePct),
      asOfMs: Number(r.asOfMs),
    }));
  } catch (err) {
    console.warn(`[priority-refresh] sector snapshot read failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * The newest completed batch strictly before `beforeBucketTs`. The explicit
 * boundary prevents a delayed post-decision writer or same-bucket rerun from
 * leaking the current cycle into the plan that is meant to use prior evidence.
 */
export async function getLatestSectorSnapshotBefore(
  date: string,
  beforeBucketTs: number
): Promise<ActiveSectorSignal[]> {
  try {
    await ensureTables();
    const batch = (
      await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT bucketTs
           FROM priority_sector_batches
          WHERE date = ? AND bucketTs < ?
          ORDER BY bucketTs DESC
          LIMIT 1`,
        date,
        beforeBucketTs
      )
    )[0];
    if (!batch) return [];
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT sector, direction, weightedPct, totalTurnover, turnoverRank, advanceRatio, stocks, officialNsePct, asOfMs
         FROM priority_sector_snapshots WHERE date = ? AND bucketTs = ?`,
      date,
      Number(batch.bucketTs)
    );
    return rows.map((r) => ({
      sector: String(r.sector),
      direction: r.direction === 'bearish' ? 'bearish' : 'bullish',
      weightedPct: Number(r.weightedPct),
      totalTurnover: Number(r.totalTurnover),
      turnoverRank: Number(r.turnoverRank),
      advanceRatio: r.advanceRatio == null ? null : Number(r.advanceRatio),
      stocks: Number(r.stocks),
      officialNsePct: r.officialNsePct == null ? null : Number(r.officialNsePct),
      asOfMs: Number(r.asOfMs),
    }));
  } catch (err) {
    console.warn(`[priority-refresh] bounded sector snapshot read failed: ${(err as Error).message}`);
    return [];
  }
}

/** Keep only the newest PRIORITY_RETENTION_SESSIONS dates. Best-effort. */
export async function pruneSectorSnapshots(): Promise<void> {
  try {
    await ensureTables();
    const keep = `(SELECT DISTINCT date FROM priority_sector_batches ORDER BY date DESC LIMIT ?)`;
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`DELETE FROM priority_sector_snapshots WHERE date NOT IN ${keep}`, PRIORITY_RETENTION_SESSIONS),
      prisma.$executeRawUnsafe(`DELETE FROM priority_sector_batches WHERE date NOT IN ${keep}`, PRIORITY_RETENTION_SESSIONS),
    ]);
  } catch {
    // best-effort retention — never blocks the poller
  }
}
