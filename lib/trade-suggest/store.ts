/**
 * trade_suggestions — persisted /trade-suggest calls, so the daily hit-rate is
 * auditable. Repo derived-table convention (see lib/signals/oi-intraday.ts):
 * lazy CREATE TABLE IF NOT EXISTS + mirrored TradeSuggestion model in
 * schema.prisma so `db push` keeps it.
 *
 * PK (date, symbol, optionType): a re-suggested name updates lastSeenAt /
 * timesSeen / latest signal readings but keeps the ORIGINAL suggestedAt and
 * spotAtSuggest — the first call is what gets scored, no goalpost-moving.
 * Outcome columns are filled same-day by review.ts (fyers_candles clears at
 * day change, so the scorecard must run before the next session).
 */

import { prisma } from '@/lib/db';
import type { StoredSuggestion, TradeSuggestion } from '@/lib/trade-suggest/types';

let tableReady = false;

export async function ensureSuggestionsTable(): Promise<void> {
  if (tableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS trade_suggestions (
      date          TEXT    NOT NULL,
      symbol        TEXT    NOT NULL,
      optionType    TEXT    NOT NULL,
      strike        REAL    DEFAULT 0,
      expiryDate    TEXT    DEFAULT '',
      spotAtSuggest REAL    DEFAULT 0,
      slSpot        REAL,
      targetSpot    REAL,
      lotSize       INTEGER DEFAULT 0,
      optSecurityId TEXT    DEFAULT '',
      sector        TEXT    DEFAULT '',
      rFactor       REAL    DEFAULT 0,
      confidence    REAL    DEFAULT 0,
      oiLevel       REAL    DEFAULT 0,
      oiUrgency     REAL,
      score         REAL    DEFAULT 0,
      rank          INTEGER DEFAULT 0,
      reasons       TEXT    DEFAULT '[]',
      premiumAtSuggest REAL,
      premiumSl        REAL,
      premiumTarget    REAL,
      suggestedAt   TEXT    NOT NULL,
      lastSeenAt    TEXT    NOT NULL,
      timesSeen     INTEGER DEFAULT 1,
      maxUpPct      REAL,
      maxDownPct    REAL,
      closePct      REAL,
      outcomeAt     TEXT,
      PRIMARY KEY (date, symbol, optionType)
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_trade_suggestions_date ON trade_suggestions (date)`);
  tableReady = true;
}

/** Persist this run's picks. First sighting wins for suggestedAt/spotAtSuggest. */
export async function upsertSuggestions(date: string, picks: TradeSuggestion[], nowMs = Date.now()): Promise<void> {
  if (picks.length === 0) return;
  await ensureSuggestionsTable();
  const at = new Date(nowMs).toISOString();
  for (const p of picks) {
    if (!p.option) continue; // only persist fully-resolved contracts
    await prisma.$executeRawUnsafe(
      `INSERT INTO trade_suggestions
         (date, symbol, optionType, strike, expiryDate, spotAtSuggest, slSpot, targetSpot, lotSize,
          optSecurityId, sector, rFactor, confidence, oiLevel, oiUrgency, score, rank, reasons,
          premiumAtSuggest, premiumSl, premiumTarget, suggestedAt, lastSeenAt, timesSeen)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
       ON CONFLICT(date, symbol, optionType) DO UPDATE SET
         lastSeenAt = excluded.lastSeenAt,
         timesSeen = timesSeen + 1,
         rFactor = excluded.rFactor,
         confidence = excluded.confidence,
         oiLevel = excluded.oiLevel,
         oiUrgency = excluded.oiUrgency,
         score = excluded.score,
         rank = excluded.rank,
         reasons = excluded.reasons`,
      date,
      p.symbol,
      p.option.optionType,
      p.option.strike,
      p.option.expiryDate,
      p.plan.entrySpot,
      p.plan.slSpot,
      p.plan.targetSpot,
      p.option.lotSize,
      p.option.optSecurityId,
      p.sector,
      p.rFactor,
      p.rFactorConfidence,
      p.oiLevel,
      p.oiUrgency,
      p.score,
      p.rank,
      JSON.stringify(p.reasons),
      p.option.premium?.ltp ?? null,
      p.option.premium?.slPremium ?? null,
      p.option.premium?.targetPremium ?? null,
      at,
      at,
    );
  }
}

const toNum = (v: unknown): number => Number(v ?? 0);
const toNumOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

export async function getSuggestions(date: string): Promise<StoredSuggestion[]> {
  await ensureSuggestionsTable();
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT * FROM trade_suggestions WHERE date = ? ORDER BY suggestedAt ASC, rank ASC`,
    date,
  );
  return rows.map((r) => ({
    date: String(r.date),
    symbol: String(r.symbol),
    optionType: r.optionType === 'PE' ? 'PE' : 'CE',
    strike: toNum(r.strike),
    expiryDate: String(r.expiryDate ?? ''),
    spotAtSuggest: toNum(r.spotAtSuggest),
    slSpot: toNumOrNull(r.slSpot),
    targetSpot: toNumOrNull(r.targetSpot),
    lotSize: toNum(r.lotSize),
    optSecurityId: String(r.optSecurityId ?? ''),
    sector: String(r.sector ?? ''),
    rFactor: toNum(r.rFactor),
    confidence: toNum(r.confidence),
    oiLevel: toNum(r.oiLevel),
    oiUrgency: toNumOrNull(r.oiUrgency),
    score: toNum(r.score),
    rank: toNum(r.rank),
    reasons: safeParseReasons(r.reasons),
    premiumAtSuggest: toNumOrNull(r.premiumAtSuggest),
    premiumSl: toNumOrNull(r.premiumSl),
    premiumTarget: toNumOrNull(r.premiumTarget),
    suggestedAt: String(r.suggestedAt),
    lastSeenAt: String(r.lastSeenAt),
    timesSeen: toNum(r.timesSeen),
    maxUpPct: toNumOrNull(r.maxUpPct),
    maxDownPct: toNumOrNull(r.maxDownPct),
    closePct: toNumOrNull(r.closePct),
    outcomeAt: r.outcomeAt == null ? null : String(r.outcomeAt),
  }));
}

function safeParseReasons(v: unknown): string[] {
  try {
    const parsed = JSON.parse(String(v ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export interface SuggestStats {
  days: number;
  totalSuggestions: number;
  reviewed: number;
  /** A "hit" = moved ≥1% in the suggested direction before close (CE up / PE down). */
  hits: number;
  hitRatePct: number | null;
  avgFavorablePct: number | null;
  avgAdversePct: number | null;
  byRank: { rank: number; n: number; hits: number }[];
  byScoreBucket: { bucket: string; n: number; hits: number }[];
}

/**
 * Cross-day calibration stats over all reviewed suggestions (rows persist
 * across days even though the candle store doesn't). Feeds the weekly
 * threshold tune-up described in the skill's strategy reference.
 */
export async function getStats(days = 30): Promise<SuggestStats> {
  await ensureSuggestionsTable();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT optionType, score, rank, maxUpPct, maxDownPct, closePct, outcomeAt
       FROM trade_suggestions WHERE date >= ?`,
    since,
  );

  const reviewedRows = rows.filter((r) => r.outcomeAt != null);
  const favorable = (r: Record<string, unknown>) =>
    r.optionType === 'PE' ? -Number(r.maxDownPct ?? 0) : Number(r.maxUpPct ?? 0);
  const adverse = (r: Record<string, unknown>) =>
    r.optionType === 'PE' ? Number(r.maxUpPct ?? 0) : -Number(r.maxDownPct ?? 0);
  const isHit = (r: Record<string, unknown>) => favorable(r) >= 1;

  const byRank = new Map<number, { n: number; hits: number }>();
  const byBucket = new Map<string, { n: number; hits: number }>();
  for (const r of reviewedRows) {
    const rank = toNum(r.rank);
    const bucket = toNum(r.score) >= 0.55 ? '≥0.55' : toNum(r.score) >= 0.45 ? '0.45–0.55' : '<0.45';
    const br = byRank.get(rank) ?? { n: 0, hits: 0 };
    br.n++;
    if (isHit(r)) br.hits++;
    byRank.set(rank, br);
    const bb = byBucket.get(bucket) ?? { n: 0, hits: 0 };
    bb.n++;
    if (isHit(r)) bb.hits++;
    byBucket.set(bucket, bb);
  }

  const hits = reviewedRows.filter(isHit).length;
  const avg = (vals: number[]) =>
    vals.length === 0 ? null : Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;

  return {
    days,
    totalSuggestions: rows.length,
    reviewed: reviewedRows.length,
    hits,
    hitRatePct: reviewedRows.length === 0 ? null : Math.round((hits / reviewedRows.length) * 10000) / 100,
    avgFavorablePct: avg(reviewedRows.map(favorable)),
    avgAdversePct: avg(reviewedRows.map(adverse)),
    byRank: [...byRank.entries()].sort((a, b) => a[0] - b[0]).map(([rank, v]) => ({ rank, ...v })),
    byScoreBucket: [...byBucket.entries()].map(([bucket, v]) => ({ bucket, ...v })),
  };
}

/** Fill outcome columns for one suggestion (same-day scorecard). */
export async function recordOutcome(
  date: string,
  symbol: string,
  optionType: string,
  outcome: { maxUpPct: number; maxDownPct: number; closePct: number },
  nowMs = Date.now(),
): Promise<void> {
  await ensureSuggestionsTable();
  await prisma.$executeRawUnsafe(
    `UPDATE trade_suggestions SET maxUpPct = ?, maxDownPct = ?, closePct = ?, outcomeAt = ?
     WHERE date = ? AND symbol = ? AND optionType = ?`,
    outcome.maxUpPct,
    outcome.maxDownPct,
    outcome.closePct,
    new Date(nowMs).toISOString(),
    date,
    symbol,
    optionType,
  );
}
