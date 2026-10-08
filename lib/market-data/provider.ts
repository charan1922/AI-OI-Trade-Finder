/** Active provider. Dhan source remains in the repository but is inactive. */
export const MARKET_DATA_PROVIDER = 'fyers' as const;
export const DHAN_RETIRED_MESSAGE = 'Dhan is inactive. Use Fyers for market data and new trades.';

/**
 * Fyers' OFFICIAL API limits — FyersDev/fyers-skills references/rate-limits.md
 * (Fyers' own GitHub org, read 2026-10-08): the same for every account, no
 * per-plan difference. Breaching the per-minute cap more than 3 times in a day
 * blocks the account for the rest of the day, so the data gate runs BELOW them.
 */
export const FYERS_OFFICIAL_LIMITS = { perSecond: 10, perMinute: 200, perDay: 100_000 } as const;

export interface FyersDataLimits {
  perSecond: number;
  perMinute: number;
  perDay: number;
}

/**
 * The data gate's budget (lib/fyers/client.ts throughFyersGate). Under the
 * official limits with headroom: the broker adapter has its OWN serial gate and
 * its orders / positions / quotes count against the same 200/min, so data stops
 * at 150. This replaced an invented "standard plan" (5/sec, 50/min, 5,000/day)
 * that capped the poller at 16 symbols a cycle and froze prices for 40+ minutes.
 */
export function fyersDataLimits(): FyersDataLimits {
  return { perSecond: 8, perMinute: 150, perDay: 90_000 };
}

/** History calls the poller makes per symbol per cycle (EQ candles, FUT candles, depth). */
const CALLS_PER_SYMBOL = 3;
/** 5-minute recording cycles in a session (09:15–15:30 = 75) plus margin. Off-hours
 *  cycles return 'market-closed' before downloading anything (poller.ts). */
const RECORDING_CYCLES_PER_DAY = 80;

/** How many symbols one poller cycle may download without exhausting the day's budget. */
export function symbolsPerCycle(limits: FyersDataLimits, universeSize: number): number {
  return Math.min(universeSize, Math.floor(limits.perDay / (CALLS_PER_SYMBOL * RECORDING_CYCLES_PER_DAY)));
}
