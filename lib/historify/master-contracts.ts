/**
 * Dhan Master Contract Lookup — Prisma SQLite backed
 *
 * Downloads Dhan's master CSV once per day, stores in SQLite via Prisma.
 * All lookups hit the DB (indexed) — no 100MB CSV download on every restart.
 */

import { createHash } from 'node:crypto';
import fnoUniverse from '@/lib/data/fno_stocks_list.json';
import { prisma } from '@/lib/db';
import {
  checkOptionMonthCoverage,
  checkOptionSeriesCoverage,
  checkOptionUnderlyingCoverage,
} from '@/lib/options/expiry-policy';
import { releaseRuntimeLease, tryAcquireRuntimeLease } from '@/lib/runtime/lease';

const MASTER_CSV_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';

// Only sync instruments needed for R-Factor: equity OHLC + stock/index futures
const KEEP_SEGMENTS = new Set(['NSE_EQ', 'NSE_FNO']);
const KEEP_INSTRUMENTS = new Set(['EQUITY', 'FUTSTK', 'FUTIDX', 'OPTSTK']);
const STABLE_INSTRUMENTS = new Set(['EQUITY', 'FUTSTK', 'FUTIDX']);
const MIN_TOTAL_ROWS = 1000;
const MIN_STABLE_ROWS = 1000;
/** Freshness floor: the STORED table must not be option-empty. Kept minimal on
 * purpose — completeness of a stored snapshot is proved by the manifest count
 * match, not by an absolute number, and a large floor here only makes fixtures
 * harder without adding safety. */
const MIN_OPTSTK_ROWS = 1;
/** Parse floor: a real Dhan CSV carries ~70k stock-option rows and the THINNEST
 * single monthly series alone is ~14k (measured 2026-07-26). 10k therefore only
 * fires on a near-total loss of the option section — no false-block risk — while
 * the month-coverage guard below catches the subtler "one series missing" case. */
const MIN_PARSED_OPTSTK_ROWS = 10_000;
const MASTER_SYNC_LEASE = 'master-contracts-sync';
const MASTER_SYNC_LEASE_TTL_MS = 120_000;

export type SecurityEntry = {
  securityId: string;
  symbol: string;
  exchange: string;
  segment: string;
  name: string;
  instrument: string;
};

export type FuturesEntry = SecurityEntry & {
  expiry: Date;
  underlying: string;
};

export type FuturesRangeEntry = SecurityEntry & {
  expiry: Date;
  underlying: string;
  lotSize: number;
};

// Cache the exact calendar date verified. A boolean would stay true across
// midnight and could authorize yesterday's snapshot in a long-running process.
let syncedForDate: string | null = null;
const FNO_SYMBOLS = new Set<string>(fnoUniverse.stocks);

import { todayIST } from '@/lib/dhan/market-feed';

export interface MasterContractQueryClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface MasterContractFreshness {
  expectedSyncDate: string;
  syncDate: string | null;
  rowCount: number;
  distinctSyncDates: number;
  stableRows: number;
  optStkRows: number;
  manifest: {
    syncDate: string;
    totalRows: number;
    stableRows: number;
    optStkRows: number;
    completedAt: string;
    sourceHash: string;
  } | null;
  state: 'fresh' | 'missing' | 'stale' | 'incomplete';
  acceptable: boolean;
  reason: string | null;
}

/** Verify that the table is one complete daily snapshot for the requested trade
 * date. The nightly refresh replaces every row transactionally, so multiple
 * sync dates indicate a corrupted/manual partial table and fail closed too. */
export async function getMasterContractFreshness(
  expectedSyncDate: string,
  db: MasterContractQueryClient = prisma
): Promise<MasterContractFreshness> {
  const rows = await db.$queryRawUnsafe<
    {
      syncDate: string;
      rowCount: number | bigint;
      stableRows: number | bigint;
      optStkRows: number | bigint;
    }[]
  >(
    `SELECT syncDate,
            COUNT(*) AS rowCount,
            SUM(CASE WHEN instrument IN ('EQUITY', 'FUTSTK', 'FUTIDX') THEN 1 ELSE 0 END) AS stableRows,
            SUM(CASE WHEN instrument = 'OPTSTK' AND segment = 'NSE_FNO' THEN 1 ELSE 0 END) AS optStkRows
       FROM master_contracts
      GROUP BY syncDate
      ORDER BY syncDate DESC`
  );
  const syncDate = rows[0]?.syncDate == null ? null : String(rows[0].syncDate);
  const rowCount = rows.reduce((sum, row) => sum + Number(row.rowCount), 0);
  const stableRows = rows.reduce((sum, row) => sum + Number(row.stableRows), 0);
  const optStkRows = rows.reduce((sum, row) => sum + Number(row.optStkRows), 0);
  const distinctSyncDates = rows.length;
  let manifest: MasterContractFreshness['manifest'] = null;
  try {
    const manifestRows = await db.$queryRawUnsafe<
      {
        syncDate: string;
        totalRows: number | bigint;
        stableRows: number | bigint;
        optStkRows: number | bigint;
        completedAt: string;
        sourceHash: string;
      }[]
    >(
      `SELECT syncDate, totalRows, stableRows, optStkRows, completedAt, sourceHash
         FROM master_contract_snapshots
        WHERE syncDate = ?
        LIMIT 1`,
      expectedSyncDate
    );
    const stored = manifestRows[0];
    if (stored) {
      manifest = {
        syncDate: String(stored.syncDate),
        totalRows: Number(stored.totalRows),
        stableRows: Number(stored.stableRows),
        optStkRows: Number(stored.optStkRows),
        completedAt: String(stored.completedAt),
        sourceHash: String(stored.sourceHash),
      };
    }
  } catch (error) {
    // Existing databases do not have the manifest table until the first sync
    // on this version. Treat that as incomplete; any other query failure must
    // surface rather than silently authorizing a snapshot.
    if (!(error instanceof Error) || !/no such table: master_contract_snapshots/i.test(error.message)) throw error;
  }

  let state: MasterContractFreshness['state'];
  let reason: string | null;
  if (rowCount === 0) {
    state = 'missing';
    reason = `master contracts missing for ${expectedSyncDate}`;
  } else if (distinctSyncDates === 1 && syncDate !== expectedSyncDate) {
    state = 'stale';
    reason = `master contracts stale: last sync ${syncDate ?? 'unknown'}, expected ${expectedSyncDate}`;
  } else if (distinctSyncDates !== 1) {
    state = 'incomplete';
    reason = `master contracts contain ${distinctSyncDates} sync dates (latest ${syncDate ?? 'unknown'}); expected one completed ${expectedSyncDate} snapshot`;
  } else if (manifest == null) {
    state = 'incomplete';
    reason = `master contracts ${expectedSyncDate} snapshot has no completed manifest`;
  } else if (
    manifest.syncDate !== expectedSyncDate ||
    manifest.totalRows !== rowCount ||
    manifest.stableRows !== stableRows ||
    manifest.optStkRows !== optStkRows
  ) {
    state = 'incomplete';
    reason = `master contracts ${expectedSyncDate} counts do not match completed manifest (table ${rowCount}/${stableRows}/${optStkRows}, manifest ${manifest.totalRows}/${manifest.stableRows}/${manifest.optStkRows})`;
  } else if (
    rowCount < MIN_TOTAL_ROWS ||
    stableRows < MIN_STABLE_ROWS ||
    optStkRows < MIN_OPTSTK_ROWS ||
    manifest.completedAt.trim() === '' ||
    manifest.sourceHash.trim() === ''
  ) {
    state = 'incomplete';
    reason = `master contracts ${expectedSyncDate} completed manifest failed sanity floors (total ${rowCount}, stable ${stableRows}, OPTSTK ${optStkRows})`;
  } else {
    state = 'fresh';
    reason = null;
  }
  const acceptable = state === 'fresh';
  return {
    expectedSyncDate,
    syncDate,
    rowCount,
    distinctSyncDates,
    stableRows,
    optStkRows,
    manifest,
    state,
    acceptable,
    reason,
  };
}

/**
 * Check if master contracts are synced for today.
 * Does NOT trigger a download — consumers should direct users to the Master Contracts page.
 */
export async function ensureSynced(): Promise<void> {
  const today = todayIST();
  if (syncedForDate === today) return;
  const freshness = await getMasterContractFreshness(today);
  if (freshness.acceptable) {
    syncedForDate = today;
    return;
  }

  throw new MasterContractsNotSyncedError(today);
}

/** Thrown when master contracts haven't been synced today. */
export class MasterContractsNotSyncedError extends Error {
  constructor(date: string) {
    super(`Master contracts not synced for ${date}. Please sync from the Master Contracts page.`);
    this.name = 'MasterContractsNotSyncedError';
  }
}

/**
 * Download CSV from Dhan, parse, and bulk-insert into SQLite.
 */
async function syncFromDhan(today: string): Promise<void> {
  console.log(`[MasterContracts] Syncing from Dhan CSV for ${today}...`);
  const startMs = Date.now();

  const resp = await fetch(MASTER_CSV_URL);
  if (!resp.ok) throw new Error(`Failed to fetch master CSV: ${resp.status}`);

  const text = await resp.text();
  const lines = text.split('\n');
  if (lines.length < 2) throw new Error('Empty master contract CSV');

  const header = lines[0].split(',').map((h) => h.trim().replace(/"/g, ''));
  const col = (name: string) => header.indexOf(name);

  const idxExch = col('SEM_EXM_EXCH_ID');
  const idxSeg = col('SEM_SEGMENT');
  const idxId = col('SEM_SMST_SECURITY_ID');
  const idxSym = col('SEM_TRADING_SYMBOL');
  const idxName = col('SEM_INSTRUMENT_NAME');
  const idxInstType = col('SEM_EXCH_INSTRUMENT_TYPE');
  const idxExpiry = col('SEM_EXPIRY_DATE');
  const idxLotSize = col('SEM_LOT_UNITS');
  const idxStrikePrice = col('SEM_STRIKE_PRICE');
  const idxOptionType = col('SEM_OPTION_TYPE');

  // Parse all rows
  const entries: {
    securityId: string;
    symbol: string;
    exchange: string;
    segment: string;
    instrument: string;
    name: string;
    underlying: string | null;
    expiryDate: Date | null;
    lotSize: number;
    strikePrice: number | null;
    optionType: string | null;
    syncDate: string;
  }[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split(',').map((c) => c.trim().replace(/"/g, ''));

    const rawExch = cols[idxExch] || '';
    const rawSeg = cols[idxSeg] || '';
    const secId = cols[idxId] || '';
    const symbol = cols[idxSym] || '';
    const name = cols[idxName] || '';
    const instType = cols[idxInstType] || '';
    const expiryStr = cols[idxExpiry] || '';
    const lotSizeStr = cols[idxLotSize] || '1';

    if (!secId || !symbol) continue;

    // Normalize segment
    let segment = rawSeg;
    if (rawExch === 'NSE' && rawSeg === 'E') segment = 'NSE_EQ';
    else if (rawExch === 'BSE' && rawSeg === 'E') segment = 'BSE_EQ';
    else if (rawExch === 'NSE' && rawSeg === 'D') segment = 'NSE_FNO';
    else if (rawExch === 'BSE' && rawSeg === 'D') segment = 'BSE_FNO';
    else if (rawExch === 'NSE' && rawSeg === 'I') segment = 'IDX_I';
    else if (rawExch === 'MCX' && rawSeg === 'M') segment = 'MCX_COMM';

    // Normalize instrument
    let instrument = instType.toUpperCase();
    if (segment.includes('_EQ')) instrument = 'EQUITY';
    if (instrument === 'FUT') instrument = name.toUpperCase(); // FUTSTK, FUTIDX
    if (instrument === 'OP') instrument = name.toUpperCase(); // OPTSTK, OPTIDX

    // Only keep what R-Factor needs: equity + stock/index futures
    if (!KEEP_SEGMENTS.has(segment) || !KEEP_INSTRUMENTS.has(instrument)) continue;

    // Extract underlying for futures/options (e.g. "RELIANCE-Mar2026-FUT" → "RELIANCE").
    // Split at the expiry token (Mon+Year), NOT the first dash — hyphenated
    // underlyings like "BAJAJ-AUTO-Jun2026-FUT" must yield "BAJAJ-AUTO".
    let underlying: string | null = null;
    if (instrument === 'FUTSTK' || instrument === 'OPTSTK') {
      const parts = symbol.split('-');
      const expiryIdx = parts.findIndex((p) => /^[A-Z][a-z]{2}\d{4}$/.test(p));
      if (expiryIdx > 0) underlying = parts.slice(0, expiryIdx).join('-');
      else if (parts.length > 1) underlying = parts[0]; // fallback: previous behavior
    }

    // Parse expiry
    let expiryDate: Date | null = null;
    if (expiryStr) {
      const d = new Date(expiryStr);
      if (!Number.isNaN(d.getTime())) expiryDate = d;
    }

    // Parse strike price and option type for OPTSTK
    const strikePriceRaw = idxStrikePrice >= 0 ? cols[idxStrikePrice] : '';
    const optionTypeRaw = idxOptionType >= 0 ? cols[idxOptionType] : '';
    const strikePrice = instrument === 'OPTSTK' && strikePriceRaw ? Number.parseFloat(strikePriceRaw) || null : null;
    const optionType = instrument === 'OPTSTK' && optionTypeRaw ? optionTypeRaw.toUpperCase() : null;

    entries.push({
      securityId: secId,
      symbol,
      exchange: rawExch,
      segment,
      instrument,
      name,
      underlying,
      expiryDate,
      lotSize: Number.parseFloat(lotSizeStr) || 1,
      strikePrice,
      optionType,
      syncDate: today,
    });
  }

  // The database identity is (securityId, segment). Collapse byte-for-byte
  // duplicate CSV rows before insertion, but reject conflicting duplicates:
  // INSERT OR IGNORE used to hide those collisions and could silently drop a
  // contract while still stamping the table with today's date.
  const uniqueEntries = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    const key = `${entry.securityId}\u0000${entry.segment}`;
    const previous = uniqueEntries.get(key);
    if (previous == null) {
      uniqueEntries.set(key, entry);
      continue;
    }
    const canonical = (value: (typeof entries)[number]) =>
      JSON.stringify({
        ...value,
        expiryDate: value.expiryDate?.toISOString() ?? null,
      });
    if (canonical(previous) !== canonical(entry)) {
      throw new Error(`master-contracts sync aborted: conflicting duplicate identity ${entry.securityId}/${entry.segment}`);
    }
  }
  entries.length = 0;
  entries.push(...uniqueEntries.values());

  // Row-count sanity (C3, forensic audit): a truncated download / changed CSV
  // format must never wipe a good table. Two guards:
  //   1. Absolute floor — a near-empty parse is always a broken download.
  //   2. Relative-drop guard applied to the STABLE instruments only
  //      (EQUITY + FUTSTK + FUTIDX). The total row count is dominated by OPTSTK,
  //      which churns heavily as monthly expiries roll — comparing the total
  //      false-positived every expiry cycle (2026-07-20: 85k→~70k option
  //      contracts over 22 days aborted every nightly sync and froze the whole
  //      table 22 days stale). Equities + futures don't churn, so they are the
  //      honest truncation signal.
  const parsedStable = entries.reduce((n, e) => (STABLE_INSTRUMENTS.has(e.instrument) ? n + 1 : n), 0);
  const parsedOptStk = entries.reduce(
    (n, e) => (e.instrument === 'OPTSTK' && e.segment === 'NSE_FNO' ? n + 1 : n),
    0
  );
  const existingCount = await prisma.masterContract.count();
  const existingStable = await prisma.masterContract.count({
    where: { instrument: { in: [...STABLE_INSTRUMENTS] } },
  });
  if (entries.length < MIN_TOTAL_ROWS || parsedStable < MIN_STABLE_ROWS || parsedOptStk < MIN_PARSED_OPTSTK_ROWS) {
    throw new Error(
      `master-contracts sync aborted: parsed ${entries.length} rows (${parsedStable} stable, ${parsedOptStk} OPTSTK) — CSV truncated or format changed; existing ${existingCount} rows kept`,
    );
  }
  if (existingStable > 0 && parsedStable < existingStable * 0.9) {
    throw new Error(
      `master-contracts sync aborted: stable instruments dropped ${existingStable}→${parsedStable} (>10%) — refusing to replace a good table; investigate the CSV before re-syncing`,
    );
  }
  // Guard 3 — option-series COVERAGE, not row count. Losing one monthly series
  // is only ~1/3 of the option rows, so guard 1 still passes; but the resolver
  // would then roll past the intended next month into the one after it. Compare
  // still-tradable expiry months against the snapshot being replaced.
  // ONE read of the stored option series — the baseline for all three coverage
  // guards below. DISTINCT keeps it to ~1,300 rows (210 underlyings x CE/PE x 3
  // months), not the 70k contract rows.
  const existingSeriesRows = await prisma.$queryRawUnsafe<
    { underlying: string | null; optionType: string | null; expiryDate: string | null }[]
  >(
    `SELECT DISTINCT underlying, optionType, substr(expiryDate, 1, 10) AS expiryDate
       FROM master_contracts
      WHERE instrument = 'OPTSTK' AND segment = 'NSE_FNO' AND expiryDate IS NOT NULL`
  );
  const parsedOptStkEntries = entries.filter((e) => e.instrument === 'OPTSTK' && e.segment === 'NSE_FNO');
  const parsedSeriesRows = parsedOptStkEntries.map((e) => ({
    underlying: e.underlying,
    optionType: e.optionType,
    expiryDate: e.expiryDate?.toISOString().slice(0, 10) ?? null,
  }));
  const abort = (reason: string): never => {
    throw new Error(
      `master-contracts sync aborted: ${reason}; refusing to replace a good table (existing ${existingCount} rows kept) — investigate the CSV before re-syncing`,
    );
  };
  const coverage = checkOptionMonthCoverage(
    today,
    parsedSeriesRows.map((r) => r.expiryDate),
    existingSeriesRows.map((r) => r.expiryDate)
  );
  if (!coverage.ok) abort(coverage.reason ?? 'option expiry coverage shrank');
  // Guard 4 — UNDERLYING coverage: a file truncated part-way through still lists
  // every month while dozens of symbols silently lose their options.
  const parsedUnderlyings = new Set(
    parsedSeriesRows.map((r) => r.underlying).filter((u): u is string => u != null && u !== '')
  ).size;
  const existingUnderlyings = new Set(
    existingSeriesRows.map((r) => r.underlying).filter((u): u is string => u != null && u !== '')
  ).size;
  const underlyingCoverage = checkOptionUnderlyingCoverage(parsedUnderlyings, existingUnderlyings);
  if (!underlyingCoverage.ok) abort(underlyingCoverage.reason ?? 'option underlyings dropped');
  // Guard 5 — PER-SYMBOL, PER-SIDE coverage. Guards 3 and 4 are aggregates: they
  // both pass while ONE stock loses ONE month on ONE side, which is exactly what
  // the resolver would then roll past during expiry week (PR#22 re-review).
  const seriesCoverage = checkOptionSeriesCoverage(today, parsedSeriesRows, existingSeriesRows);
  if (!seriesCoverage.ok) abort(seriesCoverage.reason ?? 'option series coverage shrank');

  console.log(`[MasterContracts] Parsed ${entries.length} entries, inserting into DB...`);
  const sourceHash = createHash('sha256').update(text).digest('hex');

  // DELETE + re-insert inside ONE transaction: a crash mid-sync used to leave
  // an empty table until a human noticed. Now the old rows survive any failure.
  const CHUNK_SIZE = 500;
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS master_contract_snapshots (
          syncDate    TEXT PRIMARY KEY,
          totalRows   INTEGER NOT NULL,
          stableRows  INTEGER NOT NULL,
          optStkRows  INTEGER NOT NULL,
          completedAt TEXT NOT NULL,
          sourceHash  TEXT NOT NULL
        )
      `);
      // Clear all rows before re-inserting — ensures syncDate is always today
      await tx.$executeRawUnsafe('DELETE FROM master_contracts');
      for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
        const chunk = entries.slice(i, i + CHUNK_SIZE);
        const values = chunk
          .map((e) => {
            const esc = (s: string) => s.replace(/'/g, "''");
            const exp = e.expiryDate ? `'${e.expiryDate.toISOString()}'` : 'NULL';
            const und = e.underlying ? `'${esc(e.underlying)}'` : 'NULL';
            const sp = e.strikePrice !== null ? `${e.strikePrice}` : 'NULL';
            const ot = e.optionType ? `'${esc(e.optionType)}'` : 'NULL';
            return `(NULL, '${esc(e.securityId)}', '${esc(e.symbol)}', '${esc(e.exchange)}', '${esc(e.segment)}', '${esc(e.instrument)}', '${esc(e.name)}', ${und}, ${exp}, ${e.lotSize}, ${sp}, ${ot}, '${e.syncDate}')`;
          })
          .join(',');

        await tx.$executeRawUnsafe(
          `INSERT INTO master_contracts (id, securityId, symbol, exchange, segment, instrument, name, underlying, expiryDate, lotSize, strikePrice, optionType, syncDate) VALUES ${values}`,
        );

        if ((i / CHUNK_SIZE) % 50 === 0 && i > 0) {
          console.log(`[MasterContracts] Inserted ${i}/${entries.length}...`);
        }
      }

      const countRows = await tx.$queryRawUnsafe<
        { totalRows: number | bigint; stableRows: number | bigint; optStkRows: number | bigint }[]
      >(
        `SELECT COUNT(*) AS totalRows,
                SUM(CASE WHEN instrument IN ('EQUITY', 'FUTSTK', 'FUTIDX') THEN 1 ELSE 0 END) AS stableRows,
                SUM(CASE WHEN instrument = 'OPTSTK' AND segment = 'NSE_FNO' THEN 1 ELSE 0 END) AS optStkRows
           FROM master_contracts
          WHERE syncDate = ?`,
        today
      );
      const totalRows = Number(countRows[0]?.totalRows ?? 0);
      const stableRows = Number(countRows[0]?.stableRows ?? 0);
      const optStkRows = Number(countRows[0]?.optStkRows ?? 0);
      if (totalRows !== entries.length || stableRows !== parsedStable || optStkRows !== parsedOptStk) {
        throw new Error(
          `master-contracts post-insert proof failed: expected ${entries.length}/${parsedStable}/${parsedOptStk}, stored ${totalRows}/${stableRows}/${optStkRows}`
        );
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO master_contract_snapshots (syncDate, totalRows, stableRows, optStkRows, completedAt, sourceHash)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(syncDate) DO UPDATE SET
           totalRows = excluded.totalRows,
           stableRows = excluded.stableRows,
           optStkRows = excluded.optStkRows,
           completedAt = excluded.completedAt,
           sourceHash = excluded.sourceHash`,
        today,
        totalRows,
        stableRows,
        optStkRows,
        new Date().toISOString(),
        sourceHash
      );
    },
    { timeout: 180_000, maxWait: 15_000 },
  );

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`[MasterContracts] Synced ${entries.length} rows in ${elapsed}s`);
}

/**
 * Force a fresh sync from Dhan CSV (used by the re-sync API).
 * Returns the number of rows inserted.
 */
export async function forceSync(): Promise<{ count: number; elapsed: string }> {
  const today = todayIST();
  const startMs = Date.now();
  if (!(await tryAcquireRuntimeLease(MASTER_SYNC_LEASE, MASTER_SYNC_LEASE_TTL_MS))) {
    throw new Error('master-contracts sync already in progress on another server');
  }
  const renewal = setInterval(() => {
    void tryAcquireRuntimeLease(MASTER_SYNC_LEASE, MASTER_SYNC_LEASE_TTL_MS);
  }, 30_000);
  renewal.unref?.();
  try {
    await syncFromDhan(today);
    const freshness = await getMasterContractFreshness(today);
    if (!freshness.acceptable) {
      throw new Error(`master-contracts sync committed without a valid manifest: ${freshness.reason ?? 'unknown'}`);
    }
    syncedForDate = today;
    return { count: freshness.rowCount, elapsed: `${((Date.now() - startMs) / 1000).toFixed(1)}s` };
  } finally {
    clearInterval(renewal);
    await releaseRuntimeLease(MASTER_SYNC_LEASE);
  }
}

export interface MasterContractCatchUpResult {
  refreshed: boolean;
  freshness: MasterContractFreshness;
  sync: { count: number; elapsed: string } | null;
}

/** One-shot catch-up used at boot and before live capture. Dependency injection
 * keeps the stale->sync->verify safety sequence executable in CI without
 * downloading Dhan's large production CSV. The production sync is forceSync(),
 * which owns the cross-process lease above. */
export async function repairMasterContractsForDate(
  expectedSyncDate: string,
  dependencies: {
    readFreshness?: (date: string) => Promise<MasterContractFreshness>;
    sync?: () => Promise<{ count: number; elapsed: string }>;
  } = {}
): Promise<MasterContractCatchUpResult> {
  const readFreshness = dependencies.readFreshness ?? ((date: string) => getMasterContractFreshness(date));
  const sync = dependencies.sync ?? forceSync;
  const before = await readFreshness(expectedSyncDate);
  if (before.acceptable) return { refreshed: false, freshness: before, sync: null };
  const syncResult = await sync();
  const after = await readFreshness(expectedSyncDate);
  if (!after.acceptable) {
    throw new Error(`master-contracts catch-up did not produce a complete snapshot: ${after.reason ?? 'unknown'}`);
  }
  return { refreshed: true, freshness: after, sync: syncResult };
}

/**
 * Resolve equity security entry by symbol.
 */
export async function resolveSymbol(symbol: string, exchange = 'NSE'): Promise<SecurityEntry | null> {
  await ensureSynced();

  const row = await prisma.masterContract.findFirst({
    where: {
      symbol,
      exchange,
      segment: `${exchange}_EQ`,
    },
  });

  if (!row) return null;
  return {
    securityId: row.securityId,
    symbol: row.symbol,
    exchange: row.exchange,
    segment: row.segment,
    name: row.name,
    instrument: row.instrument,
  };
}

/**
 * Resolve near-month stock futures for a single underlying.
 */
export async function resolveFuturesSecurity(underlying: string): Promise<FuturesEntry | null> {
  await ensureSynced();

  const rows = await prisma.masterContract.findMany({
    where: {
      underlying,
      instrument: 'FUTSTK',
      segment: 'NSE_FNO',
      expiryDate: { gte: new Date() },
    },
    orderBy: { expiryDate: 'asc' },
    take: 1,
  });

  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    securityId: row.securityId,
    symbol: row.symbol,
    exchange: row.exchange,
    segment: row.segment,
    name: row.name,
    instrument: row.instrument,
    expiry: row.expiryDate!,
    underlying: row.underlying!,
  };
}

/**
 * Batch-resolve near-month futures security IDs for multiple underlyings.
 * Returns Map<underlying, { securityId, lotSize }>.
 */
export async function batchResolveFutures(
  underlyings: string[],
  tradeDate?: string,
): Promise<Map<string, { securityId: string; lotSize: number; expiryDate: string }>> {
  await ensureSynced();

  const result = new Map<string, { securityId: string; lotSize: number; expiryDate: string }>();
  if (underlyings.length === 0) return result;

  // Use tradeDate for historical resolution (finds contracts active on that date)
  const refDate = tradeDate ? new Date(tradeDate) : new Date();

  const rows = await prisma.masterContract.findMany({
    where: {
      underlying: { in: underlyings },
      instrument: 'FUTSTK',
      segment: 'NSE_FNO',
      expiryDate: { gte: refDate },
    },
    orderBy: { expiryDate: 'asc' },
  });

  // Pick nearest expiry per underlying
  for (const row of rows) {
    if (row.underlying && !result.has(row.underlying)) {
      const expiry = row.expiryDate ? new Date(row.expiryDate).toISOString().split('T')[0] : '';
      result.set(row.underlying, { securityId: row.securityId, lotSize: row.lotSize, expiryDate: expiry });
    }
  }

  return result;
}

/**
 * Search symbols by query string.
 */
export async function searchSymbols(query: string, exchange?: string): Promise<SecurityEntry[]> {
  await ensureSynced();

  const normalizedQuery = query.toUpperCase();

  const rows = await prisma.masterContract.findMany({
    where: {
      symbol: { contains: normalizedQuery },
      ...(exchange ? { exchange } : {}),
      segment: { endsWith: '_EQ' },
    },
    take: 200,
  });

  const rank = (symbol: string): number => {
    if (symbol === normalizedQuery) return 0;
    if (symbol.startsWith(normalizedQuery)) return 10;
    if (symbol.includes(normalizedQuery)) return 20;
    return 30;
  };

  return rows
    .map((r) => ({
      securityId: r.securityId,
      symbol: r.symbol,
      exchange: r.exchange,
      segment: r.segment,
      name: r.name,
      instrument: r.instrument,
    }))
    .sort((left, right) => {
      const rankDiff = rank(left.symbol) - rank(right.symbol);
      if (rankDiff !== 0) return rankDiff;

      const fnoBoostDiff = Number(FNO_SYMBOLS.has(right.symbol)) - Number(FNO_SYMBOLS.has(left.symbol));
      if (fnoBoostDiff !== 0) return fnoBoostDiff;

      const digitPenaltyDiff = Number(/\d/.test(left.symbol)) - Number(/\d/.test(right.symbol));
      if (digitPenaltyDiff !== 0) return digitPenaltyDiff;

      const lengthDiff = left.symbol.length - right.symbol.length;
      if (lengthDiff !== 0) return lengthDiff;

      return left.symbol.localeCompare(right.symbol);
    })
    .slice(0, 20);
}

export async function getFuturesContractsForRange(
  underlying: string,
  fromDate: string,
  toDate: string,
): Promise<FuturesRangeEntry[]> {
  await ensureSynced();

  const start = new Date(fromDate);
  const end = new Date(toDate);

  const rows = await prisma.masterContract.findMany({
    where: {
      underlying,
      instrument: 'FUTSTK',
      segment: 'NSE_FNO',
      expiryDate: { gte: start },
    },
    orderBy: { expiryDate: 'asc' },
  });

  return rows
    .filter((row) => row.expiryDate && row.expiryDate <= new Date(end.getTime() + 120 * 24 * 60 * 60 * 1000))
    .map((row) => ({
      securityId: row.securityId,
      symbol: row.symbol,
      exchange: row.exchange,
      segment: row.segment,
      name: row.name,
      instrument: row.instrument,
      expiry: row.expiryDate!,
      underlying: row.underlying!,
      lotSize: row.lotSize,
    }));
}

/**
 * Resolve a stock option contract by underlying, strike, and type.
 * Returns the nearest monthly expiry with >= minDTE days to expiry.
 */
export async function resolveOptionSecurity(
  underlying: string,
  strikePrice: number,
  optionType: 'CE' | 'PE',
  minDTE = 7,
  tradeDate?: string,
): Promise<{ securityId: string; symbol: string; lotSize: number; expiry: string } | null> {
  await ensureSynced();

  // Use tradeDate for historical resolution (finds contracts active on that date)
  const minExpiry = tradeDate ? new Date(tradeDate) : new Date();
  if (!tradeDate) minExpiry.setDate(minExpiry.getDate() + minDTE);
  const minExpiryStr = minExpiry.toISOString();

  // Use raw SQL to avoid Prisma client cache issues with new columns
  // Cast strikePrice to REAL for SQLite type compatibility
  const rows = await prisma.$queryRawUnsafe<
    { securityId: string; symbol: string; lotSize: number; expiryDate: string }[]
  >(
    `SELECT securityId, symbol, lotSize, expiryDate FROM master_contracts
     WHERE underlying = '${underlying.replace(/'/g, "''")}' AND instrument = 'OPTSTK' AND segment = 'NSE_FNO'
     AND optionType = '${optionType}' AND CAST(strikePrice AS REAL) = ${strikePrice} AND expiryDate >= '${minExpiryStr}'
     ORDER BY expiryDate ASC LIMIT 1`,
  );

  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    securityId: row.securityId,
    symbol: row.symbol,
    lotSize: row.lotSize,
    expiry: row.expiryDate ? new Date(row.expiryDate).toISOString().split('T')[0] : '',
  };
}

/** Strike step sizes for common F&O stocks (from NSE circular) */
const STRIKE_STEPS: Record<string, number> = {
  RELIANCE: 20,
  TCS: 50,
  HDFCBANK: 25,
  INFY: 25,
  SBIN: 5,
  ICICIBANK: 25,
  KOTAKBANK: 25,
  LT: 50,
  HINDUNILVR: 25,
  ITC: 5,
  AXISBANK: 25,
  BAJFINANCE: 25,
  MARUTI: 100,
  WIPRO: 5,
  TATAMOTORS: 10,
  HCLTECH: 25,
  BHARTIARTL: 25,
  TATASTEEL: 5,
  NTPC: 5,
  ONGC: 5,
  POWERGRID: 5,
  SUNPHARMA: 25,
  M_M: 25,
  ADANIENT: 50,
  ADANIPORTS: 25,
  TITAN: 50,
  ULTRACEMCO: 50,
  BAJAJFINSV: 25,
  JSWSTEEL: 25,
  DIVISLAB: 50,
  NESTLEIND: 100,
  APOLLOHOSP: 100,
  CIPLA: 25,
  EICHERMOT: 100,
  GRASIM: 25,
  INDUSINDBK: 25,
  COALINDIA: 5,
  BPCL: 5,
  VEDL: 5,
  HINDALCO: 10,
  DLF: 10,
  GODREJPROP: 25,
  PRESTIGE: 25,
  MCX: 50,
  BSE: 50,
  IREDA: 5,
  NHPC: 5,
  PFC: 5,
  RECLTD: 5,
  SAIL: 5,
};

/** Get the strike step for a stock. Falls back to 25 (most common). */
export function getStrikeStep(symbol: string): number {
  return STRIKE_STEPS[symbol] ?? 25;
}

/** Calculate ATM strike from spot price */
export function nearestStrike(spot: number, strikeStep: number): number {
  return Math.round(spot / strikeStep) * strikeStep;
}
