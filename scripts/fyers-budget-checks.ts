/**
 * Pure checks for the Fyers data budget (lib/market-data/provider.ts).
 *
 * Fyers' STANDARD-plan Data-API limits: 5/sec, 50/min, 5,000/day (enforced on
 * this account since 2026-11-16 — the day's budget ran out at 11:45 on both
 * 16 and 17 Nov, with the poller recording all ~165 names every cycle). Until
 * then every account had 10/sec, 200/min, 100,000/day. Operator decision
 * 2026-11-17: stay on Standard. These checks pin a day that FITS: the poller's
 * share plus the open-trade guard plus the small callers stays under the gate.
 */
import { FAST_GUARD_TICK_MS } from '../lib/auto-trade/config';
import { admitCall, classifyLimitRefusal, latchUntilFor, resumeBudget } from '../lib/fyers/budget';
import {
  fyersDataLimits,
  FYERS_OFFICIAL_LIMITS,
  MAX_PRIORITY_SYMBOLS,
  pollerDataLimits,
  symbolsPerCycle,
} from '../lib/market-data/provider';
import { spreadFromDepth } from '../lib/fyers/market-feed';

export type CheckFn = (name: string, ok: boolean, detail?: string) => void;

export function runFyersBudgetChecks(check: CheckFn): void {
  const l = fyersDataLimits();
  check('fyers budget: official limits are the Standard plan (5/s, 50/min, 5,000/day)',
    FYERS_OFFICIAL_LIMITS.perSecond === 5 && FYERS_OFFICIAL_LIMITS.perMinute === 50 && FYERS_OFFICIAL_LIMITS.perDay === 5_000);
  check('fyers budget: per-second stays under the official 5', l.perSecond < FYERS_OFFICIAL_LIMITS.perSecond, String(l.perSecond));
  check('fyers budget: per-minute leaves ≥ 10/min headroom under the official 50', l.perMinute <= FYERS_OFFICIAL_LIMITS.perMinute - 10, String(l.perMinute));
  check('fyers budget: per-day leaves ≥ 500 headroom under the official 5,000', l.perDay <= FYERS_OFFICIAL_LIMITS.perDay - 500, String(l.perDay));

  // The priority cap, not the budget, binds: the budget must admit at least the cap.
  const perCycle = Math.min(MAX_PRIORITY_SYMBOLS, symbolsPerCycle(pollerDataLimits(), 166));
  check('fyers budget: the poller gives full data to MAX_PRIORITY_SYMBOLS (12) a cycle', perCycle === 12, String(perCycle));
  const snapshotCalls = Math.ceil((166 - perCycle) / 50);
  const cycleCalls = perCycle * 2 + snapshotCalls;
  check('fyers budget: a poller cycle fits in 5 minutes at the per-minute cap', cycleCalls / l.perMinute < 5, `${cycleCalls} calls, ${(cycleCalls / l.perMinute).toFixed(2)} min`);
  check('fyers budget: never more symbols than the universe has', symbolsPerCycle(l, 12) === 12);

  // One full trading day, the worst normal case: 75 poller cycles at the cap,
  // one trade open 09:45–15:12 polled by the guard, plus scanner premiums and
  // NIFTY candles (generous allowance). Must stay under the gate's daily cap,
  // or the guard loses prices before the 15:12 square-off.
  const poller = cycleCalls * 75;
  const guard = Math.ceil(((15 * 60 + 12 - (9 * 60 + 45)) * 60_000) / FAST_GUARD_TICK_MS);
  const others = 400;
  const day = poller + guard + others;
  check('fyers budget: a full day with one open trade fits under the daily cap', day <= l.perDay, `${poller} poller + ${guard} guard + ${others} other = ${day} / ${l.perDay}`);
  check('fyers budget: guard re-checks at 15s (5s overspent the Standard plan)', FAST_GUARD_TICK_MS === 15_000, String(FAST_GUARD_TICK_MS));

  // ── Refusal latch, critical reserve, restart resume (lib/fyers/budget.ts) ──
  const t0 = Date.parse('2026-11-18T10:00:00+05:30');
  check('budget: Fyers per-minute message latches the minute',
    classifyLimitRefusal("You've reached the Standard plan limit of 50 requests/minute. Upgrade to Prime") === 'minute');
  check('budget: Fyers per-day message latches the day',
    classifyLimitRefusal("You've reached the Standard plan limit of 5,000 requests/day. Upgrade to Prime") === 'day');
  check('budget: unrelated errors do not latch', classifyLimitRefusal('Invalid symbol') === null);
  check('budget: a minute latch lasts ~61s', latchUntilFor('minute', t0) - t0 === 61_000);
  check('budget: a day latch lasts until 00:00 IST',
    latchUntilFor('day', t0) === Date.parse('2026-11-19T00:00:00+05:30'));
  const fresh = resumeBudget(null, t0);
  check('budget: a new day starts at 0, unlatched', fresh.count === 0 && fresh.latchUntil === 0 && fresh.date === '2026-11-18');
  const resumed = resumeBudget({ date: '2026-11-18', count: 1234, latchUntil: t0 + 30_000, latchReason: 'minute' }, t0);
  check('budget: a restart resumes the stored count and an active latch', resumed.count === 1234 && resumed.latchUntil === t0 + 30_000);
  check("budget: yesterday's row does not carry over",
    resumeBudget({ date: '2026-11-17', count: 4400, latchUntil: 0, latchReason: null }, t0).count === 0);
  check('budget: latched → every lane refused', admitCall({ ...fresh, latchUntil: t0 + 1 }, 'critical', 4_500, t0) !== null);
  check('budget: normal lane stops 500 short of the cap', admitCall({ ...fresh, count: 4_000 }, 'normal', 4_500, t0) !== null);
  check('budget: critical lane may use the reserve', admitCall({ ...fresh, count: 4_000 }, 'critical', 4_500, t0) === null);
  check('budget: critical lane stops at the cap', admitCall({ ...fresh, count: 4_500 }, 'critical', 4_500, t0) !== null);
  check('budget: a day with one open trade leaves the critical reserve untouched',
    poller + others <= l.perDay - 500, `${poller + others} normal-lane calls vs ${l.perDay - 500} allowed`);
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
