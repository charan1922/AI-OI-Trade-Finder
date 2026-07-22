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
 * are impossible. pruneCandleHistory() at cycle start keeps the newest
 * FYERS_CANDLE_RETENTION_SESSIONS sessions (today + the replay benchmark's
 * trailing days).
 *
 * State lives on globalThis: Turbopack HMR re-evaluates this module, and a
 * module-level timer would duplicate the loop on every hot reload (same
 * rationale as lib/dhan/market-feed.ts's gate).
 */

import { nowIST } from '@/lib/auto-trade/config';
import { getDhanAccessToken, hasDhanAuth } from '@/lib/dhan/auth';
import { EOD_PUBLISH_HOUR_IST, isMarketHours, todayIST } from '@/lib/dhan/market-feed';
import { prisma } from '@/lib/db';
import { releaseRuntimeLease, tryAcquireRuntimeLease } from '@/lib/runtime/lease';
import { markToday, wasMarkedToday } from '@/lib/runtime/daily-marker';
import { inDriftReminderWindow, runConfigDriftReminderCore } from '@/lib/config/config-drift-reminder';
import { FyersAuthError, getFyersAccessToken, getFyersTokenStatus, hasFyersAuth } from '@/lib/fyers/auth';
import { fetchFutDepth, fetchHistory5m, type FyersBar } from '@/lib/fyers/client';
import { attachFutDepth, fyersBucketFor, pruneCandleHistory, upsertCandles } from '@/lib/fyers/candle-store';
import { runLiveDecisionPath } from '@/lib/fyers/live-decision-path';
import { getTrackedUniverse, peekUniverse, resolveFutSymbol, toEqSymbol } from '@/lib/fyers/symbols';
import { getNseCombinedOiPctMap } from '@/lib/nse/combined-oi';
import { startCycleTimeline } from '@/lib/ops/cycle-timeline';
import { pruneRankSnapshots, recordRankSnapshot } from '@/lib/signals/rank-tracker';
import { pruneRFactorV2Snapshots } from '@/lib/r-factor-v2/store';
import type { CandidateSnapshot } from '@/lib/trade-suggest/candidates';
import { reviewToday } from '@/lib/trade-suggest/review';
import { pruneSectorSnapshots } from '@/lib/priority-refresh/sector-snapshot-store';
import { runPostDecisionShadow, type ShadowCycleInput } from '@/lib/priority-refresh/shadow';
import { prunePriorityCycles } from '@/lib/priority-refresh/telemetry-store';

const TAG = '[FyersPoller]';
const CYCLE_MS = 5 * 60 * 1000;
const TICK_OFFSET_MS = 10_000; // fire 10s after the grid boundary so the closed bar exists
const PRIORITY_HISTORY_CONCURRENCY = 3;
const POLLER_LEASE = 'fyers-poller';
const POLLER_LEASE_TTL_MS = 90_000;

/**
 * True on the ONE deployed server that owns the autonomous jobs — the
 * market-hours scan/auto-trade capture, the nightly EOD bhavcopy sync, and the
 * evening scorecard. Provider-agnostic: set AUTONOMOUS_SERVER=true on the live
 * host (self-hosted box or any VM). The legacy Railway signal is still honored
 * so a Railway deploy keeps working through the migration. Dev laptops set
 * neither, so they never fire autonomous trading (candles/warm-up still run).
 */
function isAutonomousServer(): boolean {
  return process.env.AUTONOMOUS_SERVER === 'true' || Boolean(process.env.RAILWAY_ENVIRONMENT_NAME);
}

/** True only when history contains a usable bar at the required bucket. */
export function hasRequiredEqBar(bars: readonly FyersBar[], requiredBucket: number | null): boolean {
  return bars.some((bar) => bar.open > 0 && (requiredBucket === null || bar.bucketTs >= requiredBucket));
}

async function mapBounded<T>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next++;
      await work(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker()));
}

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
  prioritySymbols: number;
  /** Priority symbols whose Fyers history response contained candle rows. */
  priorityFreshSymbols: number;
  /** Tick start to release of the autonomous scan path. */
  captureReleaseMs: number | null;
  skipped?: 'market-closed' | 'holiday' | 'paused' | 'overlap' | 'not-leader' | 'no-credentials';
  errors: CycleError[];
}

export interface CaptureTiming {
  cycleStartedAt: string;
  captureStartedAt: string;
  status: 'completed' | 'scan-failed' | 'decision-failed' | 'skipped-overlap';
  tickToCaptureMs: number;
  tickToScanMs: number | null;
  scanToDecisionMs: number | null;
  tickToDecisionMs: number | null;
  redundantReadTools: number | null;
  detail: string | null;
}

interface AutonomousDecisionResult {
  commentaryHandled: boolean;
  /** True only when this process owned and completed the Auto Trade pass. */
  shadowSafe: boolean;
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
  /** Last date the once-a-day EOD bhavcopy sync CONFIRMED the expected session
   *  was stored (H4: never advanced on a mere HTTP 200). */
  lastBhavcopyDate: string | null;
  /** Last bhavcopy sync attempt (ms) — caps late-publish retries to ~hourly. */
  lastBhavcopyAttemptMs: number | null;
  /** Last date the nightly master-contracts auto-sync succeeded (C3). */
  lastMasterContractsDate: string | null;
  /** Last master-contracts sync attempt (ms) — caps failure retries to ~hourly. */
  lastMasterContractsAttemptMs: number | null;
  /** Last date a master-contracts failure alert was sent (max one per day). */
  lastMasterContractsAlertDate: string | null;
  /** Last date the once-a-day trade-suggest scorecard (review.ts) ran. */
  lastScorecardDate: string | null;
  /** Guards against a slow autonomous capture overlapping the next one — so the
   *  scan's Dhan/NSE calls can never be issued concurrently (rate-limit safety). */
  captureRunning: boolean;
  captureSkips: number;
  lastCapture: CaptureTiming | null;
  /** Latest pre-open token warm-up attempt (08:40–09:15 IST ticks, trading days).
   *  Per-provider outcome: 'ok' | 'no-credentials' | 'error: …'. Overwritten each
   *  attempt — the token caches themselves are the real success markers. */
  lastWarmup: { date: string; at: number; fyers: string; dhan: string } | null;
  /** Keeps lastWarmup writes clean when a slow warm-up overlaps the next tick
   *  (the auth modules' promise locks already make the API side safe). */
  warmupRunning: boolean;
  /** Last date the pre-open config-drift reminder ran (max one per day) — see
   *  runConfigDriftReminder. */
  lastConfigDriftAlertDate: string | null;
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
    lastBhavcopyAttemptMs: null,
    lastMasterContractsDate: null,
    lastMasterContractsAttemptMs: null,
    lastMasterContractsAlertDate: null,
    lastScorecardDate: null,
    captureRunning: false,
    captureSkips: 0,
    lastCapture: null,
    lastWarmup: null,
    warmupRunning: false,
    lastConfigDriftAlertDate: null,
  };
  return g.__fyersPoller;
}

/**
 * NSE holiday lookup (table maintained by lib/backtest/trading-calendar.ts).
 * FAILS CLOSED for the trading path (C2, forensic audit): an EMPTY table cannot
 * clear a date — a fresh deploy that never seeded holidays used to trade
 * straight through an NSE holiday on the exchange's stale data. When the table
 * is empty, seed it from the official CSV and re-check; if it still cannot be
 * verified (or the DB read throws), the date is treated as a holiday and the
 * cycle skips. instrumentation.ts also seeds at boot, so this path is a backstop.
 */
async function isMarketHoliday(date: string): Promise<boolean> {
  const state = getState();
  if (state.holidayCache?.date === date) return state.holidayCache.holiday;
  let holiday: boolean;
  try {
    let verified = false;
    holiday = false;
    try {
      const rows = await prisma.$queryRawUnsafe<unknown[]>(
        `SELECT 1 FROM market_holidays WHERE date = ? LIMIT 1`,
        date
      );
      if (rows.length > 0) {
        holiday = true;
        verified = true;
      } else {
        const countRows = await prisma.$queryRawUnsafe<{ n: number | bigint }[]>(
          `SELECT COUNT(*) AS n FROM market_holidays`
        );
        // A populated table that doesn't list the date = a real trading day.
        // An empty table proves nothing — fall through to seeding.
        if (Number(countRows[0]?.n ?? 0) > 0) verified = true;
      }
    } catch {
      // table may not exist yet (fresh DB) — seeding below creates it
    }
    if (!verified) {
      const { syncHolidays } = await import('@/lib/backtest/trading-calendar');
      const map = await syncHolidays();
      if (map.size === 0) {
        console.error(`${TAG} holiday calendar empty and unseedable — failing CLOSED (treating ${date} as a holiday)`);
        return true; // do not cache a fail-closed verdict — retry next tick
      }
      holiday = map.has(date);
    }
  } catch (err) {
    console.error(`${TAG} holiday lookup failed — failing CLOSED for the trading path: ${(err as Error).message}`);
    return true; // transient DB error: skip this tick, do not cache
  }
  state.holidayCache = { date, holiday };
  return holiday;
}

/**
 * Run one download cycle. `force` bypasses the paused/market-hours/holiday
 * guards (manual run-once); `dateOverride` fetches that day's candles instead
 * of today's (market-closed testing / replay-benchmark backfill — OI is
 * skipped; the rows survive as long as the date is among the newest
 * FYERS_CANDLE_RETENTION_SESSIONS sessions).
 */
export async function runFyersCycle(
  opts: {
    force?: boolean;
    dateOverride?: string;
    trigger?: 'timer' | 'manual';
  } = {}
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
    prioritySymbols: 0,
    priorityFreshSymbols: 0,
    captureReleaseMs: null,
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
    if (isAutonomousServer()) void runEodCapture(state);
    // Nightly Dhan scrip-master refresh (same overnight window as bhavcopy) so
    // rolled expiries never silently break FUT/strike resolution (C3).
    if (isAutonomousServer()) void runEodMasterContractsSync(state);
    // Same-evening scorecard: grade today's /trade-suggest picks against the
    // recorded candles once, after close. Reads local candles only — no API,
    // no AI, no cost — and never runs during market hours.
    if (isAutonomousServer()) void runEodScorecard(state);
    // Pre-open token warm-up (08:40–09:15 IST ticks): both broker tokens exist
    // BEFORE 09:00 without any page being opened. Fire-and-forget; window/day
    // gating lives inside. Note: a PAUSED poller skips this branch entirely —
    // pausing is an explicit operator action, warm-up pauses with it.
    void warmPreOpenTokens(state).catch(() => {});
    // Pre-open config-drift reminder — same window, independent of tokens.
    void runConfigDriftReminder(state).catch(() => {});
    return finish('market-closed');
  }
  if (!opts.force && (await isMarketHoliday(summary.date))) return finish('holiday');
  if (!hasFyersAuth()) {
    summary.errors.push({
      symbol: '*',
      stage: 'cycle',
      message: 'Fyers credentials not configured (.env.local)',
    });
    return finish('no-credentials');
  }
  if (!(await tryAcquireRuntimeLease(POLLER_LEASE, POLLER_LEASE_TTL_MS))) return finish('not-leader');

  state.cycleRunning = true;
  const leaseRenewal = setInterval(() => {
    void tryAcquireRuntimeLease(POLLER_LEASE, POLLER_LEASE_TTL_MS);
  }, 30_000);
  // Config-drift reminder also on the market-OPEN path: a server that started
  // AFTER the 08:40–09:15 pre-open ticks (e.g. 09:20) skipped the market-closed
  // branch entirely, so without this the day's reminder would never fire. The
  // persistent marker + window guard keep it at most once/day (PR#2 review).
  void runConfigDriftReminder(state).catch(() => {});
  try {
    const today = todayIST();
    const date = summary.date;
    // Live OI only makes sense for "now" — skip when backfilling a past date or
    // when the market is closed (the current wall-clock bucket would sit outside
    // the session and create an orphan row).
    const attachOi = date === today && isMarketHours();

    const universe = await getTrackedUniverse(today);
    summary.universeSize = universe.length;

    // ── Priority-first download (2026-07-15, latency fix) ──────────────────
    // The autonomous capture (scan → AI decision) used to wait for the WHOLE
    // ~166-symbol download (~3 min of sequential Fyers calls) even though the
    // scan only reads EQ candles; its prices/futures OI come from batched Dhan
    // and NSE snapshots. So: refresh EQ history for the priority names FIRST
    // (open positions, today's earlier picks, the NSE movers/OI lists — the
    // same ~50-80 names /live shows), fire the capture as soon as those candles
    // land, and let every FUT-history/depth call plus the remaining universe
    // download while the scan/AI runs. The providers have separate account
    // limits, so this overlap is intentional; the shared Dhan gates still
    // serialize each Dhan endpoint process-wide. The full
    // universe still downloads every cycle (replay benchmark + full-universe
    // scans need it) — nothing is excluded, only reordered.
    const captureEligible = !opts.dateOverride && attachOi && isAutonomousServer();
    let candidateSnapshot: CandidateSnapshot | null = null;
    if (captureEligible) {
      try {
        const { discoverCandidateSnapshot, isCandidateScanDue } = await import('@/lib/trade-suggest/candidates');
        if (await isCandidateScanDue()) candidateSnapshot = await discoverCandidateSnapshot();
      } catch (err) {
        console.warn(`${TAG} candidate discovery failed: ${(err as Error).message}`);
      }
    }
    // Freeze replay membership from the same pulse-cache moment as candidate
    // discovery. Run off-path; Fyers downloads can proceed while SQLite stores
    // the rank rows.
    if (attachOi) void recordRankSnapshot(today, Date.now(), candidateSnapshot?.fullUniverse ?? null).catch(() => {});
    const priorityInfo = captureEligible
      ? await getPrioritySymbols(today, candidateSnapshot)
      : { symbols: new Set<string>(), riskBearing: [] as string[], earlierSuggestions: [] as string[] };
    const priority = priorityInfo.symbols;

    // Freeze only the data needed by the measurement. The settings/sector reads,
    // plan build, and persistence are queued after the live decision completes.
    const shadowInput: ShadowCycleInput | null =
      captureEligible && candidateSnapshot
        ? {
            today,
            bucketTs: fyersBucketFor(startedMs),
            candidateSnapshot,
            riskBearing: priorityInfo.riskBearing,
            earlierSuggestions: priorityInfo.earlierSuggestions,
            fullPriority: [...priority],
            universe,
          }
        : null;

    // Priority download order is UNCHANGED from before the shadow work — the
    // shadow is membership + coverage only, so it does NOT reorder network
    // requests (reordering could shift the final priority request's completion
    // time; PR#11 review B6). Faithful capped-first timing is measured in the
    // capped-live PR, where the reorder is the actual behaviour.
    const ordered =
      priority.size > 0
        ? [...universe.filter((s) => priority.has(s)), ...universe.filter((s) => !priority.has(s))]
        : universe;
    const priorityCount = ordered.length - universe.filter((s) => !priority.has(s)).length;
    summary.prioritySymbols = priorityCount;
    let captureFired = false;

    // One retried token regeneration per cycle: the first auth failure clears
    // the cached token; the retry regenerates it. A second failure aborts the
    // cycle — every remaining call would fail the same way.
    let authRefresh: Promise<void> | null = null;
    const withAuthRetry = async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (err) {
        if (!(err instanceof FyersAuthError)) throw err;
        console.warn(`${TAG} auth failure — regenerating token and retrying once`);
        authRefresh ??= getFyersAccessToken()
          .then(() => undefined)
          .finally(() => {
            authRefresh = null;
          });
        await authRefresh;
        return call();
      }
    };

    let cycleAborted = false;
    const downloadEq = async (symbol: string, requireFresh = false): Promise<boolean> => {
      try {
        const fetchEqBars = async () => {
          summary.apiCalls += 1;
          return withAuthRetry(() => fetchHistory5m(toEqSymbol(symbol), date));
        };
        const requiredBucket = requireFresh ? fyersBucketFor(startedMs) - CYCLE_MS / 1000 : null;
        let eqBars = await fetchEqBars();
        if (!hasRequiredEqBar(eqBars, requiredBucket) && requireFresh) eqBars = await fetchEqBars();
        if (!hasRequiredEqBar(eqBars, requiredBucket)) {
          summary.errors.push({
            symbol,
            stage: 'eq-history',
            message: requireFresh
              ? 'Fyers priority EQ history did not reach the latest completed 5-min bucket after retry; capture will use last stored candle context'
              : 'Fyers returned no usable EQ candles; recorder kept existing candle context',
          });
          return false;
        }
        summary.eqBars += await upsertCandles(symbol, 'EQ', date, eqBars);
        return true;
      } catch (err) {
        if (err instanceof FyersAuthError) {
          summary.errors.push({
            symbol,
            stage: 'cycle',
            message: `auth failed twice — cycle aborted: ${err.message}`,
          });
          cycleAborted = true;
          return false;
        }
        summary.errors.push({
          symbol,
          stage: 'eq-history',
          message: (err as Error).message,
        });
        return false;
      }
    };

    // Critical path: one Fyers history call per priority symbol. FUT history
    // and depth are recorder/replay data; the live scan does not read them.
    // Bounded in-flight requests preserve the existing 350ms dispatch gate
    // and adaptive 429 cooldown while removing response-time head-of-line
    // blocking from the decision path.
    let priorityFreshCount = 0;
    await mapBounded(ordered.slice(0, priorityCount), PRIORITY_HISTORY_CONCURRENCY, async (symbol) => {
      if (!cycleAborted && (await downloadEq(symbol, true))) priorityFreshCount += 1;
    });
    summary.priorityFreshSymbols = priorityFreshCount;

    if (!cycleAborted && captureEligible && priorityCount > 0) {
      captureFired = true;
      summary.captureReleaseMs = Date.now() - startedMs;
      console.log(
        `${TAG} priority EQ refresh ${priorityFreshCount}/${priorityCount} fresh — capture fired; ${priorityCount - priorityFreshCount} use last stored candle context, FUT/depth and ${ordered.length - priorityCount} more symbols continue in background`
      );
      void runAutonomousCapture(today, state, candidateSnapshot, startedMs, shadowInput);
    } else if (!cycleAborted && captureEligible && priorityCount === 0) {
      // Feeds down / no current candidates: position management and the live
      // scan still use last-cycle candles plus fresh Dhan/NSE snapshots.
      captureFired = true;
      summary.captureReleaseMs = Date.now() - startedMs;
      console.log(`${TAG} no priority symbols — capture fired immediately`);
      void runAutonomousCapture(today, state, candidateSnapshot, startedMs, shadowInput);
    }

    // Recorder-only work starts after the decision path is released.
    const nseOiPctBySymbol = attachOi ? await getNseCombinedOiPctMap() : new Map<string, number>();
    for (let symbolIdx = 0; symbolIdx < ordered.length && !cycleAborted; symbolIdx += 1) {
      const symbol = ordered[symbolIdx];
      try {
        let futSymbol: string | null = null;
        try {
          futSymbol = await resolveFutSymbol(symbol, today);
        } catch (err) {
          summary.errors.push({
            symbol,
            stage: 'resolve',
            message: (err as Error).message,
          });
        }

        // Priority EQ was completed above; the tail still gets the identical
        // full EQ+FUT+depth refresh before the cycle finishes.
        if (symbolIdx >= priorityCount) {
          await downloadEq(symbol);
          if (cycleAborted) break;
        }

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
          summary.errors.push({
            symbol,
            stage: 'cycle',
            message: `auth failed twice — cycle aborted: ${err.message}`,
          });
          cycleAborted = true;
          break;
        }
        summary.errors.push({
          symbol,
          stage: 'cycle',
          message: (err as Error).message,
        });
      }
    }

    // Retention never affects today's readers. Keep its SQLite work entirely
    // off the tick-to-decision path and run it after the recorder is complete.
    if (!opts.dateOverride) {
      await pruneCandleHistory();
      await pruneRankSnapshots();
      // The R-Factor V2 shadow writes one row per symbol per minute with two
      // JSON payloads attached, making it the fastest-growing table here. Same
      // 20-session policy as candles/ranks.
      await pruneRFactorV2Snapshots().catch((err) => {
        console.warn(`${TAG} rfactor-v2 retention failed: ${(err as Error).message}`);
      });
      // The priority-refresh retention tables can be read or written by the
      // asynchronous Auto Trade pass. Do not contend with its money-touching
      // SQLite work; a later recorder cycle will perform this best-effort cleanup.
      if (!state.captureRunning) {
        await pruneSectorSnapshots();
        await prunePriorityCycles();
      }
    }

    state.cycles += 1;
    console.log(
      `${TAG} cycle #${state.cycles} (${trigger}) ${date}: ${summary.symbolsProcessed}/${summary.universeSize} symbols, ` +
        `${summary.eqBars} eq bars, ${summary.futBars} fut bars, ${summary.oiAttached} OI, ` +
        `${summary.apiCalls} calls, ${summary.errors.length} errors, ${Date.now() - startedMs}ms`
    );

    // Autonomous in-process capture (deployed server only) — FALLBACK fire
    // point: normally the capture already fired above; this covers a critical
    // Fyers auth abort/exception before the release point. Gated to live
    // market hours today; never blocks/breaks the poller (fire-and-forget).
    if (!captureFired && captureEligible) {
      summary.captureReleaseMs = Date.now() - startedMs;
      void runAutonomousCapture(today, state, candidateSnapshot, startedMs, shadowInput);
    }
    return finish();
  } finally {
    clearInterval(leaseRenewal);
    await releaseRuntimeLease(POLLER_LEASE);
    state.cycleRunning = false;
  }
}

/**
 * Symbols whose candles must be FRESH before the capture fires — the download
 * loop refreshes their EQ history first so the scan/AI works on this cycle's
 * candle shape without waiting for unrelated FUT history/depth calls:
 *   1. Open auto-trade positions (the guard's spot stops read their candles),
 *   2. today's earlier picks (position-management feed),
 *   3. the /live watchlist (NSE oi-spurts + FOSec gainers/losers + most-active
 *      by value/volume — the same shared-cache pulse feeds the page shows,
 *      fetched sequentially to respect NSE's burst limit; oiSpurts is already
 *      warm from the cycle's combined-OI fetch).
 * Best-effort everywhere: any source failing just contributes nothing; an
 * empty set means the capture fires immediately on last-cycle candle context
 * rather than waiting for unrelated recorder work.
 */
async function getPrioritySymbols(
  today: string,
  candidateSnapshot: CandidateSnapshot | null
): Promise<{ symbols: Set<string>; riskBearing: string[]; earlierSuggestions: string[] }> {
  const symbols = new Set<string>();
  const riskBearing: string[] = [];
  const earlierSuggestions: string[] = [];
  for (const symbol of candidateSnapshot?.prioritySymbols ?? []) symbols.add(symbol);
  try {
    const { getRiskBearingTrades } = await import('@/lib/auto-trade/store');
    for (const t of await getRiskBearingTrades()) {
      symbols.add(t.symbol);
      riskBearing.push(t.symbol);
    }
  } catch (err) {
    console.warn(`${TAG} priority: open trades unavailable: ${(err as Error).message}`);
  }
  try {
    const { getSuggestions } = await import('@/lib/trade-suggest/store');
    for (const s of await getSuggestions(today)) {
      symbols.add(s.symbol);
      earlierSuggestions.push(s.symbol);
    }
  } catch (err) {
    console.warn(`${TAG} priority: suggestions unavailable: ${(err as Error).message}`);
  }
  return { symbols, riskBearing, earlierSuggestions };
}

/**
 * In-process market-data capture, replacing the external scan/bhavcopy cron
 * (Railway-only, no GitHub Actions). Runs the trade-suggest scan every cycle
 * (records `oi_intraday` urgency + persists picks; self-limits picks to the
 * 09:40–11:00 window) and syncs EOD bhavcopy once a day. Best-effort — any
 * failure is logged and swallowed so the recorder is never affected.
 */
async function runAutonomousCapture(
  today: string,
  state: PollerState,
  candidateSnapshot: CandidateSnapshot | null = null,
  cycleStartedMs: number | null = null,
  shadowInput: ShadowCycleInput | null = null
): Promise<void> {
  // Never let a slow capture overlap the next cycle's — this serializes the
  // scan's Dhan/NSE calls (rate-limit safety). A skipped pass self-heals next
  // cycle (the scan is idempotent; repeats just bump timesSeen).
  const captureStartedMs = Date.now();
  const cycleStart = cycleStartedMs ?? captureStartedMs;
  if (state.captureRunning) {
    state.captureSkips += 1;
    state.lastCapture = {
      cycleStartedAt: new Date(cycleStart).toISOString(),
      captureStartedAt: new Date(captureStartedMs).toISOString(),
      status: 'skipped-overlap',
      tickToCaptureMs: captureStartedMs - cycleStart,
      tickToScanMs: null,
      scanToDecisionMs: null,
      tickToDecisionMs: null,
      redundantReadTools: null,
      detail: 'previous autonomous capture still running',
    };
    console.warn(`${TAG} capture skipped: previous pass still running (total skips ${state.captureSkips})`);
    // Persist the skip too — an overlap streak is exactly the anomaly the
    // /trade-commentary timeline exists to make visible.
    const skipped = startCycleTimeline(today, 'poller', cycleStart);
    skipped.setStatus('skipped-overlap');
    void skipped.finish();
    return;
  }
  state.captureRunning = true;
  // Per-cycle timing: every step's start/end lands in cycle_timelines and is
  // shown on /trade-commentary next to the read this cycle produced.
  const timeline = startCycleTimeline(today, 'poller', cycleStart);
  if (captureStartedMs > cycleStart) {
    timeline.addSpan('waiting: priority candle refresh', cycleStart, captureStartedMs, true);
  }
  const timing: CaptureTiming = {
    cycleStartedAt: new Date(cycleStart).toISOString(),
    captureStartedAt: new Date(captureStartedMs).toISOString(),
    status: 'scan-failed',
    tickToCaptureMs: captureStartedMs - cycleStart,
    tickToScanMs: null,
    scanToDecisionMs: null,
    tickToDecisionMs: null,
    redundantReadTools: null,
    detail: null,
  };
  state.lastCapture = timing;
  const origin = `http://127.0.0.1:${process.env.PORT ?? '5001'}`;
  let allowDisplayRefresh = false;
  try {
    try {
      const { runTradeSuggest } = await import('@/lib/trade-suggest/engine');
      let scanReadyMs = 0;
      const { scan: result, decision } = await runLiveDecisionPath({
        scan: async () => {
          const result = await timeline.step(
            'scan (trade-suggest)',
            () => runTradeSuggest(origin, { candidateSnapshot: candidateSnapshot ?? undefined }),
            (r) => `${r.scanned ?? 0} scanned · ${r.suggestions?.length ?? 0} pick(s)`
          );
          scanReadyMs = Date.now();
          timing.tickToScanMs = scanReadyMs - cycleStart;
          console.log(
            `${TAG} latency: tick→scan ${scanReadyMs - (cycleStartedMs ?? captureStartedMs)}ms (capture→scan ${scanReadyMs - captureStartedMs}ms)`
          );
          return result;
        },
        decide: async (result) => {
          // ONE AI analysis per cycle. The auto-trade pass runs FIRST (lib/auto-trade:
          // deterministic guard, then the decision loop over the SAME scan result);
          // when its read was stored as this cycle's commentary, the standalone MiMo
          // narration is SKIPPED — it only runs as the fallback (auto-trade off /
          // kill switch / nothing to decide / AI failed). Both blocks are isolated:
          // a failure never affects the scan or the recorder.
          let commentaryHandled = false;
          let shadowSafe = false;
          try {
            const { runAutoTradePass } = await import('@/lib/auto-trade/engine');
            const outcome = await runAutoTradePass(result, timeline);
            shadowSafe = outcome.ran;
            const decisionReadyMs = Date.now();
            timing.status = outcome.ran ? (outcome.error ? 'decision-failed' : 'completed') : 'skipped-overlap';
            timing.scanToDecisionMs = decisionReadyMs - scanReadyMs;
            timing.tickToDecisionMs = decisionReadyMs - cycleStart;
            timing.redundantReadTools = outcome.redundantReadTools ?? 0;
            timing.detail = outcome.reason ?? null;
            // Only this process may spend the low-priority Dhan option-chain call
            // after it actually owned and completed the engine pass. If another
            // process owns the pass, its quote lane must remain uncontested.
            allowDisplayRefresh = outcome.ran;
            console.log(
              `${TAG} latency: tick→auto-pass ${decisionReadyMs - (cycleStartedMs ?? captureStartedMs)}ms (scan→decision ${decisionReadyMs - scanReadyMs}ms; ${outcome.reason ?? (outcome.ran ? 'pass ran — action taken' : 'pass skipped')})`
            );
            // A non-running outcome means another in-process/distributed pass owns
            // this cycle. Do not start a second standalone model call alongside it.
            commentaryHandled = outcome.commentaryStored || !outcome.ran;
            if (outcome.ran && (outcome.guardActions.length > 0 || outcome.aiSummary)) {
              console.log(`${TAG} auto-trade: ${outcome.aiSummary?.slice(0, 120) ?? outcome.guardActions.join(' · ')}`);
            }
          } catch (err) {
            timing.status = 'decision-failed';
            timing.detail = (err as Error).message;
            console.warn(`${TAG} auto-trade failed: ${(err as Error).message}`);
          }
          return { commentaryHandled, shadowSafe } satisfies AutonomousDecisionResult;
        },
        afterDecision: (result, decision) => {
          // Queue every shadow read/build/write only after scan + Auto Trade.
          // If another process owns the pass, skip this measurement cycle rather
          // than contend with its money-touching database work.
          if (shadowInput && decision.shadowSafe) void runPostDecisionShadow(shadowInput, result);
        },
      });
      if (!decision.commentaryHandled) {
        try {
          const { runAndStoreCommentary } = await import('@/lib/ai-commentary/run');
          const outcome = await runAndStoreCommentary(result, timeline);
          if (outcome.generated) console.log(`${TAG} AI commentary generated`);
        } catch (err) {
          console.warn(`${TAG} commentary failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      timing.status = 'scan-failed';
      timing.detail = (err as Error).message;
      console.warn(`${TAG} autonomous scan failed: ${(err as Error).message}`);
    }
    // NOTE: EOD bhavcopy is NOT synced here — NSE only publishes it after close,
    // so it runs in runEodCapture() from the post-market branch instead.
  } finally {
    timeline.setStatus(timing.status);
    void timeline.finish();
    state.captureRunning = false;
    // Display-only and deliberately off the decision path. Skip unless this
    // process owned the engine pass, and skip whenever an entry submission or
    // confirmed position bears risk. /live reads only the resulting cache.
    if (allowDisplayRefresh) void refreshDisplayOnlyNiftyContext();
  }
}

async function refreshDisplayOnlyNiftyContext(): Promise<void> {
  try {
    const { getRiskBearingTrades } = await import('@/lib/auto-trade/store');
    if ((await getRiskBearingTrades()).length > 0) return;
    const { refreshNiftyGammaContext } = await import('@/lib/signals/nifty-gamma-context');
    await refreshNiftyGammaContext();
  } catch (err) {
    console.warn(`${TAG} display-only NIFTY context refresh failed: ${(err as Error).message}`);
  }
}

/**
 * Latest weekday strictly before `todayIso` that is not an official NSE
 * holiday — the session whose bhavcopy the overnight sync is expected to have
 * stored. Null when it cannot be determined (10-day walk exhausted).
 */
async function lastExpectedSessionBefore(todayIso: string): Promise<string | null> {
  const d = new Date(`${todayIso}T00:00:00Z`);
  for (let i = 0; i < 10; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    const day = d.getUTCDay();
    if (day === 0 || day === 6) continue;
    const iso = d.toISOString().slice(0, 10);
    try {
      const rows = await prisma.$queryRawUnsafe<unknown[]>(
        `SELECT 1 FROM market_holidays WHERE date = ? LIMIT 1`,
        iso
      );
      if (rows.length > 0) continue;
    } catch {
      // holiday table unreadable — accept the weekday as the expected session
    }
    return iso;
  }
  return null;
}

/**
 * Post-market EOD capture (autonomous server only). NSE publishes the day's
 * bhavcopy overnight, so this runs from the market-closed branch after the
 * publish hour. `lastBhavcopyDate` is only advanced once the sync CONFIRMS the
 * expected session is stored (H4, forensic audit: a bare HTTP 200 with nothing
 * synced used to mark the day done, silently shifting every baseline one
 * session when NSE published late). Until confirmed, it retries at most once
 * an hour — persistent, not a poll. Best-effort; never throws to the poller.
 */
async function runEodCapture(state: PollerState): Promise<void> {
  const istNow = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60_000);
  if (istNow.getHours() < EOD_PUBLISH_HOUR_IST) return;
  const istToday = `${istNow.getFullYear()}-${String(istNow.getMonth() + 1).padStart(2, '0')}-${String(istNow.getDate()).padStart(2, '0')}`;
  if (state.lastBhavcopyDate === istToday) return; // confirmed done for this calendar day
  const RETRY_INTERVAL_MS = 60 * 60_000;
  if (state.lastBhavcopyAttemptMs != null && Date.now() - state.lastBhavcopyAttemptMs < RETRY_INTERVAL_MS) return;
  if (state.captureRunning) return;
  state.captureRunning = true;
  state.lastBhavcopyAttemptMs = Date.now();
  try {
    const origin = `http://127.0.0.1:${process.env.PORT ?? '5001'}`;
    const auth: Record<string, string> = process.env.APP_PASSWORD
      ? {
          Authorization: `Basic ${Buffer.from(`x:${process.env.APP_PASSWORD}`).toString('base64')}`,
        }
      : {};
    const res = await fetch(`${origin}/api/bhavcopy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: '{}',
    });
    if (res.ok) {
      const j = (await res.json().catch(() => ({}))) as {
        status?: { latestDate?: string };
      };
      const latest = j.status?.latestDate ?? null;
      const expected = await lastExpectedSessionBefore(istToday);
      // Confirmed only when the store actually holds the expected session.
      // (expected null = calendar undeterminable — accept the run rather than
      // retry blindly forever.)
      if (expected == null || (latest != null && latest >= expected)) {
        state.lastBhavcopyDate = istToday;
        console.log(`${TAG} EOD bhavcopy sync confirmed (latest ${latest ?? '?'}, expected ${expected ?? '?'})`);
      } else {
        console.warn(
          `${TAG} EOD bhavcopy incomplete: latest stored ${latest ?? 'none'} < expected session ${expected} — retrying in ~1h (NSE may have published late)`
        );
      }
    }
  } catch (err) {
    console.warn(`${TAG} EOD bhavcopy sync failed: ${(err as Error).message}`);
  } finally {
    state.captureRunning = false;
  }
}

/**
 * Nightly master-contracts auto-sync (C3, forensic audit): the Dhan scrip
 * master was previously refreshed only when a human clicked re-sync — expiries
 * rolled out of the table silently (FUT resolution → null, no OI recorded,
 * strikes unfindable). Runs from the market-closed branch after the EOD publish
 * hour so `syncDate` lands on the NEW trading day and `ensureSynced()` passes
 * all day. Marker advances only on success; failures retry at most hourly and
 * alert once per day. forceSync() itself is transactional with a row-count
 * sanity guard, so a crash or a bad CSV can never leave an empty table.
 */
async function runEodMasterContractsSync(state: PollerState): Promise<void> {
  const istNow = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60_000);
  if (istNow.getHours() < EOD_PUBLISH_HOUR_IST) return;
  const istToday = `${istNow.getFullYear()}-${String(istNow.getMonth() + 1).padStart(2, '0')}-${String(istNow.getDate()).padStart(2, '0')}`;
  if (state.lastMasterContractsDate === istToday) return;
  const RETRY_INTERVAL_MS = 60 * 60_000;
  if (state.lastMasterContractsAttemptMs != null && Date.now() - state.lastMasterContractsAttemptMs < RETRY_INTERVAL_MS)
    return;
  state.lastMasterContractsAttemptMs = Date.now();
  try {
    const { forceSync } = await import('@/lib/historify/master-contracts');
    const { count, elapsed } = await forceSync();
    state.lastMasterContractsDate = istToday;
    console.log(`${TAG} nightly master-contracts sync: ${count} rows in ${elapsed}`);
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`${TAG} nightly master-contracts sync failed (retrying in ~1h): ${message}`);
    if (state.lastMasterContractsAlertDate !== istToday) {
      state.lastMasterContractsAlertDate = istToday;
      try {
        const { sendAlert } = await import('@/lib/auto-trade/alerts');
        sendAlert(`⚠️ Nightly master-contracts sync failed: ${message.slice(0, 200)}`);
      } catch {
        // alerting is best-effort
      }
    }
  }
}

/**
 * Same-evening trade-suggest scorecard (Railway-only). After market close, grade
 * the day's /trade-suggest picks against the recorded 5-min candles (review.ts).
 * Reads local fyers_candles only — no broker/AI call, no cost — and runs ONCE per
 * calendar day (marker), gated to after 16:00 IST so the closing bar is in. With
 * the 20-session candle retention this no longer has to beat same-day pruning,
 * but running it the same evening keeps /trade-suggest/history accurate that night.
 * Best-effort; never throws to the poller. Idempotent — a re-run just re-grades.
 */
async function runEodScorecard(state: PollerState): Promise<void> {
  const istNow = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60_000);
  if (istNow.getHours() < 16) return; // after the 15:30 close, closing bar recorded
  const istToday = `${istNow.getFullYear()}-${String(istNow.getMonth() + 1).padStart(2, '0')}-${String(istNow.getDate()).padStart(2, '0')}`;
  if (state.lastScorecardDate === istToday) return; // already graded once today
  try {
    const { reviewed, skipped } = await reviewToday();
    state.lastScorecardDate = istToday;
    console.log(`${TAG} EOD scorecard ran (${reviewed} graded, ${skipped} skipped)`);
  } catch (err) {
    console.warn(`${TAG} EOD scorecard failed: ${(err as Error).message}`);
  }
}

/** Pre-open warm-up window (IST minutes): tokens exist well before 09:00. At
 *  09:15 isMarketHours() flips true and the market-closed branch stops running,
 *  so the upper bound is doubly enforced. */
const WARM_START_MIN = 8 * 60 + 40;
const WARM_END_MIN = 9 * 60 + 15;

/** True when `ist` (a Date whose LOCAL components are the IST wall clock, e.g.
 *  from nowIST()) is a weekday inside [08:40, 09:15). Pure + testable; the
 *  holiday check (async DB) is applied separately by warmPreOpenTokens. */
export function inWarmupClockWindow(ist: Date): boolean {
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const minute = ist.getHours() * 60 + ist.getMinutes();
  return minute >= WARM_START_MIN && minute < WARM_END_MIN;
}

/**
 * Pre-open token warm-up — mint/refresh BOTH broker tokens (Fyers TOTP chain,
 * Dhan TOTP/renew chain) on the off-hours ticks between 08:40 and 09:15 IST on
 * trading days, so they exist before the open with no page ever opened.
 *
 * No per-day marker on purpose: both getters return their cached token
 * instantly while it's valid, so every tick in the window is a FREE retry after
 * a transient failure (7 attempts, 5 min apart — comfortably over Dhan's ~2-min
 * generation limit). One provider failing never blocks the other. Runs in every
 * environment (not Railway-gated): the calls are idempotent and dev needs the
 * same tokens anyway. Never throws to the poller.
 *
 * `force` (the poller route's 'warm-tokens' action) bypasses the day/window
 * checks — the deterministic test/ops hook — but never the credential checks.
 */
async function warmPreOpenTokens(state: PollerState, force = false): Promise<void> {
  if (!force) {
    if (!inWarmupClockWindow(nowIST())) return;
    if (await isMarketHoliday(todayIST())) return;
  }
  if (state.warmupRunning) return;
  state.warmupRunning = true;
  try {
    let fyers = 'no-credentials';
    if (hasFyersAuth()) {
      try {
        await getFyersAccessToken();
        fyers = 'ok';
      } catch (err) {
        fyers = `error: ${(err as Error).message.slice(0, 160)}`;
      }
    }
    let dhan = 'no-credentials';
    if (hasDhanAuth()) {
      try {
        await getDhanAccessToken();
        dhan = 'ok';
      } catch (err) {
        dhan = `error: ${(err as Error).message.slice(0, 160)}`;
      }
    }
    state.lastWarmup = { date: todayIST(), at: Date.now(), fyers, dhan };
    console.log(`${TAG} pre-open token warm-up: fyers=${fyers} dhan=${dhan}`);
  } finally {
    state.warmupRunning = false;
  }
}

/** Manual warm-up trigger (POST /api/fyers/poller {action:'warm-tokens'}). */
export async function runTokenWarmup(): Promise<void> {
  await warmPreOpenTokens(getState(), true);
}

const DRIFT_MARKER = 'config-drift-reminder';
const DRIFT_LEASE = 'config-drift-reminder';

/**
 * Config-drift reminder (AT-review 2026-07-20 op-fix; hardened per PR#2 review).
 * Any scanner setting left off its coded-safe default — the toggle OR a numeric
 * like WINDOW_END_MIN (the USE_EXTENDED_TREND_BYPASS drift that caused the
 * COLPAL 2026-07-20 loss sat unnoticed for 10 days) — is pushed once per trading
 * day so a forgotten override keeps nagging instead of going silent. Complements
 * the immediate on-change alert in setToggle/setNumberSetting.
 *
 * This is the THIN wrapper: cheap gates (autonomous, window, in-memory cache,
 * holiday) + real deps → runConfigDriftReminderCore (the pure, unit-tested
 * decide-and-act in lib/config/config-drift-reminder.ts). Correctness (PR#2
 * review):
 *  - once-per-day is a PERSISTENT marker (runtime_daily_markers), so a restart
 *    mid-session can't resend; the in-memory field is only a fast-path cache;
 *  - a dedicated runtime LEASE serialises the send (this path can run BEFORE the
 *    poller's own POLLER_LEASE), so overlapping deploy processes can't both fire;
 *  - the marker is set ONLY after CONFIRMED delivery, and markToday reports
 *    whether it actually persisted — a failed read/send/write retries next tick;
 *  - the window spans 08:40–15:30 (market close), so a late start with
 *    SCAN_OUTSIDE_WINDOW ON (which can trade past 11:00) still gets alerted.
 *  Autonomous-server only, like the sibling EOD jobs. Callable from both the
 *  market-closed and market-open paths — the guards make it idempotent. Never
 *  throws to the poller.
 */
async function runConfigDriftReminder(state: PollerState): Promise<void> {
  if (!isAutonomousServer()) return;
  if (!inDriftReminderWindow(nowIST())) return;
  const today = todayIST();
  if (state.lastConfigDriftAlertDate === today) return; // fast in-memory path
  if (await isMarketHoliday(today)) return;

  const { tradeSuggestConfigOverrideSummary } = await import('@/lib/config/feature-toggles');
  const { sendMessageAsync } = await import('@/lib/telegram');
  const outcome = await runConfigDriftReminderCore({
    wasMarked: () => wasMarkedToday(DRIFT_MARKER, today),
    acquireLease: () => tryAcquireRuntimeLease(DRIFT_LEASE, 120_000),
    releaseLease: () => releaseRuntimeLease(DRIFT_LEASE),
    getOverrides: tradeSuggestConfigOverrideSummary,
    send: async (message) => {
      const r = await sendMessageAsync(message);
      return { ok: r.ok, error: r.error };
    },
    mark: () => markToday(DRIFT_MARKER, today),
  });

  if (outcome.completedToday) state.lastConfigDriftAlertDate = today;
  if (outcome.status === 'sent' && !outcome.markedPersisted)
    console.warn(`${TAG} config-drift reminder delivered but marker not persisted — a restart today could resend once`);
  else if (outcome.status === 'send-failed')
    console.warn(`${TAG} config-drift reminder delivery failed (will retry next tick): ${outcome.message ?? 'unknown'}`);
  else if (outcome.status === 'error')
    console.warn(`${TAG} config-drift reminder failed (will retry next tick): ${outcome.message}`);
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
  // Dev kill switch: local + prod pollers share one Fyers account and their
  // aligned 5-min bursts collide on the same rate limit. With the poller off,
  // dev still works — candles come from db:pull-prod, tokens mint lazily.
  if (process.env.FYERS_POLLER_DISABLED === 'true') {
    console.log(`${TAG} DISABLED via FYERS_POLLER_DISABLED — no Fyers downloads from this machine`);
    return;
  }
  const state = getState();
  if (state.started) return;
  state.started = true;
  state.startedAt = Date.now();
  scheduleNextTick();
  console.log(
    `${TAG} started — next tick ${state.nextTickAt ? new Date(state.nextTickAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) : '?'} IST` +
      (hasFyersAuth() ? '' : ' (Fyers credentials NOT configured — cycles will skip)')
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
  captureRunning: boolean;
  captureSkips: number;
  lastCapture: CaptureTiming | null;
  marketOpen: boolean;
  credentialsConfigured: boolean;
  token: { cached: boolean; expiresAt: number | null };
  universe: { date: string; symbols: string[] } | null;
  /** Latest pre-open token warm-up outcome (see warmPreOpenTokens). */
  lastWarmup: { date: string; at: number; fyers: string; dhan: string } | null;
  /** Last date the pre-open config-drift reminder ran (see runConfigDriftReminder). */
  lastConfigDriftAlertDate: string | null;
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
    captureRunning: state.captureRunning,
    captureSkips: state.captureSkips,
    lastCapture: state.lastCapture,
    marketOpen: isMarketHours(),
    credentialsConfigured: hasFyersAuth(),
    token: getFyersTokenStatus(),
    universe: peekUniverse(),
    lastWarmup: state.lastWarmup,
    lastConfigDriftAlertDate: state.lastConfigDriftAlertDate,
  };
}
