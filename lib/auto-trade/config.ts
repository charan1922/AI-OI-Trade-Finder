/**
 * Auto-trade constants — the compile-time defaults and code-enforced limits.
 *
 * Runtime-selectable values (mode, broker, AI provider, caps) live in
 * settings.ts and are seeded from the DEFAULT_SETTINGS below; the constants
 * further down (window bounds, square-off, slippage) are deliberately NOT
 * runtime-editable — they are safety rails, changed only with a code review.
 */

import { MAX_LOSS_PER_LOT_RUPEES, TF_LOT_TARGET_RUPEES } from '@/lib/trade-suggest/config';
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
};

/** Entry window (IST minutes from midnight): 09:45–11:00 per the user's rule.
 *  place_entry_order is REJECTED outside this window; exits are allowed any
 *  time the market is open. (Scanner window is 09:40–11:00 — entries start 5
 *  minutes later so the first picks have one settled cycle behind them.) */
export const ENTRY_START_MIN = 9 * 60 + 45;
export const ENTRY_END_MIN = 11 * 60;
export const ENTRY_WINDOW_LABEL = { opensAt: '09:45 IST', closesAt: '11:00 IST' };

/** Code-enforced end of day: the position guard force-exits every open
 *  position at/after this IST minute regardless of the AI (the 15:15 poller
 *  cycle fires it; 15:20/15:25 cycles retry stragglers). Brokers force-square
 *  INTRADAY product ~15:26 with a penalty — we act first. */
export const SQUARE_OFF_MIN = 15 * 60 + 12;

/** Reject an entry when the fresh premium quote has moved more than this %
 *  from the scanner's quote this cycle (the AI decided on stale numbers). */
export const MAX_ENTRY_SLIPPAGE_PCT = 4;

/** How long to poll a live broker order for a fill before leaving it to the
 *  next cycle's reconcile step (MARKET orders on liquid near-ATM strikes fill
 *  in seconds; anything slower is investigated, not assumed). */
export const FILL_POLL_ATTEMPTS = 3;
export const FILL_POLL_DELAY_MS = 2_000;

/** Per-pass ceiling on AI tool steps (mirrors lib/ai-assistant's cap). */
export const MAX_TOOL_STEPS = 10;

/** IST helpers (server runs UTC on Railway — same offset math as the repo's
 *  other IST call sites, e.g. lib/ai-assistant/assistant.ts sessionInfo). */
export function nowIST(): Date {
  return new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60_000);
}

export function minuteOfDayIST(): number {
  const ist = nowIST();
  return ist.getHours() * 60 + ist.getMinutes();
}

export function nowISTClock(): string {
  const ist = nowIST();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(ist.getHours())}:${pad(ist.getMinutes())}:${pad(ist.getSeconds())}`;
}

export function isEntryWindow(minute = minuteOfDayIST()): boolean {
  return minute >= ENTRY_START_MIN && minute <= ENTRY_END_MIN;
}

export function isPastSquareOff(minute = minuteOfDayIST()): boolean {
  return minute >= SQUARE_OFF_MIN;
}
