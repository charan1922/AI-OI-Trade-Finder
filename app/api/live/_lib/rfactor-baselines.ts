/**
 * Bhavcopy baselines for the Live Urgency R-Factor.
 *
 * A live quote is just "now" — the R-Factor needs what "now" is being compared
 * against: 20-session averages (OI, turnover, volume), the previous session's OI,
 * and prior-day high/low/close (the breakout reference and the change-vs-prev-close
 * basis). All of that is EOD data, read once from `bhavcopy_days`.
 *
 * This supersedes the quote route's inline `futOiAverages` (which computed only the
 * 20-day OI average for the OI-Level column) with the full baseline set.
 */

import { prisma } from '@/lib/db';

export interface RFactorBaseline {
  /** Previous session's futures OI (most recent bhavcopy row). */
  futOiPrev: number | null;
  futOi20dAvg: number | null;
  futTurnover20dAvg: number | null;
  futVolume20dAvg: number | null;
  /** Prior-session equity high/low/close — breakout reference + prev-close basis. */
  priorDayHigh: number | null;
  priorDayLow: number | null;
  priorDayClose: number | null;
  /** 20-day average of (eqHigh−eqLow)/eqClose — the range-expansion baseline. */
  rangeSpread20dAvg: number | null;
  /** Multi-day extremes (5/20 sessions) — the TF breakout detector's base levels. */
  high5d: number | null;
  low5d: number | null;
  high20d: number | null;
  low20d: number | null;
}

interface BhavRow {
  symbol: string;
  date: string;
  futOi: number | null;
  futTurnover: number | null;
  futVolume: number | null;
  eqHigh: number | null;
  eqLow: number | null;
  eqClose: number | null;
}

const WINDOW = 20;
const MIN_POINTS = 5; // fewer than this and an average is too noisy to trust

/** Mean of the newest ≤20 positive values; null if fewer than MIN_POINTS. */
function avg(values: number[]): number | null {
  const xs = values.filter((v) => v > 0).slice(0, WINDOW);
  return xs.length >= MIN_POINTS ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Extreme of the newest ≤n positive values; null when none. */
function extreme(values: number[], n: number, mode: 'max' | 'min'): number | null {
  const xs = values.filter((v) => v > 0).slice(0, n);
  if (xs.length === 0) return null;
  return mode === 'max' ? Math.max(...xs) : Math.min(...xs);
}

const pos = (v: number | null | undefined): number | null => (v != null && Number(v) > 0 ? Number(v) : null);

/**
 * Load per-symbol bhavcopy baselines (one query, newest sessions first).
 *
 * `beforeDate` (YYYY-MM-DD): only use sessions strictly BEFORE this date. The
 * closing snapshot passes its own session date here — without it, once that
 * day's bhavcopy syncs overnight the "previous session" becomes the displayed
 * day ITSELF: price change collapses to ~0 (bias neutral), OI change compares
 * Dhan-live OI against NSE-official OI (different measurement conventions —
 * fake double-digit moves), and breakout levels become the day's own range.
 * Caught 2026-07-12 (KALYANKJIL: frozen close 4.71-buy shown as 4.3-neutral).
 * The live path omits it — today's bhavcopy never exists during market hours.
 */
export async function loadRFactorBaselines(symbols: string[], beforeDate?: string): Promise<Map<string, RFactorBaseline>> {
  const out = new Map<string, RFactorBaseline>();
  if (symbols.length === 0) return out;
  try {
    const placeholders = symbols.map(() => '?').join(',');
    const dateClause = beforeDate ? 'AND date < ?' : '';
    const params: unknown[] = beforeDate ? [...symbols, beforeDate] : [...symbols];
    const rows = await prisma.$queryRawUnsafe<BhavRow[]>(
      `SELECT symbol, date, futOi, futTurnover, futVolume, eqHigh, eqLow, eqClose
         FROM bhavcopy_days WHERE symbol IN (${placeholders}) ${dateClause} ORDER BY symbol, date DESC`,
      ...params,
    );

    const bySymbol = new Map<string, BhavRow[]>();
    for (const r of rows) {
      const arr = bySymbol.get(r.symbol) ?? [];
      arr.push(r);
      bySymbol.set(r.symbol, arr);
    }

    for (const [symbol, rs] of bySymbol) {
      // rs[0] = most recent session = the "previous session" relative to live
      // today (today's bhavcopy isn't synced during market hours, when this runs).
      const prev = rs[0];
      // (H-L)/close per session, for the 20-day range-expansion baseline.
      const rangeRatios = rs.map((r) => {
        const c = Number(r.eqClose ?? 0);
        const h = Number(r.eqHigh ?? 0);
        const l = Number(r.eqLow ?? 0);
        return c > 0 && h >= l && h > 0 ? (h - l) / c : 0;
      });
      const highs = rs.map((r) => Number(r.eqHigh ?? 0));
      const lows = rs.map((r) => Number(r.eqLow ?? 0));
      out.set(symbol, {
        futOiPrev: pos(prev?.futOi),
        futOi20dAvg: avg(rs.map((r) => Number(r.futOi ?? 0))),
        futTurnover20dAvg: avg(rs.map((r) => Number(r.futTurnover ?? 0))),
        futVolume20dAvg: avg(rs.map((r) => Number(r.futVolume ?? 0))),
        priorDayHigh: pos(prev?.eqHigh),
        priorDayLow: pos(prev?.eqLow),
        priorDayClose: pos(prev?.eqClose),
        rangeSpread20dAvg: avg(rangeRatios),
        high5d: extreme(highs, 5, 'max'),
        low5d: extreme(lows, 5, 'min'),
        high20d: extreme(highs, WINDOW, 'max'),
        low20d: extreme(lows, WINDOW, 'min'),
      });
    }
  } catch {
    // bhavcopy absent — baselines won't resolve and the R-Factor degrades gracefully.
  }
  return out;
}
