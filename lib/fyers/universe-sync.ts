/**
 * Applies lib/fyers/universe-plan.ts to the database: `fno_stocks` follows the
 * daily-synced master contracts (lots, months, bands, renames, known-sector new
 * names). Run once per IST day per process from the poller's master-contract
 * catch-up — i.e. only ever against a snapshot that has passed its freshness
 * proof — and on demand by /api/fyers/poller to show the remaining drift.
 */
import sectorMapJson from '@/lib/data/fno_sectors.json';
import { prisma } from '@/lib/db';
import { resetTrackedUniverse } from '@/lib/fyers/symbols';
import { planFnoUniverseSync, type FnoStockRow, type FnoUniversePlan, type LiveFuture } from '@/lib/fyers/universe-plan';

const TAG = '[FnoUniverse]';

/** What the last daily sync did and could not do — shown on /fyers. */
export interface FnoUniverseSyncReport {
  date: string;
  at: string;
  added: string[];
  bandMoves: string[];
  lotUpdates: number;
  /** In fno_stocks but no live future: left F&O, or renamed away. Excluded, kept. */
  exited: { symbol: string; renamedTo: string | null }[];
  /** Live F&O names with no known sector — not added until classified. */
  unclassified: { symbol: string; lotSize: number }[];
  error: string | null;
}

const g = globalThis as unknown as {
  __fnoUniverseSyncedFor?: string;
  __fnoUniverseReport?: FnoUniverseSyncReport;
  /** Boot's catch-up and the first poller cycle can both arrive here at once;
   *  they share one run instead of racing two SQLite write transactions. */
  __fnoUniverseSyncing?: Promise<void>;
};

export function getFnoUniverseSyncReport(): FnoUniverseSyncReport | null {
  return g.__fnoUniverseReport ?? null;
}

/** The plan against the CURRENT database — what a sync would change, plus what it cannot. */
export async function readFnoUniversePlan(): Promise<FnoUniversePlan> {
  const stocks = (
    await prisma.$queryRawUnsafe<(Omit<FnoStockRow, 'isIndex'> & { isIndex: number | boolean })[]>(
      `SELECT symbol, name, isIndex, lotSize, lotSizeNext, lotSizeFar, lotMonths, sector, tradeBand FROM fno_stocks`
    )
  ).map((r) => ({ ...r, isIndex: Number(r.isIndex) === 1 }));
  const liveFutures = (
    await prisma.$queryRawUnsafe<{ underlying: string | null; expiryDate: string; lotSize: number }[]>(
      `SELECT underlying, expiryDate, lotSize FROM master_contracts
        WHERE instrument = 'FUTSTK' AND segment = 'NSE_FNO' AND expiryDate >= date('now')`
    )
  )
    .filter((r): r is LiveFuture => !!r.underlying)
    .map((r) => ({ underlying: r.underlying, expiryDate: String(r.expiryDate), lotSize: Number(r.lotSize) }));

  let bandOverrides = new Map<string, string>();
  try {
    const rows = await prisma.$queryRawUnsafe<{ symbol: string; band: string }[]>(`SELECT symbol, band FROM band_overrides`);
    bandOverrides = new Map(rows.map((r) => [r.symbol, r.band]));
  } catch {
    // Table created by the seed script; absent on a never-seeded DB = no overrides.
  }

  const known = new Set(stocks.map((s) => s.symbol));
  const newNames = [...new Set(liveFutures.map((f) => f.underlying))].filter((u) => !known.has(u));
  const equityNames = new Map<string, string>();
  if (newNames.length > 0) {
    const rows = await prisma.$queryRawUnsafe<{ symbol: string; name: string }[]>(
      `SELECT symbol, name FROM master_contracts
        WHERE instrument = 'EQUITY' AND segment = 'NSE_EQ' AND symbol IN (${newNames.map(() => '?').join(',')})`,
      ...newNames
    );
    for (const r of rows) equityNames.set(r.symbol, r.name);
  }

  return planFnoUniverseSync({
    stocks,
    liveFutures,
    bandOverrides,
    sectorMap: sectorMapJson as Record<string, string>,
    equityNames,
  });
}

/** Apply the plan in one transaction. Returns it, with what was written. */
export async function syncFnoUniverse(): Promise<FnoUniversePlan> {
  const plan = await readFnoUniversePlan();
  if (plan.updates.length === 0 && plan.additions.length === 0) return plan;
  const syncedAt = new Date().toISOString();
  await prisma.$transaction(async (tx) => {
    for (const u of plan.updates) {
      await tx.$executeRawUnsafe(
        `UPDATE fno_stocks SET lotSize = ?, lotSizeNext = ?, lotSizeFar = ?, lotMonths = ?, tradeBand = ?, syncedAt = ? WHERE symbol = ?`,
        u.lotSize,
        u.lotSizeNext,
        u.lotSizeFar,
        u.lotMonths,
        u.tradeBand,
        syncedAt,
        u.symbol
      );
    }
    for (const a of plan.additions) {
      await tx.$executeRawUnsafe(
        `INSERT INTO fno_stocks (symbol, name, isIndex, lotSize, lotSizeNext, lotSizeFar, lotMonths, sector, sectorSource, tradeBand, syncedAt)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol) DO NOTHING`,
        a.symbol,
        a.name,
        a.lotSize,
        a.lotSizeNext,
        a.lotSizeFar,
        a.lotMonths,
        a.sector,
        a.sectorSource,
        a.tradeBand,
        syncedAt
      );
    }
  });
  resetTrackedUniverse();
  return plan;
}

/** Once per IST day per process; never throws — a failed sync keeps yesterday's universe. */
export async function syncFnoUniverseOnce(date: string): Promise<void> {
  if (g.__fnoUniverseSyncedFor === date) return;
  g.__fnoUniverseSyncing ??= runSync(date).finally(() => {
    g.__fnoUniverseSyncing = undefined;
  });
  await g.__fnoUniverseSyncing;
}

async function runSync(date: string): Promise<void> {
  try {
    const plan = await syncFnoUniverse();
    g.__fnoUniverseSyncedFor = date;
    const bandMoves = plan.updates.filter((u) => u.tradeBand !== u.bandFrom).map((u) => `${u.symbol} ${u.bandFrom}→${u.tradeBand}`);
    g.__fnoUniverseReport = {
      date,
      at: new Date().toISOString(),
      added: plan.additions.map((a) => a.symbol),
      bandMoves,
      lotUpdates: plan.updates.length,
      exited: plan.exited,
      unclassified: plan.unclassified,
      error: null,
    };
    console.log(
      `${TAG} synced to the exchange: ${plan.updates.length} lot updates (band moves: ${bandMoves.join(', ') || 'none'}), ` +
        `${plan.additions.length} added (${plan.additions.map((a) => a.symbol).join(', ') || 'none'}), ` +
        `${plan.exited.length} without a live future (excluded), ${plan.unclassified.length} new F&O names need a sector: ` +
        (plan.unclassified.map((u) => u.symbol).join(', ') || 'none')
    );
  } catch (error) {
    const message = (error as Error).message;
    console.error(`${TAG} sync failed — keeping the current universe: ${message}`);
    g.__fnoUniverseReport = {
      date,
      at: new Date().toISOString(),
      added: [],
      bandMoves: [],
      lotUpdates: 0,
      exited: [],
      unclassified: [],
      error: message,
    };
  }
}
