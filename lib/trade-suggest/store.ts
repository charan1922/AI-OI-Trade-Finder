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
import {
  type ProtectAggregate,
  type ProtectAggRow,
  aggregateProtection,
  parseProtectBlob,
} from '@/lib/trade-suggest/profit-protect';
import type { StoredSuggestion, TradeSuggestion } from '@/lib/trade-suggest/types';

let tableReady = false;

/** All persisted spot-grade labels (grade.ts). */
const SPOT_OUTCOMES = new Set(['target', 'stop', 'timeout', 'entry-ambiguous', 'incomplete']);
/** RESOLVED = honestly gradeable (carries an R); the other two are unresolvable
 *  and are excluded from the win-rate / expectancy (PR#3 review). */
const RESOLVED_OUTCOMES = new Set(['target', 'stop', 'timeout']);
const isResolved = (o: unknown): boolean => typeof o === 'string' && RESOLVED_OUTCOMES.has(o);

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
  // Honest path-dependent grade (grade.ts) — added to the EXISTING table via
  // ALTER (CREATE IF NOT EXISTS never adds columns to a table that already
  // exists in prod). Mirrored in schema.prisma.
  const cols = new Set(
    ((await prisma.$queryRawUnsafe(`PRAGMA table_info(trade_suggestions)`)) as { name: string }[]).map((c) => c.name),
  );
  // protectShadow: JSON blob of profit-protection counterfactual R per rule
  // (profit-protect.ts), computed same-day while candles exist — MEASUREMENT
  // ONLY, never changes a live exit. Nullable; legacy rows stay null.
  for (const col of ['spotOutcome TEXT', 'spotOutcomeR REAL', 'protectShadow TEXT']) {
    if (!cols.has(col.split(' ')[0])) await prisma.$executeRawUnsafe(`ALTER TABLE trade_suggestions ADD COLUMN ${col}`);
  }
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

/** One DB row → the typed StoredSuggestion (shared by single-day and history reads). */
function rowToStored(r: Record<string, unknown>): StoredSuggestion {
  return {
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
    spotOutcome: SPOT_OUTCOMES.has(r.spotOutcome as string) ? (r.spotOutcome as StoredSuggestion['spotOutcome']) : null,
    spotOutcomeR: toNumOrNull(r.spotOutcomeR),
    protectShadow: r.protectShadow == null ? null : String(r.protectShadow),
    outcomeAt: r.outcomeAt == null ? null : String(r.outcomeAt),
  };
}

export async function getSuggestions(date: string): Promise<StoredSuggestion[]> {
  await ensureSuggestionsTable();
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT * FROM trade_suggestions WHERE date = ? ORDER BY suggestedAt ASC, rank ASC`,
    date,
  );
  return rows.map(rowToStored);
}

/** One trading day's worth of persisted suggestions, newest day first. */
export interface SuggestionDay {
  date: string;
  suggestions: StoredSuggestion[];
  /** Rows whose EOD scorecard has run (outcomeAt set). */
  reviewed: number;
  /** Reviewed rows that moved ≥1% in the suggested direction (CE up / PE down). */
  hits: number;
}

/**
 * Full daywise history over the trailing `days` window — every persisted
 * suggestion grouped by trading day (newest first), each day carrying a
 * reviewed/hit tally. Backs the Trade Log page. Rows persist across days
 * (only the intraday candle store clears), so this is the durable record.
 */
export async function getSuggestionHistory(days = 30): Promise<SuggestionDay[]> {
  await ensureSuggestionsTable();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT * FROM trade_suggestions WHERE date >= ? ORDER BY date DESC, suggestedAt ASC, rank ASC`,
    since,
  );
  const byDay = new Map<string, StoredSuggestion[]>();
  for (const raw of rows) {
    const s = rowToStored(raw);
    const arr = byDay.get(s.date) ?? [];
    arr.push(s);
    byDay.set(s.date, arr);
  }
  const isHit = (s: StoredSuggestion) => {
    if (s.outcomeAt == null) return false;
    // Honest grade when present: a win is TARGET-before-stop, not just any ≥1%
    // spike (a stop-then-recover trade is a loss). Legacy rows (no spotOutcome)
    // fall back to the old maxUp-based test.
    if (s.spotOutcome != null) return s.spotOutcome === 'target';
    const favorable = s.optionType === 'PE' ? -(s.maxDownPct ?? 0) : (s.maxUpPct ?? 0);
    return favorable >= 1;
  };
  return [...byDay.entries()].map(([date, suggestions]) => ({
    date,
    suggestions,
    reviewed: suggestions.filter((s) => s.outcomeAt != null).length,
    hits: suggestions.filter(isHit).length,
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
  /** All rows with an EOD outcome recorded (honest + legacy + unresolvable). */
  reviewed: number;
  // ── HONEST calibration window: path-graded RESOLVED rows only (target /
  //    stop / timeout). THESE are the numbers to tune strategy on — legacy and
  //    unresolvable rows are reported separately and never mixed in (PR#3 review).
  /** Resolved, path-graded rows — the denominator for every honest figure below. */
  honestReviewed: number;
  /** A "hit" = the plan's TARGET was reached BEFORE its stop (honest rows only). */
  hits: number;
  hitRatePct: number | null;
  /** Mean realised R over honest rows (stop −1, target +RR, timeout close-based). */
  avgOutcomeR: number | null;
  avgFavorablePct: number | null;
  avgAdversePct: number | null;
  // ── Excluded from the honest window ──
  /** Entry-ambiguous + incomplete rows (5-min blind spots — not counted). */
  unresolvable: number;
  /** Old rows graded before grade.ts (maxUp-only) — NOT trustworthy for tuning. */
  legacyReviewed: number;
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
    `SELECT optionType, score, rank, maxUpPct, maxDownPct, closePct, spotOutcome, spotOutcomeR, outcomeAt
       FROM trade_suggestions WHERE date >= ?`,
    since,
  );

  const reviewedRows = rows.filter((r) => r.outcomeAt != null);
  // The HONEST window: only path-graded, RESOLVED rows drive the calibration
  // numbers. Legacy rows (no spotOutcome) and unresolvable rows (entry-ambiguous
  // / incomplete) are counted separately, NEVER mixed into hitRate (PR#3 review).
  const honestRows = reviewedRows.filter((r) => isResolved(r.spotOutcome));
  const legacyReviewed = reviewedRows.filter((r) => r.spotOutcome == null).length;
  const unresolvable = reviewedRows.filter((r) => r.spotOutcome != null && !isResolved(r.spotOutcome)).length;

  const favorable = (r: Record<string, unknown>) =>
    r.optionType === 'PE' ? -Number(r.maxDownPct ?? 0) : Number(r.maxUpPct ?? 0);
  const adverse = (r: Record<string, unknown>) =>
    r.optionType === 'PE' ? Number(r.maxUpPct ?? 0) : -Number(r.maxDownPct ?? 0);
  const isHit = (r: Record<string, unknown>) => r.spotOutcome === 'target';

  const byRank = new Map<number, { n: number; hits: number }>();
  const byBucket = new Map<string, { n: number; hits: number }>();
  for (const r of honestRows) {
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

  const hits = honestRows.filter(isHit).length;
  const avg = (vals: number[]) =>
    vals.length === 0 ? null : Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
  // Filter nulls BEFORE Number() — `Number(null)` is 0 (finite), which would
  // sneak a null R into the mean as a spurious 0 (PR#4 review). Resolved rows
  // always carry an R today, but this keeps avgOutcomeR honest if that changes.
  const gradedR = honestRows
    .filter((r) => r.spotOutcomeR != null)
    .map((r) => Number(r.spotOutcomeR))
    .filter((n) => Number.isFinite(n));

  return {
    days,
    totalSuggestions: rows.length,
    reviewed: reviewedRows.length,
    honestReviewed: honestRows.length,
    hits,
    hitRatePct: honestRows.length === 0 ? null : Math.round((hits / honestRows.length) * 10000) / 100,
    avgOutcomeR: avg(gradedR),
    avgFavorablePct: avg(honestRows.map(favorable)),
    avgAdversePct: avg(honestRows.map(adverse)),
    unresolvable,
    legacyReviewed,
    byRank: [...byRank.entries()].sort((a, b) => a[0] - b[0]).map(([rank, v]) => ({ rank, ...v })),
    byScoreBucket: [...byBucket.entries()].map(([bucket, v]) => ({ bucket, ...v })),
  };
}

export interface ProtectionStats extends ProtectAggregate {
  days: number;
}

/**
 * Profit-protection SHADOW calibration (profit-protect.ts). Loads the resolved,
 * path-graded rows that carry a counterfactual blob and hands them to the PURE
 * aggregator (aggregateProtection) which compares each candidate rule's mean R
 * against the fixed-plan baseline over the SAME paired rows. Evidence to decide
 * whether a "move stop up once in profit" rule earns its place LIVE — never
 * applied automatically. Rows are scarce until several sessions accrue.
 */
export async function getProtectionStats(days = 30): Promise<ProtectionStats> {
  await ensureSuggestionsTable();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT spotOutcome, spotOutcomeR, protectShadow FROM trade_suggestions
       WHERE date >= ? AND outcomeAt IS NOT NULL AND protectShadow IS NOT NULL`,
    since,
  );
  // Only rows whose BASELINE is honestly resolved contribute — the counterfactual
  // must be compared like-for-like against a real baseline R.
  const aggRows: ProtectAggRow[] = rows
    .filter((r) => isResolved(r.spotOutcome) && r.spotOutcomeR != null)
    .map((r) => ({ baseR: Number(r.spotOutcomeR), blob: parseProtectBlob(r.protectShadow) }));
  return { days, ...aggregateProtection(aggRows) };
}

/** Fill outcome columns for one suggestion (same-day scorecard). spotOutcome /
 *  spotOutcomeR are the honest path-dependent grade (grade.ts); null when the
 *  plan lacked well-formed stop/target levels to grade against. protectShadow is
 *  the profit-protection counterfactual blob (profit-protect.ts).
 *
 *  IDEMPOTENT re-grade safe: `outcomeAt` is set only on the FIRST grading via
 *  COALESCE — a later regrade (scripts/regrade-suggestions.ts, applying a grader
 *  fix to retained history) refreshes the grade + shadow but PRESERVES the
 *  original grading time, which the history UI shows as "Exit" (PR#5 review #5).
 *  The grade/shadow columns always overwrite, so fixes do take effect. */
export async function recordOutcome(
  date: string,
  symbol: string,
  optionType: string,
  outcome: {
    maxUpPct: number;
    maxDownPct: number;
    closePct: number;
    spotOutcome?: StoredSuggestion['spotOutcome'];
    spotOutcomeR?: number | null;
    /** JSON blob of profit-protection counterfactual R per rule (profit-protect.ts).
     *  Null when the baseline was unresolvable. */
    protectShadow?: string | null;
  },
  nowMs = Date.now(),
): Promise<void> {
  await ensureSuggestionsTable();
  await prisma.$executeRawUnsafe(
    `UPDATE trade_suggestions
        SET maxUpPct = ?, maxDownPct = ?, closePct = ?, spotOutcome = ?, spotOutcomeR = ?, protectShadow = ?,
            outcomeAt = COALESCE(outcomeAt, ?)
      WHERE date = ? AND symbol = ? AND optionType = ?`,
    outcome.maxUpPct,
    outcome.maxDownPct,
    outcome.closePct,
    outcome.spotOutcome ?? null,
    outcome.spotOutcomeR ?? null,
    outcome.protectShadow ?? null,
    new Date(nowMs).toISOString(),
    date,
    symbol,
    optionType,
  );
}
