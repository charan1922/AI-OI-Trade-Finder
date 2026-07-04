/**
 * Post-market fallback for /api/live/quote — the last recorded state of each
 * symbol from the most recent session, so /live keeps showing TODAY's numbers
 * after the close (until the next session's live feed takes over).
 *
 * Every value is REAL and recorded: the final oi_intraday snapshot of the day
 * (LTP, futures OI, OI level, turnover, change-from-open, spread%, imbalance —
 * all captured while the market was open), the day's OI-urgency derived from
 * the full recorded series, and day high/low from the Fyers 5-min bars (same-
 * day only; the Fyers store clears at the next session). R-Factor is
 * recomputed from those persisted inputs; the bid/ask ladder no longer exists
 * after close, so bid/ask are null and the spread factor simply reports
 * unavailable (never synthesized). `hasDepth:false` marks every snapshot row.
 */

import type { LiveUrgencyRow } from '@/app/live/_lib/types';
import { todayIST } from '@/lib/dhan/market-feed';
import { getFyersCandles } from '@/lib/fyers/candle-store';
import { computeRFactor } from '@/lib/r-factor';
import {
  computeOiUrgency,
  getIntradaySeriesForSymbols,
  getLatestSnapshotDate,
} from '@/lib/signals/oi-intraday';
import { classifyFno, excludeReasonLabel, loadFnoUniverse } from './fno-universe';
import { getMorningContext } from './morning-candles';
import { buildLiveRFactorInput } from './rfactor-inputs';
import { loadRFactorBaselines } from './rfactor-baselines';

export interface ClosingSnapshotResponse {
  success: true;
  marketOpen: false;
  /** Marks these rows as the persisted end-of-session state, not live depth. */
  snapshot: true;
  snapshotDate: string;
  asOf?: string;
  date: string;
  rows: LiveUrgencyRow[];
  symbols: string[];
  excluded: { symbol: string; reason: string }[];
}

/** 15:30 IST on `date` — the session close, used as the R-Factor clock. */
function sessionCloseUtc(date: string): Date {
  return new Date(`${date}T10:00:00.000Z`);
}

export async function buildClosingSnapshot(symbols: string[]): Promise<ClosingSnapshotResponse | null> {
  const snapshotDate = await getLatestSnapshotDate();
  if (!snapshotDate) return null;

  // Same F&O gating as the live path — the page must never widen off-hours.
  const fno = await loadFnoUniverse(symbols);
  const excluded: { symbol: string; reason: string }[] = [];
  const allowed: string[] = [];
  for (const s of symbols) {
    const cls = classifyFno(fno.get(s));
    if (cls.ok) allowed.push(s);
    else excluded.push({ symbol: s, reason: excludeReasonLabel(cls.reason ?? 'not-fno') });
  }
  if (allowed.length === 0) return null;

  const [seriesMap, baselines] = await Promise.all([
    getIntradaySeriesForSymbols(snapshotDate, allowed),
    loadRFactorBaselines(allowed),
  ]);

  const isToday = snapshotDate === todayIST();
  const closeClock = sessionCloseUtc(snapshotDate);
  const rows: LiveUrgencyRow[] = [];

  for (const s of allowed) {
    const series = seriesMap.get(s) ?? [];
    const last = series[series.length - 1];
    if (!last || last.ltp <= 0) continue; // nothing recorded for this name — skip, don't invent

    // Day high/low from the recorded 5-min bars — same-day only (Fyers store
    // clears at the next session's first poll).
    let dayHigh: number | null = null;
    let dayLow: number | null = null;
    if (isToday) {
      const bars = (await getFyersCandles(s, snapshotDate, 'EQ')).filter((b) => b.high > 0);
      if (bars.length > 0) {
        dayHigh = Math.max(...bars.map((b) => b.high));
        dayLow = Math.min(...bars.map((b) => b.low));
      }
    }

    const urgency = computeOiUrgency(series);
    const base = baselines.get(s);
    const rf = buildLiveRFactorInput(
      {
        symbol: s,
        ltp: last.ltp,
        changePctOpen: last.changePctOpen,
        bid: null, // the order book no longer exists — never synthesized
        ask: null,
        futOi: last.futOi > 0 ? last.futOi : null,
        turnover: last.futTurnover > 0 ? last.futTurnover : null,
        dayHigh,
        dayLow,
      },
      base,
      isToday ? getMorningContext(s) : null,
      closeClock,
    );
    const r = rf ? computeRFactor(rf) : null;

    rows.push({
      symbol: s,
      ltp: last.ltp,
      changePctOpen: last.changePctOpen,
      bid: null,
      ask: null,
      spreadPct: last.spreadPct,
      imbalance: last.imbalance,
      futOi: last.futOi > 0 ? last.futOi : null,
      oiLevel: last.oiLevel > 0 ? last.oiLevel : null,
      turnover: last.futTurnover > 0 ? last.futTurnover : null,
      hasDepth: false,
      sessionOiChangePct: urgency.ok ? urgency.sessionOiChangePct : null,
      oiVelocity: urgency.ok ? urgency.oiVelocity : null,
      oiAccel: urgency.ok ? urgency.oiAccel : null,
      oiUrgency: urgency.ok ? urgency.urgencyScore : null,
      rFactor: r?.rFactor ?? null,
      rFactorBias: r?.bias ?? null,
      rFactorConfidence: r?.confidence ?? null,
      rFactorAfterEntry: r?.afterEntryWindow ?? null,
      rFactors:
        r?.factors.map((f) => ({
          label: f.label,
          score: f.score,
          vote: f.vote,
          available: f.available,
          detail: f.detail,
        })) ?? null,
    });
  }

  if (rows.length === 0) return null;

  // Latest capture time across the returned rows (bucketTs is epoch seconds).
  const lastTs = Math.max(...allowed.map((s) => seriesMap.get(s)?.[seriesMap.get(s)!.length - 1]?.bucketTs ?? 0));

  return {
    success: true,
    marketOpen: false,
    snapshot: true,
    snapshotDate,
    asOf: lastTs > 0 ? new Date(lastTs * 1000).toISOString() : undefined,
    date: snapshotDate,
    rows,
    symbols: allowed,
    excluded,
  };
}
