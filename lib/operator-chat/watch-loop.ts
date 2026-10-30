/**
 * Commentary v2 watch loop — the "continuous connection". Every WATCH_TICK_MS during market hours it
 * evaluates the day's watches (pure watches.ts over SQLite reads, no broker calls), marks fired ones,
 * and wakes the chat AI for ONE turn per batch (wake.ts).
 *
 * Rules it keeps:
 *  - Only on the autonomous server (same gate as the trader), one process (runtime lease).
 *  - Only while the Background switch is ON.
 *  - Never wakes the AI while the auto-trade pass or the poller's autonomous capture is running —
 *    one AI analysis at a time. It waits; it never takes the engine lease, so the trader is never
 *    skipped because of a wake-up.
 *  - The queue is DURABLE: "fired but no wake-up yet" is derived from chat_watches + chat_wakeups, so
 *    a restart can't lose a fired watch.
 */

import { isAutoTradePassRunning } from '@/lib/auto-trade/engine';
import { minuteOfDayIST } from '@/lib/ist';
import { isMarketHours, todayIST } from '@/lib/market-data';
import { tryAcquireRuntimeLease } from '@/lib/runtime/lease';
import {
  closeWatch,
  isBackgroundEnabled,
  isV2Selected,
  listWakeups,
  listWatches,
  getNextCheckAt,
  noteWatchCheck,
  recordWakeup,
  type WakeupRow,
} from './background-store';
import { loadWatchInputs } from './watch-inputs';
import { evaluateWatch, wakeBudget, WATCH_EXPIRY_MIN } from './watches';
import { HEARTBEAT_MIN_MIN, HEARTBEAT_START_MIN, MAX_HEARTBEATS_PER_DAY } from './heartbeat';
import { openPositionSymbols, runHeartbeatTurn, runWakeTurn } from './wake';

const TAG = '[chat-watch]';
export const WATCH_TICK_MS = 60_000;
const LEASE = 'chat-watch-loop';
/** A fired watch that waited longer than this (v2 paused, trader busy) is skipped — no AI call: the moment
 *  has passed, and narrating an old event is not worth the tokens. Recorded, so the panel shows why. */
const STALE_WAKE_MS = 15 * 60_000;

export type WatchLoopStatus =
  | 'starting'
  | 'not-autonomous-server'
  | 'off'
  | 'v1-selected'
  | 'market-closed'
  | 'not-leader'
  | 'idle'
  | 'checked'
  | 'waiting-for-trader'
  | 'spacing'
  | 'woke'
  | 'checked-in'
  | 'error';

interface LoopState {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  startedAt: string | null;
  lastTick: { at: string; status: WatchLoopStatus; detail: string | null; ms: number } | null;
}

function state(): LoopState {
  const g = globalThis as unknown as { __chatWatchLoop?: LoopState };
  g.__chatWatchLoop ??= { timer: null, running: false, startedAt: null, lastTick: null };
  return g.__chatWatchLoop;
}

/** Mirrors the poller's gate (lib/fyers/poller.ts) — dev laptops never run autonomous jobs. */
function isAutonomousServer(): boolean {
  return process.env.AUTONOMOUS_SERVER === 'true' || Boolean(process.env.RAILWAY_ENVIRONMENT_NAME);
}

async function traderBusy(): Promise<boolean> {
  if (isAutoTradePassRunning()) return true;
  try {
    const { getFyersPollerStatus } = await import('@/lib/fyers/poller');
    return getFyersPollerStatus().captureRunning;
  } catch {
    return false;
  }
}

async function tick(): Promise<{ status: WatchLoopStatus; detail: string | null }> {
  if (!isAutonomousServer()) return { status: 'not-autonomous-server', detail: 'set AUTONOMOUS_SERVER=true to run watches' };
  const date = todayIST();
  const nowMin = minuteOfDayIST();

  // Expiry runs even after the close so nothing stays "watching" overnight.
  if (nowMin >= WATCH_EXPIRY_MIN) {
    const open = (await listWatches(date)).filter((w) => w.status === 'watching');
    for (const w of open) await closeWatch(w.id, 'expired', 'market closed (15:30 IST)');
    return { status: 'market-closed', detail: open.length ? `expired ${open.length}` : null };
  }
  // One version at a time: with v1 selected in /config, v2's watcher does nothing at all.
  if (!(await isV2Selected())) return { status: 'v1-selected', detail: 'v1 is the selected AI Analysis page' };
  if (!(await isBackgroundEnabled())) return { status: 'off', detail: null };
  if (!isMarketHours()) return { status: 'market-closed', detail: null };
  if (!(await tryAcquireRuntimeLease(LEASE, 2 * WATCH_TICK_MS))) return { status: 'not-leader', detail: null };

  const watches = await listWatches(date);
  const active = watches.filter((w) => w.status === 'watching');
  let firedNow = 0;
  if (active.length > 0) {
    const inputs = await loadWatchInputs(date, {
      symbols: active.map((w) => w.params.symbol).filter((s): s is string => Boolean(s)),
      kinds: active.map((w) => w.kind),
    });
    for (const w of active) {
      // Self-healing: one bad watch (corrupt params, a DB hiccup) is logged and skipped — it never stops
      // the other watches; the next tick tries it again.
      try {
        const v = evaluateWatch(w.kind, w.params, inputs);
        if (v.fired === true) {
          if (await closeWatch(w.id, 'fired', v.note)) firedNow += 1;
        } else if (v.dead) {
          await closeWatch(w.id, 'expired', v.note);
        } else {
          await noteWatchCheck(w.id, v.fired === null ? `can't check: ${v.note}` : v.note);
        }
      } catch (err) {
        console.warn(`${TAG} watch #${w.id} check failed (retried next tick): ${(err as Error).message}`);
      }
    }
  }

  // Durable queue: fired watches no wake-up has covered yet (re-read — some just fired).
  const wakeups = await listWakeups(date);
  const covered = new Set(wakeups.flatMap((w) => w.watchIds));
  const fired = (await listWatches(date)).filter((w) => w.status === 'fired' && !covered.has(w.id));
  const now = Date.now();
  const stale = fired.filter((w) => w.firedAt != null && now - new Date(w.firedAt).getTime() > STALE_WAKE_MS);
  if (stale.length > 0) {
    await recordWakeup({
      date,
      watchIds: stale.map((w) => w.id),
      outcome: 'capped',
      messageId: null,
      detail: 'fired over 15 min ago (v2 paused or trader busy) — skipped, no AI call',
    });
  }
  const pending = fired.filter((w) => !stale.includes(w));
  if (pending.length === 0) {
    // No watch to answer — is the AI's own self-paced check-in due?
    const hb = await maybeHeartbeat(date, nowMin, wakeups);
    if (hb) return hb;
    return { status: active.length ? 'checked' : 'idle', detail: `${active.length} active` };
  }
  if (await traderBusy()) return { status: 'waiting-for-trader', detail: `${pending.length} fired, waiting` };
  const budget = wakeBudget(wakeups, Date.now());
  if (!budget.allowed && budget.reason === 'spacing') {
    return { status: 'spacing', detail: `${pending.length} fired, next wake-up ≥ 5 min after the last` };
  }
  await runWakeTurn(
    date,
    pending.map((w) => ({ id: w.id, label: w.label, note: w.firedDetail ?? '' })),
    budget
  );
  return { status: 'woke', detail: `${pending.length} watch(es)${firedNow ? `, ${firedNow} just fired` : ''}` };
}

/**
 * The self-paced check-in (heartbeat.ts): due when the time the AI chose has passed (or none is set), from
 * HEARTBEAT_START_MIN, at most MAX_HEARTBEATS_PER_DAY a day, never while the trader runs. Null = not now.
 */
async function maybeHeartbeat(
  date: string,
  nowMin: number,
  wakeups: readonly WakeupRow[]
): Promise<{ status: WatchLoopStatus; detail: string | null } | null> {
  if (nowMin < HEARTBEAT_START_MIN) return null;
  const done = wakeups.filter((w) => w.kind === 'heartbeat').length;
  if (done >= MAX_HEARTBEATS_PER_DAY) return null;
  const next = await getNextCheckAt();
  const lastAt = [...wakeups].reverse().find((w) => w.kind === 'heartbeat')?.at;
  const sinceLastMs = lastAt ? Date.now() - new Date(lastAt).getTime() : Infinity;
  // An open position overrides the AI's chosen time: it is reviewed every HEARTBEAT_MIN_MIN minutes.
  const positionOpen = (await openPositionSymbols(date)).length > 0;
  const dueByPosition = positionOpen && sinceLastMs >= HEARTBEAT_MIN_MIN * 60_000;
  if (!dueByPosition && next && new Date(next).getTime() > Date.now()) return null;
  if (sinceLastMs < HEARTBEAT_MIN_MIN * 60_000) return null; // never closer than 5 min
  if (await traderBusy()) return { status: 'waiting-for-trader', detail: 'check-in due, waiting for the trader' };
  const outcome = await runHeartbeatTurn(date);
  return { status: 'checked-in', detail: `check-in #${done + 1}: ${outcome}` };
}

async function loop(): Promise<void> {
  const s = state();
  if (s.running) return;
  s.running = true;
  const started = Date.now();
  let status: WatchLoopStatus = 'error';
  let detail: string | null = null;
  try {
    ({ status, detail } = await tick());
    if (status === 'woke' || status === 'checked-in') console.log(`${TAG} ${status === 'woke' ? 'woke the chat AI' : 'self-paced check-in'} — ${detail}`);
  } catch (err) {
    detail = (err as Error).message;
    console.warn(`${TAG} tick failed: ${detail}`);
  } finally {
    s.lastTick = { at: new Date().toISOString(), status, detail, ms: Date.now() - started };
    s.running = false;
    s.timer = setTimeout(() => void loop(), WATCH_TICK_MS);
  }
}

/** Start the loop (idempotent — instrumentation.ts calls it once per boot). */
export function startWatchLoop(): void {
  const s = state();
  if (s.timer || s.running) return;
  s.startedAt = new Date().toISOString();
  s.timer = setTimeout(() => void loop(), WATCH_TICK_MS);
  console.log(`${TAG} started — watches checked every ${WATCH_TICK_MS / 1000}s when Background is ON`);
}

export function getWatchLoopStatus(): {
  startedAt: string | null;
  autonomous: boolean;
  tickMs: number;
  lastTick: LoopState['lastTick'];
} {
  const s = state();
  return { startedAt: s.startedAt, autonomous: isAutonomousServer(), tickMs: WATCH_TICK_MS, lastTick: s.lastTick };
}
