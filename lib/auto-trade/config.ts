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

import { MAX_LOSS_PER_LOT_RUPEES } from '@/lib/trade-suggest/config';
import { nowIST, minuteOfDayIST, nowISTClock } from '@/lib/ist';
import type { AutoTradeSettings } from './types';

/** ₹ risk anchor per lot. The live profit target is a separate runtime policy
 * because the scanner's wider spot plan is context, not a fixed cash exit. */
export const MAX_LOSS_PER_LOT_FALLBACK = MAX_LOSS_PER_LOT_RUPEES;

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
  profitTargetMode: 'per_trade', // fixed cash profit for the whole position
  profitTargetRupees: 1_100, // requested default; editable without a redeploy
  maxSpreadPct: 3, // option bid-ask ceiling — see MAX_SPREAD_PCT below for the evidence
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

/** Reject an entry when the option's bid-ask spread exceeds this % (DEFAULT —
 *  the effective value is settings.maxSpreadPct, tunable on /auto-trade).
 *  The spread is instant market-order slippage: half is paid at each fill, so
 *  an 8% ceiling allowed up to ~₹1,600 round-trip bleed on a ₹20k lot — more
 *  than the ₹1.5k max loss. Evidence for 3 (decision traces, 2026-07-16):
 *  SIEMENS 3750CE surfaced at 5.5% and 3.0% spread and only the AI's judgment
 *  refused it — the old 8% code gate would have passed both, violating "the
 *  AI proposes, code disposes". Every actual entry (HYUNDAI/MANKIND/
 *  PATANJALI/SRF) fired no liquidity warning (≤2%), so 3 blocks the junk
 *  without touching a single real trade. Scanner warns at 2 (MAX_OPT_SPREAD_PCT)
 *  → gate blocks above 3: warn first, then enforce. */
export const MAX_SPREAD_PCT = DEFAULT_SETTINGS.maxSpreadPct;

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
 * quote request per active tick, through the shared serial quote gate).
 * 5 seconds (was 60; tightened after the 2026-07-22 live-loss review): a one-minute window on
 * an intraday option stop was a material chunk of the risk budget. This is a
 * TARGET cadence, not an exit-latency guarantee — the guard heartbeat reports
 * actual scheduling and quote latency. Deterministic code only — no AI here.
 */
export const FAST_GUARD_TICK_MS = 5_000;

/** place_entry_order demands a check_order ALLOW for the SAME symbol within
 *  this window (AT-006: the check-then-place workflow is code-enforced, not
 *  prompt-enforced). Placement still re-runs every gate regardless. */
export const CHECK_ORDER_TTL_MS = 2 * 60_000;

/**
 * Freshness ceiling for the fill-time entry SHADOW metrics (AT-review
 * 2026-07-20). The generic SPOT_FRESH_MAX_AGE_MS (15 min) exists so a stalled
 * recorder can't drive a live stop — it is deliberately loose. Entry
 * calibration (change-from-open, progressR, forwardRR, re-anchor) needs a much
 * tighter window: the recorder ticks every 5 min, so a healthy just-completed
 * candle is 5–10 min old (age = now − bucketStart). 11 minutes accepts that
 * healthy window with a minute of jitter but REJECTS a read that is already a
 * full recorder interval behind (~14 min = one missed candle) — that stale a
 * sample must not masquerade as the entry observation. Measurement only; when a
 * fill's spot is older than this the R/chg metrics are recorded null, never
 * fabricated. */
export const ENTRY_METRIC_MAX_AGE_MS = 11 * 60_000;

export { nowIST, minuteOfDayIST, nowISTClock };

export function isEntryWindow(minute = minuteOfDayIST(), startMin = ENTRY_START_MIN, endMin = ENTRY_END_MIN): boolean {
  return minute >= startMin && minute <= endMin;
}

export function isPastSquareOff(minute = minuteOfDayIST(), squareOffMin = SQUARE_OFF_MIN): boolean {
  return minute >= squareOffMin;
}
