/**
 * Auto-trade constants — the compile-time defaults and code-enforced limits.
 *
 * Runtime-selectable values (mode, broker, AI provider, caps, and — since
 * 2026-07-15, at the user's request — the entry window + square-off times)
 * live in settings.ts and are seeded from the DEFAULT_SETTINGS below. Every
 * runtime value is CLAMPED by the settings registry and enforced in code
 * (gates/guard), never by the AI. The remaining constants (slippage, spread,
 * fill polling) stay compile-time safety rails, changed only with a code
 * review.
 */

import { MAX_LOSS_PER_LOT_RUPEES, TF_LOT_TARGET_RUPEES } from '@/lib/trade-suggest/config';
import { nowIST, minuteOfDayIST, nowISTClock } from '@/lib/ist';
import type { AutoTradeSettings } from './types';

/** ₹ risk/reward anchors per lot — the SAME numbers the scanner plans with
 *  (user rules: max loss ₹1.5k/lot, target ₹5k/lot). Used to re-anchor the
 *  premium backstops to the actual fill price. */
export const MAX_LOSS_PER_LOT_FALLBACK = MAX_LOSS_PER_LOT_RUPEES;
export const TARGET_PER_LOT_FALLBACK = TF_LOT_TARGET_RUPEES;

/** Seed values for the runtime settings store (settings.ts). Mode starts OFF —
 *  the operator must explicitly select paper/approval/live on /auto-trade. */
export const DEFAULT_SETTINGS: AutoTradeSettings = {
  mode: 'off',
  broker: 'fyers',
  aiProvider: 'azure',
  killSwitch: false,
  maxTradesPerDay: 2, // user rule: max 2 real trades a day
  maxOpenLots: 2, // user rule: max 2 lots at once
  maxCapitalRupees: 60_000, // user rule: ₹50–60k account — ₹-cap on deployed premium
  dailyLossHaltRupees: 3_000, // 2 × the ₹1.5k/lot max loss — then stop for the day
  approvalTtlMin: 15, // a pending approval is stale after 3 poller cycles
  telegramAlerts: true, // send auto-trade alerts + commentary to Telegram
  entryStartMin: 9 * 60 + 45, // user rule: entries 09:45–11:00 IST
  entryEndMin: 11 * 60,
  squareOffMin: 15 * 60 + 12, // forced square-off 15:12, ahead of broker cutoffs
};

/** Entry window (IST minutes from midnight): 09:45–11:00 per the user's rule.
 *  place_entry_order is REJECTED outside this window; exits are allowed any
 *  time the market is open. (Scanner window is 09:40–11:00 — entries start 5
 *  minutes later so the first picks have one settled cycle behind them.)
 *  These are the DEFAULTS — the effective bounds come from settings
 *  (entryStartMin/entryEndMin, clamped in settings.ts) via the callers. */
export const ENTRY_START_MIN = DEFAULT_SETTINGS.entryStartMin;
export const ENTRY_END_MIN = DEFAULT_SETTINGS.entryEndMin;
export const ENTRY_WINDOW_LABEL = {
  opensAt: '09:45 IST',
  closesAt: '11:00 IST',
};

/** "HH:MM IST" for an IST minute-of-day — window labels in gate messages. */
export function istMinuteLabel(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')} IST`;
}

/** Code-enforced end of day: the position guard attempts to exit every open
 *  position at/after this IST minute regardless of the AI. The fast guard and
 *  later poller cycles retry explicit failures; unresolved submissions remain
 *  blocked for broker reconciliation. The effective value is
 *  settings.squareOffMin (clamped ≤ 15:20). */
export const SQUARE_OFF_MIN = DEFAULT_SETTINGS.squareOffMin;

/** Reject an entry when the fresh premium quote has moved more than this %
 *  from the scanner's quote this cycle (the AI decided on stale numbers). */
export const MAX_ENTRY_SLIPPAGE_PCT = 4;

/** Reject an entry when the option's bid-ask spread exceeds this %.
 *  Deep OTM illiquid options can have ₹0.10 bid / ₹5.00 ask — instant
 *  ~100% loss on fill. The scanner already flags liquidityWarning but the
 *  gate must enforce it. */
export const MAX_SPREAD_PCT = 8;

/** How long to poll a live broker order for a fill before leaving it to the
 *  next cycle's reconcile step (MARKET orders on liquid near-ATM strikes fill
 *  in seconds; anything slower is investigated, not assumed). */
export const FILL_POLL_ATTEMPTS = 3;
export const FILL_POLL_DELAY_MS = 2_000;

/** Per-pass ceiling on AI tool steps (mirrors lib/ai-assistant's cap). */
export const MAX_TOOL_STEPS = 10;

/**
 * Fast guard loop cadence (lib/auto-trade/guard-loop.ts). Between the poller's
 * 5-min passes, OPEN positions get their premium stop/target re-checked every
 * this-many ms (all open contracts are batched into at most one live Dhan
 * quote request per active tick). The target
 * cadence is 60 seconds; the guard heartbeat reports actual scheduling and
 * quote latency. Deterministic code only — no AI in this loop.
 */
export const FAST_GUARD_TICK_MS = 60_000;

export { nowIST, minuteOfDayIST, nowISTClock };

export function isEntryWindow(minute = minuteOfDayIST(), startMin = ENTRY_START_MIN, endMin = ENTRY_END_MIN): boolean {
  return minute >= startMin && minute <= endMin;
}

export function isPastSquareOff(minute = minuteOfDayIST(), squareOffMin = SQUARE_OFF_MIN): boolean {
  return minute >= squareOffMin;
}
