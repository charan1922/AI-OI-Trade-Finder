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
 *
 * Also fires a one-time, best-effort permanent capture of the session's board
 * into `live_urgency_eod` (see lib/signals/live-urgency-eod.ts) — the first
 * post-market poll of a new session date freezes EVERY symbol oi_intraday
 * tracked that day (not just the caller's watchlist slice) so /live/history
 * has the full picture regardless of which category section happened to
 * trigger the capture.
 */

import type { LiveUrgencyRow } from '@/app/live/_lib/types';
import { deriveBreakoutContext, evaluateBreakout, type BreakoutSignal } from '@/lib/breakout';
import { prisma } from '@/lib/db';
import { todayIST } from '@/lib/dhan/market-feed';
import { getFyersCandles, getNseOiLatestForSymbols, type NseOiLatest } from '@/lib/fyers/candle-store';
import { computeRFactor } from '@/lib/r-factor';
import { deriveSessionContext } from '@/lib/signals/session-context';
import {
  changeSinceEntryWindow,
  computeOiUrgency,
  getIntradaySeriesForSymbols,
  getLatestSnapshotDate,
} from '@/lib/signals/oi-intraday';
import { type EodRow, getEodForDate, hasEodCapture, insertEodRows } from '@/lib/signals/live-urgency-eod';
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

/**
 * Build the frozen end-of-session rows for `allowed` symbols on `snapshotDate`
 * from the persisted oi_intraday series + Fyers bars + bhavcopy baselines.
 * Shared by the live post-market response (scoped to the caller's watchlist)
 * and the EOD capture (scoped to every symbol tracked that day).
 */
async function computeClosingRows(
  allowed: string[],
  snapshotDate: string,
): Promise<{ rows: EodRow[]; lastTs: number }> {
  // Baselines strictly BEFORE the snapshot date — once this day's bhavcopy
  // syncs overnight, the unbounded query would compare the day against itself
  // (see loadRFactorBaselines). No-op on the session's own evening.
  const [seriesMap, baselines] = await Promise.all([
    getIntradaySeriesForSymbols(snapshotDate, allowed),
    loadRFactorBaselines(allowed, snapshotDate),
  ]);

  const isToday = snapshotDate === todayIST();
  // NSE combined-OI feed values live in fyers_candles, which keeps today only.
  const nseOi: Map<string, NseOiLatest> = isToday
    ? await getNseOiLatestForSymbols(allowed, snapshotDate).catch(() => new Map<string, NseOiLatest>())
    : new Map<string, NseOiLatest>();
  const closeClock = sessionCloseUtc(snapshotDate);
  const rows: EodRow[] = [];

  for (const s of allowed) {
    const series = seriesMap.get(s) ?? [];
    const last = series[series.length - 1];
    if (!last || last.ltp <= 0) continue; // nothing recorded for this name — skip, don't invent

    // Day high/low from the recorded 5-min bars — same-day only (Fyers store
    // clears at the next session's first poll). The same bars also freeze the
    // session's final TF-breakout context (morning test + levels cleared);
    // it's evaluated below once the recomputed R-Factor is known.
    let dayHigh: number | null = null;
    let dayLow: number | null = null;
    let breakoutCtx: ReturnType<typeof deriveBreakoutContext> = null;
    if (isToday) {
      const bars = (await getFyersCandles(s, snapshotDate, 'EQ')).filter((b) => b.high > 0);
      if (bars.length > 0) {
        dayHigh = Math.max(...bars.map((b) => b.high));
        dayLow = Math.min(...bars.map((b) => b.low));
        const sc = deriveSessionContext(bars);
        const base0 = baselines.get(s);
        breakoutCtx = deriveBreakoutContext(bars, {
          openRangeHigh: sc.openRangeHigh,
          openRangeLow: sc.openRangeLow,
          openRangeComplete: sc.openRangeComplete,
          priorDayHigh: base0?.priorDayHigh ?? null,
          priorDayLow: base0?.priorDayLow ?? null,
          high5d: base0?.high5d ?? null,
          low5d: base0?.low5d ?? null,
          high20d: base0?.high20d ?? null,
          low20d: base0?.low20d ?? null,
        });
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

    // Final TF-breakout verdict at the close (efficiency check uses the
    // recomputed R-Factor). Null for non-today snapshots — bars are gone.
    const breakout: BreakoutSignal | null = breakoutCtx
      ? evaluateBreakout(breakoutCtx, last.ltp, r?.rFactor ?? null, last.changePctOpen)
      : null;

    const turnAvg = base?.futTurnover20dAvg;
    const oiFeed = nseOi.get(s);
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
      // At the close the whole session has elapsed — Turn Lvl divisor is the full-day average.
      sinceEntryPct: changeSinceEntryWindow(series, last.ltp),
      turnoverLvl: last.futTurnover > 0 && turnAvg != null && turnAvg > 0 ? last.futTurnover / turnAvg : null,
      nseOiPct: oiFeed?.nseOiPct ?? null,
      nseOiSlope30m: oiFeed?.slope30m ?? null,
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
      breakout,
      dayHigh,
      dayLow,
    });
  }

  const lastTs = Math.max(0, ...allowed.map((s) => seriesMap.get(s)?.[seriesMap.get(s)!.length - 1]?.bucketTs ?? 0));
  return { rows, lastTs };
}

/**
 * Freeze `date`'s board into `live_urgency_eod`, once. No-ops if already
 * captured (checked first — cheap — so repeat post-market polls don't redo
 * the full R-Factor recompute every time). Scoped to EVERY symbol oi_intraday
 * recorded that day, not just whichever watchlist slice triggered the call,
 * so the permanent record isn't limited to one category section's picks.
 * Best-effort: swallow errors, this must never affect the live response.
 */
async function captureEodOnce(date: string): Promise<void> {
  if (await hasEodCapture(date)) return;

  const trackedRows = await prisma.$queryRawUnsafe<{ symbol: string }[]>(
    `SELECT DISTINCT symbol FROM oi_intraday WHERE date = ?`,
    date,
  );
  const tracked = trackedRows.map((r) => r.symbol);
  if (tracked.length === 0) return;

  // Same F&O gating as the live page — never persist an 'avoid'-band name.
  const fno = await loadFnoUniverse(tracked);
  const allowed = tracked.filter((s) => classifyFno(fno.get(s)).ok);
  if (allowed.length === 0) return;

  const { rows } = await computeClosingRows(allowed, date);
  await insertEodRows(date, rows);
}

/**
 * The frozen `live_urgency_eod` rows for `allowed` on `snapshotDate`, in
 * watchlist order, enriched with the serve-time derived reads (Since-9:45,
 * Turn Lvl) from the permanent oi_intraday series + pre-date baselines.
 * Null when the capture covers none of the requested names.
 */
async function getFrozenRows(
  allowed: string[],
  snapshotDate: string,
): Promise<Pick<ClosingSnapshotResponse, 'success' | 'marketOpen' | 'snapshot' | 'snapshotDate' | 'asOf' | 'date' | 'rows'> | null> {
  const bySymbol = new Map((await getEodForDate(snapshotDate)).map((r) => [r.symbol, r]));
  const [seriesMap, baselines] = await Promise.all([
    getIntradaySeriesForSymbols(snapshotDate, allowed),
    loadRFactorBaselines(allowed, snapshotDate),
  ]);

  const rows: LiveUrgencyRow[] = [];
  let lastTs = 0;
  for (const s of allowed) {
    const r = bySymbol.get(s);
    if (!r) continue;
    const series = seriesMap.get(s) ?? [];
    lastTs = Math.max(lastTs, series[series.length - 1]?.bucketTs ?? 0);
    const turnAvg = baselines.get(s)?.futTurnover20dAvg;
    rows.push({
      ...r,
      sinceEntryPct: changeSinceEntryWindow(series, r.ltp),
      turnoverLvl: r.turnover != null && turnAvg != null && turnAvg > 0 ? r.turnover / turnAvg : null,
    });
  }
  if (rows.length === 0) return null;

  return {
    success: true,
    marketOpen: false,
    snapshot: true,
    snapshotDate,
    asOf: lastTs > 0 ? new Date(lastTs * 1000).toISOString() : undefined,
    date: snapshotDate,
    rows,
  };
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

  // Any session EARLIER than today: serve the FROZEN close capture. The live
  // recompute is only trustworthy on the session's own evening — by the next
  // day the overnight bhavcopy sync shifts the baselines under it (the day
  // would be compared against itself: bias collapses to neutral, OI change
  // turns into a Dhan-vs-NSE convention artifact) and the Fyers bars are
  // cleared. The capture was computed at the close with everything intact.
  if (snapshotDate !== todayIST() && (await hasEodCapture(snapshotDate))) {
    const frozen = await getFrozenRows(allowed, snapshotDate);
    if (frozen) return { ...frozen, symbols: allowed, excluded };
    // capture covers none of these names — fall through to the recompute
  }

  const { rows, lastTs } = await computeClosingRows(allowed, snapshotDate);
  if (rows.length === 0) return null;

  void captureEodOnce(snapshotDate).catch((e) => console.warn('[live] EOD capture failed:', (e as Error).message));

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
