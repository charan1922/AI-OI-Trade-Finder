/**
 * EOD TF-style R-Factor leaderboard — ported from the parent repo's best-
 * validated model (lib/r-factor/ensemble.ts predictSpreadQuadratic, which is
 * in fact spread-LINEAR: R = max(1, 1.5596 × spread_ratio); cross-validated
 * Pearson 0.80, 7.5/10 top-10 overlap with TradeFinder on paired days).
 *
 * TF computes its R-Factor once per day from EOD data, so this leaderboard —
 * computed from the synced NSE bhavcopy — is the honest post-market
 * comparator for the live suggester: "what would TF's ranking have said
 * about this session, and where did our in-window picks sit in it?"
 *
 * spread_ratio = ((H−L)/close on the target date) ÷ the average of the same
 * ratio over the prior 20 sessions. All inputs are official bhavcopy rows;
 * symbols without ≥5 baseline sessions are skipped, never guessed.
 */

import { prisma } from '@/lib/db';
import { getSuggestions } from '@/lib/trade-suggest/store';

/** Parent-repo 2-day OLS fit: R ≈ 1.56 × spread_ratio (floor 1.0). */
const SPREAD_LINEAR_COEFF = 1.5596;
const BASELINE_WINDOW = 20;
const MIN_BASELINE_SESSIONS = 5;

export interface EodLeaderboardRow {
  rank: number;
  symbol: string;
  sector: string;
  rFactor: number;
  spreadRatio: number;
  /** Futures turnover ÷ its 20-day average — CONTEXT ONLY, not in the R score
   *  (the parent repo's validation showed turnover terms degrade the TF match). */
  turnoverRatio: number | null;
  /** Close-to-close move on the target date (%). */
  pctChange: number | null;
  close: number;
}

export interface EodLeaderboard {
  date: string;
  rows: EodLeaderboardRow[];
  /** Where that date's persisted suggestions ranked on this leaderboard. */
  suggestionRanks: { symbol: string; optionType: string; rank: number | null }[];
  universe: number;
}

interface BhavRow {
  symbol: string;
  date: string;
  eqHigh: number | null;
  eqLow: number | null;
  eqClose: number | null;
  futTurnover: number | null;
}

export async function computeEodLeaderboard(dateParam?: string, limit = 15): Promise<EodLeaderboard | null> {
  // Target date = requested, else the latest synced bhavcopy session.
  const latest = await prisma.$queryRawUnsafe<{ d: string | null }[]>(
    dateParam
      ? `SELECT MAX(date) AS d FROM bhavcopy_days WHERE date <= '${dateParam.replace(/'/g, "''")}'`
      : `SELECT MAX(date) AS d FROM bhavcopy_days`,
  );
  const date = latest[0]?.d;
  if (!date) return null;

  // Tradeable universe with sectors (same gating as the suggester).
  const universeRows = await prisma.$queryRawUnsafe<{ symbol: string; sector: string }[]>(
    `SELECT symbol, sector FROM fno_stocks WHERE isIndex = 0 AND tradeBand != 'avoid'`,
  );
  const sectorBySymbol = new Map(universeRows.map((r) => [r.symbol, r.sector]));
  const symbols = [...sectorBySymbol.keys()];
  if (symbols.length === 0) return null;

  const placeholders = symbols.map(() => '?').join(',');
  const rows = await prisma.$queryRawUnsafe<BhavRow[]>(
    `SELECT symbol, date, eqHigh, eqLow, eqClose, futTurnover FROM bhavcopy_days
      WHERE symbol IN (${placeholders}) AND date <= ?
      ORDER BY symbol, date DESC`,
    ...symbols,
    date,
  );

  const bySymbol = new Map<string, BhavRow[]>();
  for (const r of rows) {
    const arr = bySymbol.get(r.symbol) ?? [];
    if (arr.length <= BASELINE_WINDOW) arr.push(r); // today + up to 20 baseline + 1 spare
    bySymbol.set(r.symbol, arr);
  }

  const spreadOf = (r: BhavRow): number | null => {
    const h = Number(r.eqHigh ?? 0);
    const l = Number(r.eqLow ?? 0);
    const c = Number(r.eqClose ?? 0);
    return c > 0 && h >= l && h > 0 ? (h - l) / c : null;
  };

  const scored: Omit<EodLeaderboardRow, 'rank'>[] = [];
  for (const [symbol, rs] of bySymbol) {
    if (rs.length < 2 || rs[0].date !== date) continue; // no row for the target session
    const todaySpread = spreadOf(rs[0]);
    if (todaySpread == null) continue;
    const baseline = rs
      .slice(1, 1 + BASELINE_WINDOW)
      .map(spreadOf)
      .filter((v): v is number => v != null && v > 0);
    if (baseline.length < MIN_BASELINE_SESSIONS) continue;
    const avg = baseline.reduce((a, b) => a + b, 0) / baseline.length;
    if (avg <= 0) continue;
    const spreadRatio = todaySpread / avg;
    const rFactor = Math.max(1, SPREAD_LINEAR_COEFF * spreadRatio);
    const prevClose = Number(rs[1]?.eqClose ?? 0);
    const close = Number(rs[0].eqClose ?? 0);
    // Turnover ratio — context column only (never part of the R score).
    const todayTurn = Number(rs[0].futTurnover ?? 0);
    const turnBase = rs
      .slice(1, 1 + BASELINE_WINDOW)
      .map((r) => Number(r.futTurnover ?? 0))
      .filter((v) => v > 0);
    const turnAvg = turnBase.length >= MIN_BASELINE_SESSIONS ? turnBase.reduce((a, b) => a + b, 0) / turnBase.length : 0;
    scored.push({
      symbol,
      sector: sectorBySymbol.get(symbol) ?? '',
      rFactor: Math.round(rFactor * 100) / 100,
      spreadRatio: Math.round(spreadRatio * 100) / 100,
      turnoverRatio: todayTurn > 0 && turnAvg > 0 ? Math.round((todayTurn / turnAvg) * 100) / 100 : null,
      pctChange: prevClose > 0 && close > 0 ? Math.round(((close - prevClose) / prevClose) * 10000) / 100 : null,
      close,
    });
  }

  scored.sort((a, b) => b.rFactor - a.rFactor);
  const ranked = scored.map((r, i) => ({ ...r, rank: i + 1 }));
  const rankBySymbol = new Map(ranked.map((r) => [r.symbol, r.rank]));

  const suggestions = await getSuggestions(date);
  const suggestionRanks = suggestions.map((s) => ({
    symbol: s.symbol,
    optionType: s.optionType,
    rank: rankBySymbol.get(s.symbol) ?? null,
  }));

  return { date, rows: ranked.slice(0, limit), suggestionRanks, universe: scored.length };
}
