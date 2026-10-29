/**
 * Loads what the pure watch evaluator (watches.ts) needs, from what the server ALREADY records:
 * 5-min closes in fyers_candles, open auto_trades rows, the latest TF board capture, and the cached
 * market-sideways read. No broker calls — the watch loop must never compete with the trader for
 * quote budget.
 */

import { latestSpotRead } from '@/lib/auto-trade/quotes';
import { getOpenTrades } from '@/lib/auto-trade/store';
import { minuteOfDayIST } from '@/lib/ist';
import { getTfSnapshot } from '@/lib/tf-live/snapshot';
import { TF_BOARD_MAX_AGE_MIN, TF_RACE_MAX_RANK } from '@/lib/trade-suggest/config';
import { needsSideways, type WatchInputs, type WatchKind } from './watches';

export async function loadWatchInputs(
  date: string,
  opts: { symbols: readonly string[]; kinds: readonly WatchKind[] }
): Promise<WatchInputs> {
  const nowMin = minuteOfDayIST();

  const openTrades = new Map<string, { direction: 'bullish' | 'bearish'; entrySpot: number; slSpot: number | null }>();
  try {
    for (const t of await getOpenTrades()) {
      if (t.date === date) openTrades.set(t.symbol, { direction: t.direction, entrySpot: t.entrySpot, slSpot: t.slSpot });
    }
  } catch {
    // Unknown positions → position watches report "can't check", never fire.
  }

  const spot = new Map<string, { price: number; fresh: boolean; ageMin: number } | null>();
  for (const symbol of new Set([...opts.symbols, ...openTrades.keys()])) {
    const r = await latestSpotRead(symbol, date);
    spot.set(symbol, r ? { price: r.price, fresh: r.fresh, ageMin: r.ageMs / 60_000 } : null);
  }

  let tf: WatchInputs['tf'] = null;
  try {
    const snap = await getTfSnapshot(date);
    tf = {
      available: snap.available,
      ageMinutes: snap.ageMinutes,
      maxAgeMin: TF_BOARD_MAX_AGE_MIN,
      maxRank: TF_RACE_MAX_RANK,
      ranks: new Map([...snap.bySymbol].map(([s, v]) => [s, v.rank])),
    };
  } catch {
    tf = null;
  }

  let sideways: WatchInputs['sideways'] = null;
  if (needsSideways(opts.kinds)) {
    try {
      const { loadMarketSideways } = await import('@/lib/tf-live/market-sideways-data');
      const s = await loadMarketSideways(date, nowMin);
      sideways = { stuck: s.stuck, reason: s.reason };
    } catch (err) {
      sideways = { stuck: null, reason: `sideways check failed: ${(err as Error).message}` };
    }
  }

  return { nowMin, spot, openTrades, tf, sideways };
}
