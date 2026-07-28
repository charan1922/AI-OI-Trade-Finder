import { prisma } from '@/lib/db';
import { RFACTOR_V2_CONFIG_HASH, RFACTOR_V2_MODEL_VERSION } from './engine';
import { OPTION_EVIDENCE_VERSION } from './option-evidence';
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
  // Which exact symbol set this minute's ranking was computed against.
  await addColumnIfMissing('rfactor_v2_snapshots', 'universeKey', `TEXT NOT NULL DEFAULT 'unknown'`);
  // Total symbols the ranking was computed over. Distinct from universeSize,
  // which counts only the RANKABLE subset — ownership compares total input.
  await addColumnIfMissing('rfactor_v2_snapshots', 'inputUniverseSize', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing('rfactor_v2_option_snapshots', 'premiumValue', 'REAL NOT NULL DEFAULT 0');
  await addColumnIfMissing('rfactor_v2_option_snapshots', 'optionVolume', 'REAL NOT NULL DEFAULT 0');
  await addColumnIfMissing('rfactor_v2_option_snapshots', 'paceBaselineKind', `TEXT NOT NULL DEFAULT 'missing'`);
  // Option evidence carries its OWN version. v2.2 redefined premiumValue from
  // LTP x volume to VWAP x volume, so a baseline built from older rows would
  // normalise today's number against an incompatible one — and the resulting
  // snapshot would still be stamped with the CURRENT model version, hiding it.
  await addColumnIfMissing(
    'rfactor_v2_option_snapshots',
    'optionEvidenceVersion',
    `TEXT NOT NULL DEFAULT 'unknown'`,
  );

  // Who owns each minute. Ownership must survive a process restart and must not
  // depend on the order writes happen to arrive in, so it lives in the database
  // rather than in a module-level "last bucket I saw".
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS rfactor_v2_bucket_owner (
      date TEXT NOT NULL, bucketTs INTEGER NOT NULL,
      universeKey TEXT NOT NULL, inputUniverseSize INTEGER NOT NULL, capturedAt TEXT NOT NULL,
      PRIMARY KEY (date, bucketTs)
    )
  `);
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
    // Scoped to the CURRENT option-evidence definition as well as the expiry.
    // v2.2 redefined premiumValue from LTP x volume to VWAP x volume, so an
    // older row is a different measurement — normalising against it would
    // produce a pace that is wrong in a way nothing downstream could detect,
    // since the resulting snapshot still carries today's model version.
    // Legacy rows default to 'unknown' and therefore never qualify.
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
            AND optionEvidenceVersion = ?
       )
       SELECT premiumValue FROM ranked WHERE rn = 1 AND minuteGap <= 15`,
      targetMinute,
      targetMinute,
      symbol,
      expiry,
      date,
      OPTION_EVIDENCE_VERSION,
    );
    if (rows.length < MIN_SESSIONS_FOR_OPTION_BASELINE) return null;
    return median(rows.map((row) => Number(row.premiumValue)));
  } catch {
    return null;
  }
}

/** Columns per inserted row — keeps batches under SQLite's 999-variable limit. */
const SNAPSHOT_COLS = 24;
const SNAPSHOT_BATCH_ROWS = 40;

interface PendingWrite {
  date: string;
  oldScores: Map<string, number | null>;
  inputs: RFactorV2Input[];
  results: Map<string, RFactorV2Result>;
  nowMs: number;
  ltpBySymbol: Map<string, number | null>;
}

interface WriteGuard {
  inFlight: boolean;
  /**
   * Universes that arrived while a write was busy, keyed by `date|bucketTs`.
   *
   * A single global slot was wrong: it kept whichever payload had the most
   * symbols regardless of WHICH MINUTE it belonged to, so a delayed 10:00
   * 166-name payload would evict a pending 10:01 20-name payload and the 10:01
   * observation was simply lost. Minutes are independent and each keeps its own
   * best candidate.
   */
  pending: Map<string, PendingWrite>;
  /** Universes this process already wrote, to skip provably redundant work. */
  writtenKeys: Set<string>;
}
const writeHost = globalThis as unknown as { __rfactorV2Write?: WriteGuard };
writeHost.__rfactorV2Write ??= {
  inFlight: false,
  pending: new Map(),
  writtenKeys: new Set(),
};
const writeGuard = writeHost.__rfactorV2Write;
writeGuard.pending ??= new Map();
writeGuard.writtenKeys ??= new Set();

const bucketKey = (date: string, bucketTs: number): string => `${date}|${bucketTs}`;

/**
 * Stable fingerprint of the exact symbol set a computation covered. Two equally
 * sized but different watchlists must not look interchangeable.
 */
export function universeKeyFor(symbols: string[]): string {
  const canonical = [...symbols].sort().join(',');
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${symbols.length}-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * Persist ONE canonical universe per minute.
 *
 * `/live` recomputes roughly every 7 seconds and its category sections each
 * poll with a DIFFERENT symbol list, while the scanner polls the full universe.
 * Two things follow, and both matter:
 *
 *   1. Writing on every computation would fire full-universe transactions many
 *      times a minute, contending for SQLite's write lock with money-touching
 *      work.
 *   2. `activityRank`, `activityPercentile` and `universeSize` are all relative
 *      to whichever symbol list was computed. Mixing a 20-name UI section with
 *      the 166-name scanner inside one minute would store two incompatible
 *      definitions under identical column names — evidence that looks
 *      comparable and is not. Counting symbols is not enough to tell them
 *      apart either: two different 60-name watchlists are the same size.
 *
 * So a minute is owned by the LARGEST universe seen in it, identified by an
 * exact symbol-set fingerprint. A strictly larger universe replaces the minute
 * wholesale; anything smaller or differently-shaped is dropped rather than
 * interleaved. The result is one internally consistent ranking per bucket.
 *
 * Ownership is resolved against the DATABASE inside the replacing transaction,
 * never against a remembered "last bucket". Process memory cannot answer this:
 * a restart mid-minute would forget an owner whose rows are still in SQLite,
 * and writes do not arrive in clock order — the route awaits several I/O steps
 * between stamping its timestamp and firing this off, so a larger 10:00 write
 * can land after a smaller 10:01 one.
 */
export async function recordRFactorV2Batch(
  date: string,
  oldScores: Map<string, number | null>,
  inputs: RFactorV2Input[],
  results: Map<string, RFactorV2Result>,
  nowMs: number,
  ltpBySymbol: Map<string, number | null> = new Map(),
): Promise<void> {
  // Defence in depth against a duplicated watchlist: the engine keys its
  // results by symbol, so a repeated name adds nothing but WOULD inflate the
  // universe size and let a 200-copy list out-rank a genuine 166-name scan.
  // The route dedupes too; this makes the store correct on its own.
  const uniqueInputs = [...new Map(inputs.map((input) => [input.symbol, input])).values()];
  if (uniqueInputs.length === 0) return;
  const payload: PendingWrite = { date, oldScores, inputs: uniqueInputs, results, nowMs, ltpBySymbol };
  const bucketTs = Math.floor(nowMs / 60_000) * 60;
  const key = bucketKey(date, bucketTs);

  // Already stored this exact universe for this exact minute — nothing to learn.
  // Only a redundancy short-circuit; it never decides ownership.
  if (writeGuard.writtenKeys.has(`${key}|${universeKeyFor(uniqueInputs.map((i) => i.symbol))}`)) return;

  // Coalesce rather than drop, PER MINUTE. Returning early on `inFlight` meant
  // the minute was owned by the largest universe that happened to arrive while
  // the writer was IDLE — a 166-name scanner result landing during a 20-name
  // section's write was thrown away.
  if (writeGuard.inFlight) {
    const existing = writeGuard.pending.get(key);
    if (existing == null || uniqueInputs.length > existing.inputs.length) {
      writeGuard.pending.set(key, payload);
    }
    return;
  }

  writeGuard.inFlight = true;
  try {
    let next: PendingWrite | null = payload;
    while (next != null) {
      await writeUniverseSnapshot(next);
      // Drain chronologically so a delayed older minute cannot jump the queue.
      const queued = [...writeGuard.pending.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      if (queued.length === 0) break;
      writeGuard.pending.delete(queued[0][0]);
      next = queued[0][1];
    }
  } finally {
    writeGuard.inFlight = false;
  }
}

/** One minute-bucket write. Ownership checks live here so a coalesced pending
 *  candidate is re-judged against whatever the previous write just stored. */
async function writeUniverseSnapshot(payload: PendingWrite): Promise<void> {
  const { date, oldScores, inputs, results, nowMs, ltpBySymbol } = payload;
  const bucketTs = Math.floor(nowMs / 60_000) * 60;
  const universeKey = universeKeyFor(inputs.map((input) => input.symbol));

  await ensureRFactorV2Tables();
  const capturedAt = new Date(nowMs).toISOString();
  const rows = inputs.flatMap((input) => {
    const result = results.get(input.symbol);
    return result == null ? [] : [{ input, result }];
  });
  if (rows.length === 0) return;

  // Ownership decision AND replacement in one interactive transaction. Reading
  // the current owner from the database is what makes this correct across a
  // process restart and across out-of-order arrivals; a remembered "last
  // bucket" answers neither. The DELETE and every INSERT chunk ride the same
  // transaction, so a crash or lock partway through leaves the previous
  // universe intact rather than an empty or half-filled minute — which, because
  // every surviving row would share one universeKey, the evaluator's
  // consistency check would happily call healthy.
  await prisma.$transaction(async (tx) => {
    const owner = await tx.$queryRawUnsafe<{ universeKey: string; inputUniverseSize: number }[]>(
      `SELECT universeKey, inputUniverseSize FROM rfactor_v2_bucket_owner WHERE date = ? AND bucketTs = ?`,
      date,
      bucketTs,
    );
    const current = owner[0];
    if (current != null) {
      // Same universe already stored, or a smaller/equal-but-different one:
      // either way this computation adds nothing and must not be interleaved.
      if (current.universeKey === universeKey) return;
      if (inputs.length <= Number(current.inputUniverseSize)) return;
      await tx.$executeRawUnsafe(
        `DELETE FROM rfactor_v2_snapshots WHERE date = ? AND bucketTs = ?`,
        date,
        bucketTs,
      );
    }

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
          inputs.length,
          result.direction,
          result.directionScore,
          result.directionConfidence,
          result.coverage,
          result.comparableCoverage,
          result.optionStatus,
          RFACTOR_V2_MODEL_VERSION,
          RFACTOR_V2_CONFIG_HASH,
          universeKey,
          JSON.stringify(input),
          JSON.stringify(result.factors),
        );
      }
      await tx.$executeRawUnsafe(
        `INSERT OR IGNORE INTO rfactor_v2_snapshots
          (date,bucketTs,symbol,capturedAt,ltp,oldRFactor,activityScore,rawActivity,comparableActivity,
           activityPercentile,activityRank,universeSize,inputUniverseSize,direction,directionScore,
           directionConfidence,coverage,comparableCoverage,optionStatus,modelVersion,configHash,
           universeKey,inputs,factors)
         VALUES ${placeholders}`,
        ...params,
      );
    }

    await tx.$executeRawUnsafe(
      `INSERT INTO rfactor_v2_bucket_owner (date,bucketTs,universeKey,inputUniverseSize,capturedAt)
       VALUES (?,?,?,?,?)
       ON CONFLICT(date,bucketTs) DO UPDATE SET
         universeKey=excluded.universeKey,
         inputUniverseSize=excluded.inputUniverseSize,
         capturedAt=excluded.capturedAt`,
      date,
      bucketTs,
      universeKey,
      inputs.length,
      capturedAt,
    );
  });
  writeGuard.writtenKeys.add(`${bucketKey(date, bucketTs)}|${universeKey}`);
}

/** Test seam: drop the process-local redundancy caches. Ownership lives in the
 *  database, so clearing this can never change which universe owns a minute. */
export function resetRFactorV2WriteGuard(): void {
  writeGuard.inFlight = false;
  writeGuard.pending = new Map();
  writeGuard.writtenKeys = new Set();
}

export async function recordOptionEvidence(symbol: string, evidence: OptionActivityEvidence): Promise<void> {
  await ensureRFactorV2Tables();
  const capturedMs = Date.parse(evidence.capturedAt);
  const date = new Date(capturedMs + 5.5 * 3600_000).toISOString().slice(0, 10);
  const bucketTs = Math.floor(capturedMs / 60_000) * 60;
  await prisma.$executeRawUnsafe(
    `INSERT INTO rfactor_v2_option_snapshots
      (date,bucketTs,symbol,capturedAt,expiry,activityScore,direction,directionScore,directionConfidence,
       premiumValue,optionVolume,paceBaselineKind,optionEvidenceVersion,evidence)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(date,bucketTs,symbol) DO UPDATE SET
       capturedAt=excluded.capturedAt, expiry=excluded.expiry, activityScore=excluded.activityScore,
       direction=excluded.direction, directionScore=excluded.directionScore,
       directionConfidence=excluded.directionConfidence, premiumValue=excluded.premiumValue,
       optionVolume=excluded.optionVolume, paceBaselineKind=excluded.paceBaselineKind,
       optionEvidenceVersion=excluded.optionEvidenceVersion,
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
    OPTION_EVIDENCE_VERSION,
    JSON.stringify(evidence),
  );
}

/** One symbol's LAST shadow snapshot of a session — the fields the frozen
 *  end-of-day board persists. Same shape the live row carries. */
export interface RFactorV2DaySnapshot {
  activityScore: number;
  activityPercentile: number;
  activityRank: number;
  universeSize: number;
  direction: 'bullish' | 'bearish' | 'neutral';
  directionConfidence: number;
  coverage: number;
  comparableCoverage: number;
  optionStatus: 'available' | 'pending';
  factors: unknown[];
}

/**
 * The FINAL shadow snapshot of `date` for each of `symbols`, keyed by symbol.
 *
 * Exists so the end-of-session capture can freeze the shadow R-Factor next to
 * the live one (lib/signals/live-urgency-eod.ts). Without it the shadow is
 * display-only and dies at 15:30: `live_urgency_eod` carried no V2 columns, so
 * after the close there was no way to ask "did the shadow rank better than the
 * live score?" — the whole point of running it in shadow.
 *
 * Reads only rows already recorded during the session; it never recomputes.
 * Empty map when the session predates the shadow or was pruned by retention.
 */
export async function getLastV2SnapshotsForDate(
  date: string,
  symbols: string[],
): Promise<Map<string, RFactorV2DaySnapshot>> {
  const out = new Map<string, RFactorV2DaySnapshot>();
  if (symbols.length === 0) return out;
  await ensureRFactorV2Tables();
  // One row per symbol: the greatest bucketTs that symbol reached that day.
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT s.* FROM rfactor_v2_snapshots s
       JOIN (SELECT symbol, MAX(bucketTs) AS mx FROM rfactor_v2_snapshots
              WHERE date = ? GROUP BY symbol) last
         ON last.symbol = s.symbol AND last.mx = s.bucketTs
      WHERE s.date = ?`,
    date,
    date,
  );
  const wanted = new Set(symbols);
  for (const r of rows) {
    const symbol = String(r.symbol);
    if (!wanted.has(symbol)) continue;
    let factors: unknown[] = [];
    try {
      const parsed = JSON.parse(String(r.factors ?? '[]'));
      if (Array.isArray(parsed)) factors = parsed;
    } catch {
      // malformed blob — persist an empty factor list rather than dropping the row
    }
    out.set(symbol, {
      activityScore: Number(r.activityScore),
      activityPercentile: Number(r.activityPercentile),
      activityRank: Number(r.activityRank),
      universeSize: Number(r.universeSize),
      direction: (r.direction as RFactorV2DaySnapshot['direction']) ?? 'neutral',
      directionConfidence: Number(r.directionConfidence),
      coverage: Number(r.coverage),
      comparableCoverage: Number(r.comparableCoverage ?? r.coverage),
      optionStatus: (r.optionStatus as RFactorV2DaySnapshot['optionStatus']) ?? 'pending',
      factors,
    });
  }
  return out;
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
  for (const table of ['rfactor_v2_snapshots', 'rfactor_v2_option_snapshots', 'rfactor_v2_bucket_owner']) {
    deleted += await prisma.$executeRawUnsafe(
      `DELETE FROM ${table} WHERE date NOT IN (
         SELECT DISTINCT date FROM ${table} ORDER BY date DESC LIMIT ${RFACTOR_V2_RETENTION_SESSIONS}
       )`,
    );
  }
  return deleted;
}
