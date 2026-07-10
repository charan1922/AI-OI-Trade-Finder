/**
 * Fyers 5-min download loop — the module that makes the recorder autonomous.
 *
 * Started once per server boot from instrumentation.ts; no page needs to stay
 * open. Ticks are aligned to the 5-min wall-clock grid + 10s (…:00:10, :05:10)
 * so the just-completed bar is always available from the history API. Outside
 * market hours (9:15–15:30 IST weekdays) and on NSE holidays a tick records a
 * skip and goes back to sleep — the loop itself never stops.
 *
 * Each cycle, per tracked symbol (all non-'avoid' F&O stocks, ~167 names):
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

import { EOD_PUBLISH_HOUR_IST, isMarketHours, todayIST } from '@/lib/dhan/market-feed';
import { prisma } from '@/lib/db';
import { FyersAuthError, getFyersAccessToken, getFyersTokenStatus, hasFyersAuth } from '@/lib/fyers/auth';
import { fetchFutDepth, fetchHistory5m } from '@/lib/fyers/client';
import { attachFutDepth, fyersBucketFor, pruneToDate, upsertCandles } from '@/lib/fyers/candle-store';
import { getTrackedUniverse, peekUniverse, resolveFutSymbol, toEqSymbol } from '@/lib/fyers/symbols';
import { getNseCombinedOiPctMap } from '@/lib/nse/combined-oi';

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
  /** Last date the once-a-day EOD bhavcopy sync ran (autonomous capture). */
  lastBhavcopyDate: string | null;
  /** Guards against a slow autonomous capture overlapping the next one — so the
   *  scan's Dhan/NSE calls can never be issued concurrently (rate-limit safety). */
  captureRunning: boolean;
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
    lastBhavcopyDate: null,
    captureRunning: false,
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
  if (!opts.force && !isMarketHours()) {
    // Post-market: NSE publishes the day's bhavcopy overnight, so the daily EOD
    // sync runs from here on the deployed server (see runEodCapture — once per
    // calendar day after ~01:00 IST, NOT a 5-min poll). Runs even on weekends/
    // holidays since it backfills the last completed session. The Fyers candle
    // cycle itself stays skipped.
    if (process.env.RAILWAY_ENVIRONMENT_NAME) void runEodCapture(state);
    return finish('market-closed');
  }
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

    // NSE combined-OI map for this cycle (only useful when attaching live depth)
    const nseOiPctBySymbol = attachOi ? await getNseCombinedOiPctMap() : new Map<string, number>();

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
            const depth = await withAuthRetry(() => fetchFutDepth(futSymbol));
            if (depth !== null) {
              await attachFutDepth(symbol, date, fyersBucketFor(Date.now()), {
                ...depth,
                nseOiPct: nseOiPctBySymbol.get(symbol) ?? null,
              });
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

    // Autonomous in-process capture (deployed server only). Drives the same
    // endpoints that otherwise only persist when a browser/loop hits them, so
    // /trade-suggest, the OI-urgency series and the Trade Log fill hands-off —
    // no external cron. Gated to live market hours today; never blocks/breaks
    // the poller (fire-and-forget, own error handling).
    if (!opts.dateOverride && attachOi && process.env.RAILWAY_ENVIRONMENT_NAME) {
      void runAutonomousCapture(today, state);
    }
    return finish();
  } finally {
    state.cycleRunning = false;
  }
}

/**
 * In-process market-data capture, replacing the external scan/bhavcopy cron
 * (Railway-only, no GitHub Actions). Runs the trade-suggest scan every cycle
 * (records `oi_intraday` urgency + persists picks; self-limits picks to the
 * 09:40–11:00 window) and syncs EOD bhavcopy once a day. Best-effort — any
 * failure is logged and swallowed so the recorder is never affected.
 */
async function runAutonomousCapture(today: string, state: PollerState): Promise<void> {
  // Never let a slow capture overlap the next cycle's — this serializes the
  // scan's Dhan/NSE calls (rate-limit safety). A skipped pass self-heals next
  // cycle (the scan is idempotent; repeats just bump timesSeen).
  if (state.captureRunning) return;
  state.captureRunning = true;
  const origin = `http://127.0.0.1:${process.env.PORT ?? '5001'}`;
  try {
    try {
      const { runTradeSuggest } = await import('@/lib/trade-suggest/engine');
      const result = await runTradeSuggest(origin); // internal /api/live/* fetches carry APP_PASSWORD auth
      // AI commentary (MiMo) — narrates the picks per the config window. Fully
      // isolated: a commentary failure never affects the scan or the recorder.
      try {
        const { runAndStoreCommentary } = await import('@/lib/ai-commentary/run');
        const outcome = await runAndStoreCommentary(result);
        if (outcome.generated) console.log(`${TAG} AI commentary generated`);
      } catch (err) {
        console.warn(`${TAG} commentary failed: ${(err as Error).message}`);
      }
    } catch (err) {
      console.warn(`${TAG} autonomous scan failed: ${(err as Error).message}`);
    }
    // NOTE: EOD bhavcopy is NOT synced here — NSE only publishes it after close,
    // so it runs in runEodCapture() from the post-market branch instead.
  } finally {
    state.captureRunning = false;
  }
}

/**
 * Post-market EOD capture (Railway-only). NSE publishes the day's bhavcopy in the
 * evening, so this runs from the market-closed branch after ~19:00 IST, once per
 * trading day. Retries every 5-min tick until today's file is actually stored
 * (NSE can publish late) — `lastBhavcopyDate` is only advanced once the sync
 * reports today as the latest session. Best-effort; never throws to the poller.
 */
async function runEodCapture(state: PollerState): Promise<void> {
  // NSE publishes the day's bhavcopy overnight, so only attempt after the publish
  // hour, and only ONCE per calendar day (NOT a 5-min poll). syncBhavcopy grabs
  // every missing available session in its window, so one nightly run backfills
  // the last completed day; a rare miss self-heals on the next night's run.
  const istNow = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60_000);
  if (istNow.getHours() < EOD_PUBLISH_HOUR_IST) return;
  const istToday = `${istNow.getFullYear()}-${String(istNow.getMonth() + 1).padStart(2, '0')}-${String(istNow.getDate()).padStart(2, '0')}`;
  if (state.lastBhavcopyDate === istToday) return; // already ran once this calendar day
  if (state.captureRunning) return;
  state.captureRunning = true;
  try {
    const origin = `http://127.0.0.1:${process.env.PORT ?? '5001'}`;
    const auth: Record<string, string> = process.env.APP_PASSWORD
      ? { Authorization: `Basic ${Buffer.from(`x:${process.env.APP_PASSWORD}`).toString('base64')}` }
      : {};
    const res = await fetch(`${origin}/api/bhavcopy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: '{}',
    });
    if (res.ok) {
      const j = (await res.json().catch(() => ({}))) as { status?: { latestDate?: string } };
      state.lastBhavcopyDate = istToday; // mark done for today, on a successful run
      console.log(`${TAG} EOD bhavcopy sync ran (latest ${j.status?.latestDate ?? '?'})`);
    }
  } catch (err) {
    console.warn(`${TAG} EOD bhavcopy sync failed: ${(err as Error).message}`);
  } finally {
    state.captureRunning = false;
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
