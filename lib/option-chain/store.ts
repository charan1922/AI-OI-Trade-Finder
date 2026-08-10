/**
 * Persistence for the Dhan option-chain evidence.
 *
 * Extracted from lib/r-factor-v2/store.ts when the R-Factor V2 scoring
 * experiment was deleted (2026-08-11). Only the two option functions came
 * across — the same-clock premium baseline and the snapshot write — because
 * everything else in that file existed to serve a model that never influenced a
 * decision.
 *
 * TABLE: `option_chain_snapshots`, replacing `rfactor_v2_option_snapshots`. The
 * rename is not cosmetic: the operator asked for nothing named after the retired
 * experiment to remain (2026-08-11). scripts/migrate-option-chain-table.ts
 * copies the retained history across before the old tables are dropped, so the
 * sessions of evidence already collected are not thrown away — they are the only
 * material a future re-run of scripts/measure-option-evidence.ts has, and Dhan
 * publishes no historical option chain to re-fetch them from.
 *
 * Follows the repo's derived-table convention (see lib/signals/oi-intraday.ts):
 * raw CREATE TABLE IF NOT EXISTS so it works without a migration, mirrored by a
 * model in schema.prisma so `db push` keeps it.
 */
import { prisma } from '@/lib/db';

import { OPTION_EVIDENCE_VERSION } from './evidence';
import type { OptionActivityEvidence } from './types';

/** Sessions of evidence to retain, matching the candle/rank retention. */
export const OPTION_CHAIN_RETENTION_SESSIONS = 20;

/** Minimum prior sessions before a same-clock OPTION premium baseline is trusted. */
const MIN_SESSIONS_FOR_OPTION_BASELINE = 3;

let tableReady = false;

export async function ensureOptionChainTable(): Promise<void> {
  if (tableReady) return;
  // Declared in full here — unlike the table this replaces, which accreted its
  // later columns through ALTER statements, this one starts complete.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS option_chain_snapshots (
      date                  TEXT    NOT NULL,
      bucketTs              INTEGER NOT NULL,
      symbol                TEXT    NOT NULL,
      capturedAt            TEXT    NOT NULL,
      expiry                TEXT    NOT NULL,
      activityScore         REAL    NOT NULL,
      direction             TEXT    NOT NULL,
      directionScore        REAL    NOT NULL,
      directionConfidence   REAL    NOT NULL,
      premiumValue          REAL    NOT NULL DEFAULT 0,
      optionVolume          REAL    NOT NULL DEFAULT 0,
      paceBaselineKind      TEXT    NOT NULL DEFAULT 'missing',
      optionEvidenceVersion TEXT    NOT NULL DEFAULT 'unknown',
      evidence              TEXT    NOT NULL,
      PRIMARY KEY (date, bucketTs, symbol)
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_option_chain_latest ON option_chain_snapshots (date, symbol, bucketTs DESC)`,
  );
  tableReady = true;
}

/** IST minute-of-day. The offset is fixed (+05:30, no DST), so this is arithmetic. */
export function istMinuteOfDay(nowMs: number): number {
  const istSeconds = nowMs / 1000 + 5.5 * 3600;
  return Math.floor((((istSeconds % 86400) + 86400) % 86400) / 60);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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
  await ensureOptionChainTable();
  const targetMinute = istMinuteOfDay(nowMs);
  try {
    // Scoped to the CURRENT option-evidence definition as well as the expiry.
    // oe2 redefined premiumValue from LTP x volume to VWAP x volume, so an older
    // row is a different measurement — normalising against it would produce a
    // pace that is wrong in a way nothing downstream could detect. Legacy rows
    // default to 'unknown' and therefore never qualify.
    const rows = await prisma.$queryRawUnsafe<{ premiumValue: number }[]>(
      `WITH ranked AS (
         SELECT date, premiumValue,
                ROW_NUMBER() OVER (
                  PARTITION BY date
                  ORDER BY ABS(CAST((((bucketTs + 19800) % 86400) / 60) AS INTEGER) - ?)
                ) AS rn,
                ABS(CAST((((bucketTs + 19800) % 86400) / 60) AS INTEGER) - ?) AS minuteGap
           FROM option_chain_snapshots
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

/** Persist one underlying's chain read for this minute. Idempotent per bucket. */
export async function recordOptionEvidence(symbol: string, evidence: OptionActivityEvidence): Promise<void> {
  await ensureOptionChainTable();
  const capturedMs = Date.parse(evidence.capturedAt);
  const date = new Date(capturedMs + 5.5 * 3600_000).toISOString().slice(0, 10);
  const bucketTs = Math.floor(capturedMs / 60_000) * 60;
  await prisma.$executeRawUnsafe(
    `INSERT INTO option_chain_snapshots
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

/** Trim to OPTION_CHAIN_RETENTION_SESSIONS distinct dates. Returns rows removed. */
export async function pruneOptionChainSnapshots(): Promise<number> {
  await ensureOptionChainTable();
  return prisma.$executeRawUnsafe(
    `DELETE FROM option_chain_snapshots
      WHERE date NOT IN (
        SELECT date FROM (SELECT DISTINCT date FROM option_chain_snapshots ORDER BY date DESC LIMIT ?)
      )`,
    OPTION_CHAIN_RETENTION_SESSIONS,
  );
}
