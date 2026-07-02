/**
 * Fyers 5-min download loop — the module that makes the recorder autonomous.
 *
 * Started once per server boot from instrumentation.ts; no page needs to stay
 * open. Ticks are aligned to the 5-min wall-clock grid + 10s (…:00:10, :05:10)
 * so the just-completed bar is always available from the history API. Outside
 * market hours (9:15–15:30 IST weekdays) and on NSE holidays a tick records a
 * skip and goes back to sleep — the loop itself never stops.
 *
 * Each cycle, per tracked symbol (movers FOSec universe, accumulated all day):
 *   1. equity full-day 5-min history  → upsert 'EQ' rows
 *   2. futures full-day 5-min history → upsert 'FUT' rows
 *   3. live futures OI via depth      → attach to the current 'FUT' bucket
 * Full-day refetch + PK upsert means missed cycles self-heal and duplicates
 * are impossible. pruneToDate() at cycle start keeps only today's rows.
 *
 * State lives on globalThis: Turbopack HMR re-evaluates this module, and a
 * module-level timer would duplicate the loop on every hot reload (same
 * rationale as lib/dhan/market-feed.ts's gate).
 */

import { isMarketHours, todayIST } from '@/lib/dhan/market-feed';
import { prisma } from '@/lib/db';
import { FyersAuthError, getFyersAccessToken, getFyersTokenStatus, hasFyersAuth } from '@/lib/fyers/auth';
import { fetchFutOi, fetchHistory5m } from '@/lib/fyers/client';
import { attachFutOi, fyersBucketFor, pruneToDate, upsertCandles } from '@/lib/fyers/candle-store';
import { getTrackedUniverse, peekUniverse, resolveFutSymbol, toEqSymbol } from '@/lib/fyers/symbols';

const TAG = '[FyersPoller]';
const CYCLE_MS = 5 * 60 * 1000;
const TICK_OFFSET_MS = 10_000; // fire 10s after the grid boundary so the closed bar exists

export interface CycleError {
  symbol: string;
  stage: 'resolve' | 'eq-history' | 'fut-history' | 'oi' | 'cycle';
  message: string;
}

export interface CycleSummary {
  date: string;
  startedAt: string;
  durationMs: number;
  trigger: 'timer' | 'manual';
  universeSize: number;
  symbolsProcessed: number;
  apiCalls: number;
  eqBars: number;
  futBars: number;
  oiAttached: number;
  skipped?: 'market-closed' | 'holiday' | 'paused' | 'overlap' | 'no-credentials';
  errors: CycleError[];
}

interface PollerState {
  started: boolean;
  paused: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  cycleRunning: boolean;
  cycles: number;
  lastCycle: CycleSummary | null;
  nextTickAt: number | null;
  holidayCache: { date: string; holiday: boolean } | null;
}

const g = globalThis as unknown as { __fyersPoller?: PollerState };

function getState(): PollerState {
  g.__fyersPoller ??= {
    started: false,
    paused: false,
    timer: null,
    startedAt: 0,
    cycleRunning: false,
    cycles: 0,
    lastCycle: null,
    nextTickAt: null,
    holidayCache: null,
  };
  return g.__fyersPoller;
}

/** NSE holiday lookup (table maintained by lib/backtest/trading-calendar.ts). Soft-fails open. */
async function isMarketHoliday(date: string): Promise<boolean> {
  const state = getState();
  if (state.holidayCache?.date === date) return state.holidayCache.holiday;
  let holiday = false;
  try {
    const rows = await prisma.$queryRawUnsafe<unknown[]>(
      `SELECT 1 FROM market_holidays WHERE date = ? LIMIT 1`,
      date,
    );
    holiday = rows.length > 0;
  } catch {
    // Table absent / unreadable → assume trading day; a holiday cycle just fetches empty candles
  }
  state.holidayCache = { date, holiday };
  return holiday;
}

/**
 * Run one download cycle. `force` bypasses the paused/market-hours/holiday
 * guards (manual run-once); `dateOverride` fetches that day's candles instead
 * of today's (market-closed testing — OI is skipped, and the rows are removed
 * by the next un-overridden cycle's prune).
 */
export async function runFyersCycle(
  opts: { force?: boolean; dateOverride?: string; trigger?: 'timer' | 'manual' } = {},
): Promise<CycleSummary> {
  const state = getState();
  const trigger = opts.trigger ?? 'manual';
  const startedMs = Date.now();
  const summary: CycleSummary = {
    date: opts.dateOverride ?? todayIST(),
    startedAt: new Date(startedMs).toISOString(),
    durationMs: 0,
    trigger,
    universeSize: 0,
    symbolsProcessed: 0,
    apiCalls: 0,
    eqBars: 0,
    futBars: 0,
    oiAttached: 0,
    errors: [],
  };
  const finish = (skipped?: CycleSummary['skipped']): CycleSummary => {
    if (skipped) summary.skipped = skipped;
    summary.durationMs = Date.now() - startedMs;
    state.lastCycle = summary;
    return summary;
  };

  if (state.cycleRunning) return finish('overlap');
  if (state.paused && !opts.force) return finish('paused');
  if (!opts.force && !isMarketHours()) return finish('market-closed');
  if (!opts.force && (await isMarketHoliday(summary.date))) return finish('holiday');
  if (!hasFyersAuth()) {
    summary.errors.push({ symbol: '*', stage: 'cycle', message: 'Fyers credentials not configured (.env.local)' });
    return finish('no-credentials');
  }

  state.cycleRunning = true;
  try {
    const today = todayIST();
    const date = summary.date;
    // Live OI only makes sense for "now" — skip when backfilling a past date or
    // when the market is closed (the current wall-clock bucket would sit outside
    // the session and create an orphan row).
    const attachOi = date === today && isMarketHours();

    if (!opts.dateOverride) await pruneToDate(today);

    const universe = await getTrackedUniverse(today);
    summary.universeSize = universe.length;

    // One retried token regeneration per cycle: the first auth failure clears
    // the cached token; the retry regenerates it. A second failure aborts the
    // cycle — every remaining call would fail the same way.
    let authRetried = false;
    const withAuthRetry = async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (err) {
        if (!(err instanceof FyersAuthError) || authRetried) throw err;
        authRetried = true;
        console.warn(`${TAG} auth failure — regenerating token and retrying once`);
        await getFyersAccessToken();
        return call();
      }
    };

    for (const symbol of universe) {
      try {
        let futSymbol: string | null = null;
        try {
          futSymbol = await resolveFutSymbol(symbol, today);
        } catch (err) {
          summary.errors.push({ symbol, stage: 'resolve', message: (err as Error).message });
        }

        summary.apiCalls += 1;
        const eqBars = await withAuthRetry(() => fetchHistory5m(toEqSymbol(symbol), date));
        summary.eqBars += await upsertCandles(symbol, 'EQ', date, eqBars);

        if (futSymbol) {
          summary.apiCalls += 1;
          const futBars = await withAuthRetry(() => fetchHistory5m(futSymbol, date));
          summary.futBars += await upsertCandles(symbol, 'FUT', date, futBars);

          if (attachOi) {
            summary.apiCalls += 1;
            const oi = await withAuthRetry(() => fetchFutOi(futSymbol));
            if (oi !== null) {
              await attachFutOi(symbol, date, fyersBucketFor(Date.now()), oi);
              summary.oiAttached += 1;
            }
          }
        }
        summary.symbolsProcessed += 1;
      } catch (err) {
        if (err instanceof FyersAuthError) {
          summary.errors.push({ symbol, stage: 'cycle', message: `auth failed twice — cycle aborted: ${err.message}` });
          break;
        }
        summary.errors.push({ symbol, stage: 'cycle', message: (err as Error).message });
      }
    }

    state.cycles += 1;
    console.log(
      `${TAG} cycle #${state.cycles} (${trigger}) ${date}: ${summary.symbolsProcessed}/${summary.universeSize} symbols, ` +
        `${summary.eqBars} eq bars, ${summary.futBars} fut bars, ${summary.oiAttached} OI, ` +
        `${summary.apiCalls} calls, ${summary.errors.length} errors, ${Date.now() - startedMs}ms`,
    );
    return finish();
  } finally {
    state.cycleRunning = false;
  }
}

function scheduleNextTick(): void {
  const state = getState();
  if (!state.started) return;
  const delay = CYCLE_MS - (Date.now() % CYCLE_MS) + TICK_OFFSET_MS;
  state.nextTickAt = Date.now() + delay;
  state.timer = setTimeout(() => {
    runFyersCycle({ trigger: 'timer' })
      .catch((err) => console.error(`${TAG} cycle crashed:`, err))
      .finally(scheduleNextTick);
  }, delay);
  // Don't keep a dying process alive just for the next tick (harmless in Next dev/prod)
  state.timer.unref?.();
}

/** Idempotent — the instrumentation.ts entry point. Safe under HMR re-evaluation. */
export function startFyersPoller(): void {
  const state = getState();
  if (state.started) return;
  state.started = true;
  state.startedAt = Date.now();
  scheduleNextTick();
  console.log(
    `${TAG} started — next tick ${state.nextTickAt ? new Date(state.nextTickAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) : '?'} IST` +
      (hasFyersAuth() ? '' : ' (Fyers credentials NOT configured — cycles will skip)'),
  );
}

export function stopFyersPoller(): void {
  const state = getState();
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.started = false;
  state.nextTickAt = null;
  console.log(`${TAG} stopped`);
}

export function setFyersPollerPaused(paused: boolean): void {
  getState().paused = paused;
  console.log(`${TAG} ${paused ? 'paused' : 'resumed'}`);
}

export interface PollerStatus {
  started: boolean;
  paused: boolean;
  startedAt: number;
  cycleRunning: boolean;
  cycles: number;
  nextTickAt: number | null;
  lastCycle: CycleSummary | null;
  marketOpen: boolean;
  credentialsConfigured: boolean;
  token: { cached: boolean; expiresAt: number | null };
  universe: { date: string; symbols: string[] } | null;
}

export function getFyersPollerStatus(): PollerStatus {
  const state = getState();
  return {
    started: state.started,
    paused: state.paused,
    startedAt: state.startedAt,
    cycleRunning: state.cycleRunning,
    cycles: state.cycles,
    nextTickAt: state.nextTickAt,
    lastCycle: state.lastCycle,
    marketOpen: isMarketHours(),
    credentialsConfigured: hasFyersAuth(),
    token: getFyersTokenStatus(),
    universe: peekUniverse(),
  };
}
