/**
 * Fast position-guard loop — the 5-second safety net BETWEEN the poller's
 * 5-minute passes. Fully headless: started once per server boot from
 * instrumentation.ts (same pattern as the Fyers poller), no page ever needs
 * to be open.
 *
 * WHY: the deterministic position guard (risk/position-guard.ts) used to run
 * only at the start of each 5-min engine pass — an open position could sit
 * through its premium stop for up to ~5 minutes before code reacted. This
 * loop re-runs THE SAME guard every FAST_GUARD_TICK_MS whenever positions are
 * open. The timer targets a 5-second cadence, but process scheduling, quote
 * latency and restarts can add drift; heartbeat state records reality.
 *
 * WHAT IT DOES NOT CHANGE:
 *  - It NEVER places entries. Entry-off and the kill switch do not disable
 *    reconciliation or exits because those actions only reduce risk.
 *  - Rate limits: all open option contracts share one batched request through
 *    the serial Dhan quote gate (lib/dhan/market-feed.ts), so the loop adds at
 *    most one quote call/tick. Spot stops still read the 5-min
 *    fyers_candles close (that's the recorder's granularity); the fast win is
 *    the PREMIUM stop/target, which uses a live quote.
 *  - Process-local overlap: skips its tick while a full engine pass is running
 *    (isAutoTradePassRunning) or while a previous tick is still in flight.
 *    Across rolling replicas, DB leases select one fast-guard leader and
 *    atomic order claims remain the final duplicate-order backstop.
 *
 * State lives on globalThis — Turbopack HMR re-evaluates modules and a
 * module-level timer would duplicate the loop on every hot reload (same
 * rationale as lib/fyers/poller.ts).
 */

import { isMarketHours, todayIST } from '@/lib/dhan/market-feed';
import { tryAcquireRuntimeLease } from '@/lib/runtime/lease';
import { FAST_GUARD_TICK_MS } from './config';
import { isAutoTradePassRunning } from './engine';
import { reconcileOpenPositions, reconcileUnresolvedOrders } from './execution';
import { syncFyersPnlStream } from './fyers-pnl-stream';
import { getGuardHealth, runPositionGuard, type GuardHealth } from './risk/position-guard';
import { getOpenTrades, getUnresolvedOrders, insertDecision } from './store';

const TAG = '[FastGuard]';

interface GuardLoopState {
  started: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  tickRunning: boolean;
  ticks: number;
  /** Last tick that actually ran the guard (had open positions, market open). */
  lastActive: { at: string; openTrades: number; actions: string[] } | null;
  lastTick: {
    at: string;
    status:
      | 'market-closed'
      | 'full-pass-running'
      | 'no-open-positions'
      | 'guard-ran'
      | 'error'
      | 'overlap'
      | 'not-leader';
    durationMs: number;
    openTrades: number;
    reconcileNotes: number;
    error: string | null;
  } | null;
}

const g = globalThis as unknown as { __autoTradeGuardLoop?: GuardLoopState };

function getState(): GuardLoopState {
  g.__autoTradeGuardLoop ??= {
    started: false,
    timer: null,
    tickRunning: false,
    ticks: 0,
    lastActive: null,
    lastTick: null,
  };
  return g.__autoTradeGuardLoop;
}

async function tick(): Promise<void> {
  const state = getState();
  if (state.tickRunning) {
    state.lastTick = {
      at: new Date().toISOString(),
      status: 'overlap',
      durationMs: 0,
      openTrades: 0,
      reconcileNotes: 0,
      error: null,
    };
    return;
  }
  const startedAt = Date.now();
  let status: NonNullable<GuardLoopState['lastTick']>['status'] = 'error';
  let openTrades = 0;
  let reconcileNoteCount = 0;
  let error: string | null = null;
  state.tickRunning = true;
  try {
    state.ticks += 1;
    if (!(await tryAcquireRuntimeLease('fast-position-guard', 2 * 60_000))) {
      status = 'not-leader';
      return;
    }
    if (isAutoTradePassRunning()) {
      status = 'full-pass-running';
      return;
    }
    // Reconciliation and exits reduce risk and remain active even when fresh
    // entries are disabled. This also recovers acknowledgements after restart.
    const unresolved = await getUnresolvedOrders();
    if (unresolved.length > 0) {
      const reconcileNotes = await reconcileUnresolvedOrders();
      reconcileNoteCount = reconcileNotes.length;
      if (reconcileNotes.length > 0) console.warn(`${TAG} ${reconcileNotes.join(' · ')}`);
    }
    // Stale-row cleanup (date check only — no broker call): a next-morning
    // restart must close yesterday's ghost 'open' rows BEFORE any stop can
    // trip a SELL on a position the broker already squared off. The full
    // broker-verified check runs on the 5-min engine pass.
    const staleNotes = await reconcileOpenPositions();
    if (staleNotes.length > 0) console.warn(`${TAG} ${staleNotes.join(' · ')}`);
    // Broker acknowledgement may arrive just after the bell. Continue
    // reconciling unresolved submissions off-hours, but do not quote/guard
    // ordinary positions outside market hours.
    if (!isMarketHours()) {
      void syncFyersPnlStream([]).catch((err) =>
        console.warn(`${TAG} P&L stream unsubscribe failed: ${(err as Error).message}`)
      );
      status = 'market-closed';
      return;
    }
    const open = await getOpenTrades(); // local SQLite — cheap every tick
    openTrades = open.length;
    // FYERS WebSocket P&L plus validated target fast path. Never await socket
    // auth/reconnect here: it must not delay the deterministic REST fallback.
    void syncFyersPnlStream(open).catch((err) =>
      console.warn(`${TAG} P&L stream sync failed: ${(err as Error).message}`)
    );
    if (open.length === 0) {
      status = 'no-open-positions';
      return;
    }

    const date = todayIST();
    const guard = await runPositionGuard(date);
    const { actions } = guard;
    status = 'guard-ran';
    state.lastActive = {
      at: new Date().toISOString(),
      openTrades: open.length,
      actions,
    };
    // The caller that started the shared guard owns its audit row. A coalesced
    // fast tick is already being audited by the full engine pass it joined.
    if (actions.length > 0 && !guard.coalesced) {
      console.log(`${TAG} ${actions.join(' · ')}`);
      // Same audit trail as the engine's guard step, tagged so /auto-trade
      // history shows which cadence caught it. Best-effort — an audit hiccup
      // must never undo the protective exit that already happened.
      try {
        await insertDecision({
          date,
          pass: 'guard',
          provider: null,
          model: null,
          summary: `[fast-guard] ${actions.join(' · ')}`,
          toolTrace: [],
          promptTokens: null,
          completionTokens: null,
        });
      } catch (err) {
        console.warn(`${TAG} audit insert failed: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    status = 'error';
    error = (err as Error).message;
    console.warn(`${TAG} tick failed: ${(err as Error).message}`);
  } finally {
    const s = getState();
    s.lastTick = {
      at: new Date().toISOString(),
      status,
      durationMs: Date.now() - startedAt,
      openTrades,
      reconcileNotes: reconcileNoteCount,
      error,
    };
    s.tickRunning = false;
    s.timer = setTimeout(() => void tick(), FAST_GUARD_TICK_MS);
  }
}

/** Start the loop (idempotent — instrumentation.ts calls this once per boot). */
export function startGuardLoop(): void {
  const state = getState();
  if (state.started) return;
  state.started = true;
  state.timer = setTimeout(() => void tick(), FAST_GUARD_TICK_MS);
  console.log(
    `${TAG} started — open positions re-checked every ${Math.round(FAST_GUARD_TICK_MS / 1000)}s during market hours`
  );
}

/** Status for ops/diagnostics (surfaced via GET /api/auto-trade). */
export function getGuardLoopStatus(): {
  started: boolean;
  ticks: number;
  lastActive: GuardLoopState['lastActive'];
  lastTick: GuardLoopState['lastTick'];
  /** Quote-sight health of the deterministic guard (AT-005). */
  health: GuardHealth;
} {
  const s = getState();
  return {
    started: s.started,
    ticks: s.ticks,
    lastActive: s.lastActive,
    lastTick: s.lastTick,
    health: getGuardHealth(),
  };
}
