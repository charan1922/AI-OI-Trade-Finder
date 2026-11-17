/** Active provider. Dhan source remains in the repository but is inactive. */
export const MARKET_DATA_PROVIDER = 'fyers' as const;
export const DHAN_RETIRED_MESSAGE = 'Dhan is inactive. Use Fyers for market data and new trades.';

/**
 * Fyers' OFFICIAL Data-API limits on the STANDARD plan (no Prime subscription).
 * Fyers split limits by plan (notice "Changes to FYERS API Rate Limits and
 * Usage", announced 2026-10-15); this account has been refused above them
 * since 2026-11-16 09:15 IST ("You've reached the Standard plan limit of 50
 * requests/minute" from 09:15, "… 5,000 requests/day" from 11:45 — no
 * candles for the rest of both days). Before that every account had
 * 10/sec, 200/min, 100,000/day. Orders/positions/funds (Transaction APIs)
 * keep 200/min, 100k/day — those go through the broker adapter's own gate.
 * Operator decision 2026-11-17: stay on Standard, do not upgrade to Prime.
 * Design for the full fix: docs/superpowers/specs/2026-11-17-fyers-standard-plan-budget-design.md
 */
export const FYERS_OFFICIAL_LIMITS = { perSecond: 5, perMinute: 50, perDay: 5_000 } as const;

export interface FyersDataLimits {
  perSecond: number;
  perMinute: number;
  perDay: number;
}

/**
 * The data gate's budget (lib/fyers/client.ts throughFyersGate) — every Fyers
 * data call shares it: poller candles + depth, the open-trade guard's option
 * quotes, scanner premiums, NIFTY candles. Under the Standard limits with
 * headroom for bursts and the adapter's rare order-time quote (it does not pass
 * through this gate).
 */
export function fyersDataLimits(): FyersDataLimits {
  return { perSecond: 4, perMinute: 40, perDay: 4_500 };
}

/**
 * The poller's SHARE of the daily budget. It is the only bulk caller: ≤
 * MAX_PRIORITY_SYMBOLS names × 2 calls (EQ candles + FUT depth) plus ~4
 * batched snapshot calls (50 names each) for everyone else, per cycle —
 * ~2,100 a day. The rest of the 4,500 is for the open-trade guard (one quote
 * every FAST_GUARD_TICK_MS while a trade is open — ~1,300 for a trade held
 * 10:00–15:12 at 15s), scanner premiums and NIFTY candles; the gate keeps the
 * last 500 for the guard (lib/fyers/budget.ts).
 */
export const POLLER_DAILY_BUDGET = 2_400;

export function pollerDataLimits(): FyersDataLimits {
  return { ...fyersDataLimits(), perDay: POLLER_DAILY_BUDGET };
}

/** Calls the poller makes per PRIORITY symbol per cycle (EQ candles, FUT depth). */
const CALLS_PER_SYMBOL = 2;
/** Most symbols that get full per-cycle data: open trades first, then TF's top 10. */
export const MAX_PRIORITY_SYMBOLS = 12;
/** 5-minute recording cycles in a session (09:15–15:30 = 75) plus margin. Off-hours
 *  cycles return 'market-closed' before downloading anything (poller.ts). */
const RECORDING_CYCLES_PER_DAY = 80;

/** How many symbols one poller cycle may download without exhausting the day's budget. */
export function symbolsPerCycle(limits: FyersDataLimits, universeSize: number): number {
  return Math.min(universeSize, Math.floor(limits.perDay / (CALLS_PER_SYMBOL * RECORDING_CYCLES_PER_DAY)));
}
