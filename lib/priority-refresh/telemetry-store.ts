/**
 * priority_refresh_cycles — one row per poller cycle recording the SHADOW plan:
 * the proposed Tier 0/Tier 1 membership counts and which of that cycle's
 * suggestions fell OUTSIDE the proposed cap (the coverage evidence, plan §32/§38).
 * No timing is recorded — this PR does not reorder the download, so there is no
 * release-time saving to measure (that ships with the capped-live PR).
 *
 * Derived-table convention, mirrored by PriorityRefreshCycle in schema.prisma.
 * ALL writes are best-effort — telemetry failure NEVER affects a scan or the
 * poller (plan §33 "telemetry failure must never fail a cycle").
 */
import { prisma } from '@/lib/db';
import { PRIORITY_RETENTION_SESSIONS } from './config';

export interface PriorityCycleRow {
  date: string;
  bucketTs: number;
  shadowEnabled: boolean;
  cappedLiveEnabled: boolean;
  blockStaleEntry: boolean;
  sectorShadowEnabled: boolean;
  sectorLiveEnabled: boolean;
  perFeedLimit: number;
  maxUniqueTier1: number;
  sectorReservedSlots: number;
  universeCount: number;
  scanPoolCount: number;
  fullPriorityCount: number;
  tier0Count: number;
  baseTier1Count: number;
  sectorPromotedCount: number;
  cappedWaitCount: number;
  suggestionCount: number;
  suggestionsOutsideCap: number;
  outsideCapSymbols: string[];
  activeBullishSectors: string[];
  activeBearishSectors: string[];
}

export interface StoredPriorityCycle extends PriorityCycleRow {
  createdAt: string;
}

let tableReady = false;

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS priority_refresh_cycles (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      date                  TEXT    NOT NULL,
      bucketTs              INTEGER NOT NULL,
      planVersion           INTEGER NOT NULL DEFAULT 1,
      shadowEnabled         INTEGER NOT NULL,
      cappedLiveEnabled     INTEGER NOT NULL,
      blockStaleEntry       INTEGER NOT NULL,
      sectorShadowEnabled   INTEGER NOT NULL,
      sectorLiveEnabled     INTEGER NOT NULL,
      perFeedLimit          INTEGER NOT NULL,
      maxUniqueTier1        INTEGER NOT NULL,
      sectorReservedSlots   INTEGER NOT NULL,
      universeCount         INTEGER NOT NULL,
      scanPoolCount         INTEGER NOT NULL,
      fullPriorityCount     INTEGER NOT NULL,
      tier0Count            INTEGER NOT NULL,
      baseTier1Count        INTEGER NOT NULL,
      sectorPromotedCount   INTEGER NOT NULL,
      cappedWaitCount       INTEGER NOT NULL,
      suggestionCount       INTEGER NOT NULL DEFAULT 0,
      suggestionsOutsideCap INTEGER NOT NULL DEFAULT 0,
      outsideCapSymbolsJson TEXT,
      activeBullishJson     TEXT,
      activeBearishJson     TEXT,
      createdAt             TEXT    NOT NULL,
      UNIQUE(date, bucketTs)
    )
  `);
  tableReady = true;
}

const b = (v: boolean) => (v ? 1 : 0);

/** Persist one cycle's shadow telemetry. Best-effort — never throws. */
export async function recordPriorityCycle(row: PriorityCycleRow): Promise<void> {
  try {
    await ensureTable();
    await prisma.$executeRawUnsafe(
      `INSERT INTO priority_refresh_cycles
         (date, bucketTs, shadowEnabled, cappedLiveEnabled, blockStaleEntry, sectorShadowEnabled, sectorLiveEnabled,
          perFeedLimit, maxUniqueTier1, sectorReservedSlots, universeCount, scanPoolCount, fullPriorityCount,
          tier0Count, baseTier1Count, sectorPromotedCount, cappedWaitCount,
          suggestionCount, suggestionsOutsideCap, outsideCapSymbolsJson, activeBullishJson, activeBearishJson, createdAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(date, bucketTs) DO UPDATE SET
         shadowEnabled=excluded.shadowEnabled, cappedLiveEnabled=excluded.cappedLiveEnabled, blockStaleEntry=excluded.blockStaleEntry,
         sectorShadowEnabled=excluded.sectorShadowEnabled, sectorLiveEnabled=excluded.sectorLiveEnabled,
         perFeedLimit=excluded.perFeedLimit, maxUniqueTier1=excluded.maxUniqueTier1, sectorReservedSlots=excluded.sectorReservedSlots,
         universeCount=excluded.universeCount, scanPoolCount=excluded.scanPoolCount, fullPriorityCount=excluded.fullPriorityCount,
         tier0Count=excluded.tier0Count, baseTier1Count=excluded.baseTier1Count, sectorPromotedCount=excluded.sectorPromotedCount,
         cappedWaitCount=excluded.cappedWaitCount, suggestionCount=excluded.suggestionCount,
         suggestionsOutsideCap=excluded.suggestionsOutsideCap, outsideCapSymbolsJson=excluded.outsideCapSymbolsJson,
         activeBullishJson=excluded.activeBullishJson, activeBearishJson=excluded.activeBearishJson`,
      row.date,
      row.bucketTs,
      b(row.shadowEnabled),
      b(row.cappedLiveEnabled),
      b(row.blockStaleEntry),
      b(row.sectorShadowEnabled),
      b(row.sectorLiveEnabled),
      row.perFeedLimit,
      row.maxUniqueTier1,
      row.sectorReservedSlots,
      row.universeCount,
      row.scanPoolCount,
      row.fullPriorityCount,
      row.tier0Count,
      row.baseTier1Count,
      row.sectorPromotedCount,
      row.cappedWaitCount,
      row.suggestionCount,
      row.suggestionsOutsideCap,
      JSON.stringify(row.outsideCapSymbols),
      JSON.stringify(row.activeBullishSectors),
      JSON.stringify(row.activeBearishSectors),
      new Date().toISOString()
    );
  } catch (err) {
    console.warn(`[priority-refresh] cycle telemetry write failed: ${(err as Error).message}`);
  }
}

function parseArr(v: unknown): string[] {
  if (typeof v !== 'string' || !v) return [];
  try {
    const j = JSON.parse(v);
    return Array.isArray(j) ? j.map(String) : [];
  } catch {
    return [];
  }
}

function toStored(r: Record<string, unknown>): StoredPriorityCycle {
  const n = (k: string) => Number(r[k]);
  const bool = (k: string) => Number(r[k]) === 1;
  return {
    date: String(r.date),
    bucketTs: n('bucketTs'),
    shadowEnabled: bool('shadowEnabled'),
    cappedLiveEnabled: bool('cappedLiveEnabled'),
    blockStaleEntry: bool('blockStaleEntry'),
    sectorShadowEnabled: bool('sectorShadowEnabled'),
    sectorLiveEnabled: bool('sectorLiveEnabled'),
    perFeedLimit: n('perFeedLimit'),
    maxUniqueTier1: n('maxUniqueTier1'),
    sectorReservedSlots: n('sectorReservedSlots'),
    universeCount: n('universeCount'),
    scanPoolCount: n('scanPoolCount'),
    fullPriorityCount: n('fullPriorityCount'),
    tier0Count: n('tier0Count'),
    baseTier1Count: n('baseTier1Count'),
    sectorPromotedCount: n('sectorPromotedCount'),
    cappedWaitCount: n('cappedWaitCount'),
    suggestionCount: n('suggestionCount'),
    suggestionsOutsideCap: n('suggestionsOutsideCap'),
    outsideCapSymbols: parseArr(r.outsideCapSymbolsJson),
    activeBullishSectors: parseArr(r.activeBullishJson),
    activeBearishSectors: parseArr(r.activeBearishJson),
    createdAt: String(r.createdAt),
  };
}

/** Every cycle row for `date`, oldest first. Best-effort ([] on error). */
export async function getPriorityCyclesForDate(date: string): Promise<StoredPriorityCycle[]> {
  try {
    await ensureTable();
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM priority_refresh_cycles WHERE date = ? ORDER BY bucketTs ASC`,
      date
    );
    return rows.map(toStored);
  } catch {
    return [];
  }
}

/** The most recent cycle row for `date`, or null. Best-effort. */
export async function getLatestPriorityCycle(date: string): Promise<StoredPriorityCycle | null> {
  const rows = await getPriorityCyclesForDate(date);
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

/** Keep only the newest PRIORITY_RETENTION_SESSIONS dates. Best-effort. */
export async function prunePriorityCycles(): Promise<void> {
  try {
    await ensureTable();
    await prisma.$executeRawUnsafe(
      `DELETE FROM priority_refresh_cycles WHERE date NOT IN
         (SELECT DISTINCT date FROM priority_refresh_cycles ORDER BY date DESC LIMIT ?)`,
      PRIORITY_RETENTION_SESSIONS
    );
  } catch {
    // best-effort retention
  }
}
