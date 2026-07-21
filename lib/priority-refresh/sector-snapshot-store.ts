/**
 * priority_sector_snapshots — the newest healthy per-cycle sector snapshot, so
 * the shadow plan can read a fresh sector read WITHOUT any Dhan call on the
 * critical path (plan §12-13, §31). Written after the scan/AI are released;
 * read at the start of the NEXT cycle's shadow plan.
 *
 * Derived-table convention (raw CREATE TABLE IF NOT EXISTS, lazy) mirrored by the
 * PrioritySectorSnapshot model in schema.prisma. Reads are cheap; writes are
 * best-effort — a failure NEVER propagates into the poller.
 */
import { prisma } from '@/lib/db';
import { PRIORITY_RETENTION_SESSIONS } from './config';
import type { ActiveSectorSignal } from './types';

let tableReady = false;

async function ensureTable(): Promise<void> {
  if (tableReady) return;
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
  tableReady = true;
}

/** Persist one cycle's qualified sector signals. Best-effort (never throws). */
export async function recordSectorSnapshot(date: string, bucketTs: number, signals: ActiveSectorSignal[]): Promise<void> {
  if (signals.length === 0) return;
  try {
    await ensureTable();
    const now = new Date().toISOString();
    for (const s of signals) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO priority_sector_snapshots
           (date, bucketTs, sector, direction, weightedPct, totalTurnover, turnoverRank, advanceRatio, stocks, officialNsePct, asOfMs, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(date, bucketTs, sector) DO UPDATE SET
           direction = excluded.direction, weightedPct = excluded.weightedPct, totalTurnover = excluded.totalTurnover,
           turnoverRank = excluded.turnoverRank, advanceRatio = excluded.advanceRatio, stocks = excluded.stocks,
           officialNsePct = excluded.officialNsePct, asOfMs = excluded.asOfMs`,
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
        s.asOfMs,
        now
      );
    }
  } catch (err) {
    console.warn(`[priority-refresh] sector snapshot write failed: ${(err as Error).message}`);
  }
}

/** The most recent stored sector signals for `date` (the latest bucketTs), or []
 *  when none / on any error. Best-effort — never throws into the poller. */
export async function getLatestSectorSnapshot(date: string): Promise<ActiveSectorSignal[]> {
  try {
    await ensureTable();
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT sector, direction, weightedPct, totalTurnover, turnoverRank, advanceRatio, stocks, officialNsePct, asOfMs
         FROM priority_sector_snapshots
        WHERE date = ? AND bucketTs = (SELECT MAX(bucketTs) FROM priority_sector_snapshots WHERE date = ?)`,
      date,
      date
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

/** Keep only the newest PRIORITY_RETENTION_SESSIONS dates. Best-effort. */
export async function pruneSectorSnapshots(): Promise<void> {
  try {
    await ensureTable();
    await prisma.$executeRawUnsafe(
      `DELETE FROM priority_sector_snapshots WHERE date NOT IN
         (SELECT DISTINCT date FROM priority_sector_snapshots ORDER BY date DESC LIMIT ?)`,
      PRIORITY_RETENTION_SESSIONS
    );
  } catch {
    // best-effort retention — never blocks the poller
  }
}
