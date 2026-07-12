/**
 * TradeFinder breakout context for the /live quote hot path.
 *
 * Same design as morning-candles.ts: the SLOW half (5-min bars → morning-test
 * state + named-level ladders, lib/breakout) is derived in the background and
 * cached in memory per symbol/day; the FAST half (live LTP vs cached levels)
 * runs synchronously on every poll via evaluateBreakout.
 *
 * Unlike the morning-context warm (top-12 only — it feeds a low-weight
 * R-Factor factor), this warms every displayed symbol: the reads are tiny
 * local SQLite queries (~75 rows each, refreshed at most every 5 min per
 * symbol) and the breakout column is the page's point, not a garnish. No
 * external API calls are involved.
 */

import { todayIST } from '@/lib/dhan/market-feed';
import { getFyersCandles } from '@/lib/fyers/candle-store';
import { deriveBreakoutContext, type BreakoutContext, type LevelInputs } from '@/lib/breakout';
import { deriveSessionContext } from '@/lib/signals/session-context';
import type { RFactorBaseline } from './rfactor-baselines';

/** Re-derive at most this often — fyers_candles only changes per 5-min cycle. */
const REFRESH_MS = 5 * 60 * 1000;

interface CachedBreakout {
  ctx: BreakoutContext | null;
  fetchedAt: number;
}

const cache = new Map<string, CachedBreakout>();
const inflight = new Set<string>();

const keyFor = (symbol: string): string => `${todayIST()}:${symbol}`;

/** Synchronous read — today's cached breakout context (or null before first derive). */
export function getBreakoutContext(symbol: string): BreakoutContext | null {
  return cache.get(keyFor(symbol))?.ctx ?? null;
}

/**
 * Ensure the symbol's breakout context is derived (or refreshed when stale)
 * from the Fyers store. Fire-and-forget; no-ops when fresh or in flight. The
 * EOD level inputs (prev-day / 5d / 20d extremes) come from the baselines the
 * quote route has already loaded — no extra bhavcopy query.
 */
export function ensureBreakoutContext(symbol: string, baseline: RFactorBaseline | undefined): void {
  const key = keyFor(symbol);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < REFRESH_MS) return;
  if (inflight.has(key)) return;
  inflight.add(key);

  void (async () => {
    try {
      const bars = await getFyersCandles(symbol, todayIST(), 'EQ');
      if (bars.length === 0) return; // not recorded yet — retry on a later poll
      const sc = deriveSessionContext(bars);
      const levels: LevelInputs = {
        openRangeHigh: sc.openRangeHigh,
        openRangeLow: sc.openRangeLow,
        openRangeComplete: sc.openRangeComplete,
        priorDayHigh: baseline?.priorDayHigh ?? null,
        priorDayLow: baseline?.priorDayLow ?? null,
        high5d: baseline?.high5d ?? null,
        low5d: baseline?.low5d ?? null,
        high20d: baseline?.high20d ?? null,
        low20d: baseline?.low20d ?? null,
      };
      cache.set(key, { ctx: deriveBreakoutContext(bars, levels), fetchedAt: Date.now() });
    } catch {
      // Store hiccup — leave the cache as-is; the next poll retries.
    } finally {
      inflight.delete(key);
    }
  })();
}
