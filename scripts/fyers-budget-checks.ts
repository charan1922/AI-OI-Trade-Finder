/**
 * Pure checks for the Fyers data budget (lib/market-data/provider.ts).
 *
 * Official limits — FyersDev/fyers-skills references/rate-limits.md (Fyers' own
 * GitHub org, read 2026-10-08): 10/sec, 200/min, 100,000/day, NO per-plan
 * difference; breaching the per-minute cap more than 3 times in a day blocks the
 * account for the rest of the day. The code used to assume an invented
 * "standard plan" of 5/sec, 50/min, 5,000/day and capped the poller at 16
 * symbols a cycle, which left prices frozen for 40+ minutes (ADANIGREEN stuck at
 * 1318.3 from 09:22 to 10:05 on 2026-10-08) and fed a wrong 09:45 anchor to
 * the trade selector.
 */
import { fyersDataLimits, FYERS_OFFICIAL_LIMITS, symbolsPerCycle } from '../lib/market-data/provider';
import { spreadFromDepth } from '../lib/fyers/market-feed';

export type CheckFn = (name: string, ok: boolean, detail?: string) => void;

export function runFyersBudgetChecks(check: CheckFn): void {
  const l = fyersDataLimits();
  check('fyers budget: per-second stays under the official 10', l.perSecond < FYERS_OFFICIAL_LIMITS.perSecond, String(l.perSecond));
  // Headroom for the broker adapter's own gate (orders/positions count too).
  check('fyers budget: per-minute leaves ≥ 40/min headroom under the official 200', l.perMinute <= FYERS_OFFICIAL_LIMITS.perMinute - 40, String(l.perMinute));
  check('fyers budget: per-day stays under the official 100,000', l.perDay < FYERS_OFFICIAL_LIMITS.perDay, String(l.perDay));
  const full = symbolsPerCycle(l, 166);
  check('fyers budget: the whole 166-symbol universe is recorded every cycle', full === 166, String(full));
  // 3 calls per symbol must finish inside one 5-minute cycle at the per-minute cap.
  check('fyers budget: a full cycle fits in 5 minutes at the per-minute cap', (166 * 3) / l.perMinute < 5, `${((166 * 3) / l.perMinute).toFixed(2)} min`);
  check('fyers budget: a smaller daily budget caps the cycle instead of overrunning it', symbolsPerCycle({ ...l, perDay: 2_400 }, 166) === 10);
  check('fyers budget: never more symbols than the universe has', symbolsPerCycle(l, 12) === 12);
}

/**
 * Real bid/ask from a Fyers depth reply. Since the Fyers migration (ea74b3e,
 * 2026-10-06) /api/live/quote hard-codes bid/ask/spreadPct to null, and the
 * engine reads a null spread as "illiquid" — so EVERY TF candidate was rejected
 * (2026-10-08: ADANIENT and JUBLFOOD selected, "survivors 0"). The engine now
 * fetches the book for its few TF candidates; this is the arithmetic.
 */
export function runFyersDepthChecks(check: CheckFn): void {
  const quote = (buy: [number, number][], sell: [number, number][]) => ({
    last_price: 2621.3,
    ohlc: { open: 0, high: 0, low: 0, close: 0 },
    depth: {
      buy: buy.map(([price, quantity]) => ({ price, quantity, orders: 1 })),
      sell: sell.map(([price, quantity]) => ({ price, quantity, orders: 1 })),
    },
  });
  const s = spreadFromDepth(quote([[2621.0, 50], [2620.5, 10]], [[2621.6, 40], [2622.0, 5]]));
  check('depth: best bid = highest buy, best ask = lowest sell', s?.bid === 2621.0 && s?.ask === 2621.6, JSON.stringify(s));
  check('depth: spread % of mid', s != null && Math.abs(s.spreadPct - (0.6 / 2621.3) * 100) < 1e-9);
  check('depth: an empty side gives no spread (stays illiquid, fail closed)', spreadFromDepth(quote([[2621, 5]], [])) === null);
  check('depth: zero prices give no spread', spreadFromDepth(quote([[0, 5]], [[2621.6, 5]])) === null);
  check('depth: a crossed book gives no spread', spreadFromDepth(quote([[2622, 5]], [[2621, 5]])) === null);
  check('depth: no depth object gives no spread', spreadFromDepth({ last_price: 1, ohlc: { open: 0, high: 0, low: 0, close: 0 } }) === null);
}
