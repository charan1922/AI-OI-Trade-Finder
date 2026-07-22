import { prisma } from '@/lib/db';
import { RFACTOR_V2_CONFIG_HASH, RFACTOR_V2_MODEL_VERSION } from './engine';
import type { OptionActivityEvidence, RFactorV2Input, RFactorV2Result } from './types';

/** Sessions of shadow evidence to retain, matching the candle/rank retention. */
export const RFACTOR_V2_RETENTION_SESSIONS = 20;

/** Minimum prior sessions before a per-stock dispersion is trusted for a z-score. */
const MIN_SESSIONS_FOR_Z = 8;
/** Minimum prior sessions before a plain same-clock mean is trusted. */
const MIN_SESSIONS_FOR_MEAN = 5;
/** Minimum prior sessions before a same-clock OPTION premium baseline is trusted. */
const MIN_SESSIONS_FOR_OPTION_BASELINE = 3;

let tablesReady = false;

/** Adds a column to an existing raw-SQL table, ignoring "already exists". */
async function addColumnIfMissing(table: string, column: string, decl: string): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  } catch {
    // Column already present — the only expected failure here.
  }
}

export async function ensureRFactorV2Tables(): Promise<void> {
  if (tablesReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rfactor_v2_snapshots (
      date TEXT NOT NULL, bucketTs INTEGER NOT NULL, symbol TEXT NOT NULL, capturedAt TEXT NOT NULL,
      oldRFactor REAL, activityScore REAL NOT NULL, rawActivity REAL NOT NULL,
      activityPercentile REAL NOT NULL, activityRank INTEGER NOT NULL, universeSize INTEGER NOT NULL,
      direction TEXT NOT NULL, directionScore REAL NOT NULL, directionConfidence REAL NOT NULL,
      coverage REAL NOT NULL, optionStatus TEXT NOT NULL, inputs TEXT NOT NULL, factors TEXT NOT NULL,
      PRIMARY KEY (date, bucketTs, symbol)
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_rfactor_v2_snapshots_date_symbol ON rfactor_v2_snapshots (date, symbol, bucketTs)`,
  );
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rfactor_v2_option_snapshots (
      date TEXT NOT NULL, bucketTs INTEGER NOT NULL, symbol TEXT NOT NULL, capturedAt TEXT NOT NULL,
      expiry TEXT NOT NULL, activityScore REAL NOT NULL, direction TEXT NOT NULL,
      directionScore REAL NOT NULL, directionConfidence REAL NOT NULL, evidence TEXT NOT NULL,
      PRIMARY KEY (date, bucketTs, symbol)
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_rfactor_v2_option_latest ON rfactor_v2_option_snapshots (date, symbol, bucketTs DESC)`,
  );
  // Additive columns for installs created before these fields existed.
  await addColumnIfMissing('rfactor_v2_snapshots', 'comparableActivity', 'REAL NOT NULL DEFAULT 0');
  await addColumnIfMissing('rfactor_v2_snapshots', 'comparableCoverage', 'REAL NOT NULL DEFAULT 0');
  // Exact observed price at the moment of the snapshot. The evaluator uses this
  // as the entry reference instead of inferring one from a candle, which is
  // guesswork about when a bar's close first became visible.
  await addColumnIfMissing('rfactor_v2_snapshots', 'ltp', 'REAL');
  // Which scoring definition produced the row. Without these the evaluator
  // could silently average sessions scored under different rules.
  await addColumnIfMissing('rfactor_v2_snapshots', 'modelVersion', `TEXT NOT NULL DEFAULT 'unknown'`);
  await addColumnIfMissing('rfactor_v2_snapshots', 'configHash', `TEXT NOT NULL DEFAULT 'unknown'`);
  await addColumnIfMissing('rfactor_v2_option_snapshots', 'premiumValue', 'REAL NOT NULL DEFAULT 0');
  await addColumnIfMissing('rfactor_v2_option_snapshots', 'optionVolume', 'REAL NOT NULL DEFAULT 0');
  await addColumnIfMissing('rfactor_v2_option_snapshots', 'paceBaselineKind', `TEXT NOT NULL DEFAULT 'missing'`);
  tablesReady = true;
}

export interface SameTimeBaseline {
  /** Robust centre (median) of this stock's own same-clock history. */
  median: number;
  /** Median absolute deviation — this stock's own normal day-to-day spread. */
  mad: number;
  sessions: number;
  premiumMedian: number | null;
  premiumSessions: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Robust z-score: 0.6745 × (value − median) / MAD. Uses the median and median
 * absolute deviation rather than mean/stddev so one violent session in a stock's
 * history cannot inflate its own "normal" and hide a genuine outlier today.
 * Returns null when the stock has too little history for the spread to mean
 * anything — a missing z is honest; a fabricated one is not.
 */
export function robustZScore(baseline: SameTimeBaseline | undefined, value: number | null): number | null {
  if (baseline == null || value == null || !Number.isFinite(value)) return null;
  if (baseline.sessions < MIN_SESSIONS_FOR_Z || !(baseline.mad > 0)) return null;
  return (0.6745 * (value - baseline.median)) / baseline.mad;
}

export function istMinuteOfDay(nowMs: number): number {
  const istSeconds = nowMs / 1000 + 5.5 * 3600;
  return Math.floor((((istSeconds % 86400) + 86400) % 86400) / 60);
}

/** The raw (uncached) same-clock history read. Never call this on a request path. */
async function querySameTimeBaselines(
  date: string,
  symbols: string[],
  nowMs: number,
): Promise<Map<string, SameTimeBaseline>> {
  const output = new Map<string, SameTimeBaseline>();
  if (symbols.length === 0) return output;
  const targetMinute = istMinuteOfDay(nowMs);
  try {
    const placeholders = symbols.map(() => '?').join(',');
    // One row per (symbol, prior session): the sample nearest this clock time.
    // Dispersion is computed in JS so the estimator can be robust (median/MAD),
    // which SQLite cannot express, and so large turnover values never lose
    // precision to a sum-of-squares variance.
    const rows = await prisma.$queryRawUnsafe<
      { symbol: string; futTurnover: number; premValueCr: number | null }[]
    >(
      `WITH ranked AS (
         SELECT symbol, date, futTurnover, premValueCr,
                ABS(CAST((((bucketTs + 19800) % 86400) / 60) AS INTEGER) - ?) AS minuteGap,
                ROW_NUMBER() OVER (
                  PARTITION BY symbol, date
                  ORDER BY ABS(CAST((((bucketTs + 19800) % 86400) / 60) AS INTEGER) - ?)
                ) AS rn
           FROM oi_intraday
          WHERE date < ? AND symbol IN (${placeholders}) AND futTurnover > 0
       )
       SELECT symbol, futTurnover, premValueCr FROM ranked WHERE rn = 1 AND minuteGap <= 10`,
      targetMinute,
      targetMinute,
      date,
      ...symbols,
    );
    const bySymbol = new Map<string, { turnover: number[]; premium: number[] }>();
    for (const row of rows) {
      const entry = bySymbol.get(row.symbol) ?? { turnover: [], premium: [] };
      entry.turnover.push(Number(row.futTurnover));
      const premium = row.premValueCr == null ? 0 : Number(row.premValueCr);
      if (premium > 0) entry.premium.push(premium);
      bySymbol.set(row.symbol, entry);
    }
    for (const [symbol, entry] of bySymbol) {
      if (entry.turnover.length < MIN_SESSIONS_FOR_MEAN) continue;
      const centre = median(entry.turnover);
      output.set(symbol, {
        median: centre,
        mad: median(entry.turnover.map((value) => Math.abs(value - centre))),
        sessions: entry.turnover.length,
        premiumMedian: entry.premium.length >= MIN_SESSIONS_FOR_MEAN ? median(entry.premium) : null,
        premiumSessions: entry.premium.length,
      });
    }
  } catch {
    // Early installs or old databases may not have enough intraday history yet.
  }
  return output;
}

interface BaselineCache {
  key: string | null;
  value: Map<string, SameTimeBaseline>;
  computedAtMs: number;
  refreshing: boolean;
  known: Set<string>;
}
const baselineHost = globalThis as unknown as { __rfactorV2Baselines?: BaselineCache };
baselineHost.__rfactorV2Baselines ??= {
  key: null,
  value: new Map(),
  computedAtMs: 0,
  refreshing: false,
  known: new Set(),
};
const baselineCache = baselineHost.__rfactorV2Baselines;

/** Clock resolution of the baseline cache; well inside the query's ±10min match. */
const BASELINE_BUCKET_MIN = 5;
/** Beyond this the previous bucket's baseline is dropped rather than served. */
const BASELINE_MAX_STALE_MS = 15 * 60_000;

/**
 * Same-clock baselines WITHOUT blocking the caller. The underlying window query
 * costs ~230ms on a season of intraday history and grows with it, so it must
 * never sit in front of a live quote response — `/live` polls it every few
 * seconds and the trade scanner bypasses the response cache entirely.
 *
 * The first call in a clock bucket returns the previous bucket's numbers (or
 * nothing at all on a cold start) and refreshes in the background. A baseline a
 * few minutes old is inside the ±10-minute window the query already tolerates;
 * no baseline at all simply falls back to the clearly-labelled linear estimate.
 */
export function getSameTimeBaselines(date: string, symbols: string[], nowMs: number): Map<string, SameTimeBaseline> {
  const key = `${date}|${Math.floor(istMinuteOfDay(nowMs) / BASELINE_BUCKET_MIN)}`;
  const missingSymbol = symbols.some((symbol) => !baselineCache.known.has(symbol));
  if ((baselineCache.key !== key || missingSymbol) && !baselineCache.refreshing) {
    baselineCache.refreshing = true;
    const wanted = [...new Set([...baselineCache.known, ...symbols])];
    void querySameTimeBaselines(date, wanted, nowMs)
      .then((value) => {
        baselineCache.key = key;
        baselineCache.value = value;
        baselineCache.computedAtMs = Date.now();
        baselineCache.known = new Set(wanted);
      })
      .catch((error) => {
        console.warn(`[RFactorV2] baseline refresh failed: ${(error as Error).message}`);
      })
      .finally(() => {
        baselineCache.refreshing = false;
      });
  }
  if (baselineCache.key == null) return new Map();
  if (nowMs - baselineCache.computedAtMs > BASELINE_MAX_STALE_MS) return new Map();
  return baselineCache.value;
}

/** Test seam: drop the process-wide baseline cache. */
export function resetSameTimeBaselineCache(): void {
  baselineCache.key = null;
  baselineCache.value = new Map();
  baselineCache.computedAtMs = 0;
  baselineCache.known = new Set();
}

/**
 * Same-clock traded-premium baseline for ONE underlying, from prior sessions of
 * retained option evidence.
 *
 * Scoped to a SINGLE expiry on purpose. An expiring contract and a freshly
 * rolled one carry very different time value, so comparing across a rollover
 * would manufacture a premium-participation spike out of nothing but the
 * calendar. After a roll there are no prior sessions for the new expiry, so this
 * correctly returns null and the caller falls back to the linear estimate and
 * labels it — a few sessions of honest estimate beat a confident wrong number.
 */
export async function loadSameTimeOptionBaseline(
  symbol: string,
  expiry: string,
  date: string,
  nowMs: number,
): Promise<number | null> {
  await ensureRFactorV2Tables();
  const targetMinute = istMinuteOfDay(nowMs);
  try {
    const rows = await prisma.$queryRawUnsafe<{ premiumValue: number }[]>(
      `WITH ranked AS (
         SELECT date, premiumValue,
                ROW_NUMBER() OVER (
                  PARTITION BY date
                  ORDER BY ABS(CAST((((bucketTs + 19800) % 86400) / 60) AS INTEGER) - ?)
                ) AS rn,
                ABS(CAST((((bucketTs + 19800) % 86400) / 60) AS INTEGER) - ?) AS minuteGap
           FROM rfactor_v2_option_snapshots
          WHERE symbol = ? AND expiry = ? AND date < ? AND premiumValue > 0
       )
       SELECT premiumValue FROM ranked WHERE rn = 1 AND minuteGap <= 15`,
      targetMinute,
      targetMinute,
      symbol,
      expiry,
      date,
    );
    if (rows.length < MIN_SESSIONS_FOR_OPTION_BASELINE) return null;
    return median(rows.map((row) => Number(row.premiumValue)));
  } catch {
    return null;
  }
}

/** Columns per inserted row — keeps batches under SQLite's 999-variable limit. */
const SNAPSHOT_COLS = 22;
const SNAPSHOT_BATCH_ROWS = 40;

interface WriteGuard {
  lastBucketTs: number;
  lastSymbolCount: number;
  inFlight: boolean;
}
const writeHost = globalThis as unknown as { __rfactorV2Write?: WriteGuard };
writeHost.__rfactorV2Write ??= { lastBucketTs: 0, lastSymbolCount: 0, inFlight: false };
const writeGuard = writeHost.__rfactorV2Write;

/**
 * Persist one row per symbol per MINUTE.
 *
 * `/live` recomputes roughly every 7 seconds and several sections poll with
 * different symbol lists, so without a guard this would fire a full-universe
 * write many times a minute — contending for SQLite's write lock against
 * money-touching work, and letting a slower earlier transaction overwrite a
 * newer observation for the same bucket.
 *
 * Three defences, matching the oi_intraday writer:
 *   - skip entirely once this minute is already stored (a wider symbol list is
 *     allowed through once, so a bigger poll can still fill in the rest);
 *   - drop the write if one is already in flight rather than queueing another;
 *   - INSERT OR IGNORE in batched multi-row statements, so the first
 *     observation of a minute wins deterministically and repeats collapse.
 */
export async function recordRFactorV2Batch(
  date: string,
  oldScores: Map<string, number | null>,
  inputs: RFactorV2Input[],
  results: Map<string, RFactorV2Result>,
  nowMs: number,
  ltpBySymbol: Map<string, number | null> = new Map(),
): Promise<void> {
  if (inputs.length === 0) return;
  const bucketTs = Math.floor(nowMs / 60_000) * 60;
  if (writeGuard.inFlight) return;
  const sameBucket = writeGuard.lastBucketTs === bucketTs;
  if (sameBucket && inputs.length <= writeGuard.lastSymbolCount) return;

  writeGuard.inFlight = true;
  try {
    await ensureRFactorV2Tables();
    const capturedAt = new Date(nowMs).toISOString();
    const rows = inputs.flatMap((input) => {
      const result = results.get(input.symbol);
      return result == null ? [] : [{ input, result }];
    });
    for (let start = 0; start < rows.length; start += SNAPSHOT_BATCH_ROWS) {
      const chunk = rows.slice(start, start + SNAPSHOT_BATCH_ROWS);
      const placeholders = chunk.map(() => `(${Array(SNAPSHOT_COLS).fill('?').join(',')})`).join(',');
      const params: unknown[] = [];
      for (const { input, result } of chunk) {
        params.push(
          date,
          bucketTs,
          input.symbol,
          capturedAt,
          ltpBySymbol.get(input.symbol) ?? null,
          oldScores.get(input.symbol) ?? null,
          result.activityScore,
          result.rawActivity,
          result.comparableActivity,
          result.activityPercentile,
          result.activityRank,
          result.universeSize,
          result.direction,
          result.directionScore,
          result.directionConfidence,
          result.coverage,
          result.comparableCoverage,
          result.optionStatus,
          RFACTOR_V2_MODEL_VERSION,
          RFACTOR_V2_CONFIG_HASH,
          JSON.stringify(input),
          JSON.stringify(result.factors),
        );
      }
      await prisma.$executeRawUnsafe(
        `INSERT OR IGNORE INTO rfactor_v2_snapshots
          (date,bucketTs,symbol,capturedAt,ltp,oldRFactor,activityScore,rawActivity,comparableActivity,
           activityPercentile,activityRank,universeSize,direction,directionScore,directionConfidence,
           coverage,comparableCoverage,optionStatus,modelVersion,configHash,inputs,factors)
         VALUES ${placeholders}`,
        ...params,
      );
    }
    writeGuard.lastBucketTs = bucketTs;
    writeGuard.lastSymbolCount = sameBucket ? Math.max(writeGuard.lastSymbolCount, inputs.length) : inputs.length;
  } finally {
    writeGuard.inFlight = false;
  }
}

/** Test seam: drop the process-wide once-per-minute write guard. */
export function resetRFactorV2WriteGuard(): void {
  writeGuard.lastBucketTs = 0;
  writeGuard.lastSymbolCount = 0;
  writeGuard.inFlight = false;
}

export async function recordOptionEvidence(symbol: string, evidence: OptionActivityEvidence): Promise<void> {
  await ensureRFactorV2Tables();
  const capturedMs = Date.parse(evidence.capturedAt);
  const date = new Date(capturedMs + 5.5 * 3600_000).toISOString().slice(0, 10);
  const bucketTs = Math.floor(capturedMs / 60_000) * 60;
  await prisma.$executeRawUnsafe(
    `INSERT INTO rfactor_v2_option_snapshots
      (date,bucketTs,symbol,capturedAt,expiry,activityScore,direction,directionScore,directionConfidence,
       premiumValue,optionVolume,paceBaselineKind,evidence)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(date,bucketTs,symbol) DO UPDATE SET
       capturedAt=excluded.capturedAt, expiry=excluded.expiry, activityScore=excluded.activityScore,
       direction=excluded.direction, directionScore=excluded.directionScore,
       directionConfidence=excluded.directionConfidence, premiumValue=excluded.premiumValue,
       optionVolume=excluded.optionVolume, paceBaselineKind=excluded.paceBaselineKind,
       evidence=excluded.evidence`,
    date,
    bucketTs,
    symbol,
    evidence.capturedAt,
    evidence.expiry,
    evidence.activityScore,
    evidence.direction,
    evidence.directionScore,
    evidence.directionConfidence,
    evidence.premiumValue,
    evidence.optionVolume,
    evidence.paceBaselineKind,
    JSON.stringify(evidence),
  );
}

/**
 * Retention for both shadow tables: keep the newest
 * RFACTOR_V2_RETENTION_SESSIONS dates, matching the candle/rank policy. The
 * snapshot table carries two JSON blobs per row at roughly one row per symbol
 * per minute, so without this it is the fastest-growing table in the database.
 */
export async function pruneRFactorV2Snapshots(): Promise<number> {
  await ensureRFactorV2Tables();
  let deleted = 0;
  for (const table of ['rfactor_v2_snapshots', 'rfactor_v2_option_snapshots']) {
    deleted += await prisma.$executeRawUnsafe(
      `DELETE FROM ${table} WHERE date NOT IN (
         SELECT DISTINCT date FROM ${table} ORDER BY date DESC LIMIT ${RFACTOR_V2_RETENTION_SESSIONS}
       )`,
    );
  }
  return deleted;
}
