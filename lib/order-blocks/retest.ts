/**
 * Retest watch-list — order-block.com-style "first retest" entries alongside the
 * breakout picks (operator 2026-11-19). Design:
 * docs/superpowers/specs/2026-11-19-retest-watchlist-design.md
 *
 * A name qualifies through the SAME TF selector with the four breakout-only checks
 * switched off (RETEST_TF_SELECTOR_CONFIG) and must have a live order-block zone
 * on its trade side, confirmed inside the auto-trade entry window. CODE detects
 * the trigger (a completed candle trading back into the zone — the engine's own
 * `retested` event); the AI only confirms.
 *
 * No invented numbers (operator 2026-11-19: "no assumptions and hardcodings"):
 *   - entry window  → the runtime auto-trade settings (entryStartMin / entryEndMin), passed in;
 *   - target        → TARGET_RR, the one reward:risk constant the spot plans already use;
 *   - stop          → the zone's far edge itself (order-block.com: "just beyond the far side");
 *   - no chasing    → enter only while price is still INSIDE the zone — what the replay tested;
 *   - freshness     → only the first scan after the trigger candle closes (one bar length).
 *
 * Replay that motivated it (scripts/measure-order-block-entries.ts, 17 sessions,
 * spot only): first retest + 2R target — promising, NOT proven.
 */
import { FYERS_BUCKET_SEC } from '@/lib/fyers/bucket';
import { TARGET_RR } from '@/lib/trade-suggest/config';
import { OB_DEFAULT_CONFIG, replayOrderBlocks, type OrderBlock } from './engine';
import { loadObBars, OB_SOURCE } from './read';

/** IST minutes-of-day [start, end] — always the caller's runtime entry-window settings. */
export interface RetestWindow {
  startMin: number;
  endMin: number;
}

const BAR_MS = FYERS_BUCKET_SEC * 1000;

export type RetestStatus = 'waiting' | 'triggered' | 'missed' | 'broken' | 'expired';

export interface RetestWatchItem {
  symbol: string;
  side: 'CE' | 'PE';
  zoneLow: number;
  zoneHigh: number;
  zoneConfirmedAt: string;
  /** Spot stop: the zone's far edge. */
  stopSpot: number;
  status: RetestStatus;
  /** HH:MM IST of the candle that traded into the zone, when it has. */
  triggeredAt: string | null;
  /** Live spot used for the status (null when unknown). */
  ltp: number | null;
  /** The plain call — what to do and at what levels. */
  call: string;
}

const IST_MS = 19_800_000;
const hhmm = (ms: number) => new Date(ms + IST_MS).toISOString().slice(11, 16);
const minuteOf = (ms: number) => {
  const d = new Date(ms + IST_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const clock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const rs = (n: number) => `₹${n.toFixed(2)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The zone a retest plan uses: the latest one on the trade's side confirmed inside the entry window. */
export function pickRetestZone(blocks: readonly OrderBlock[], side: 'CE' | 'PE', window: RetestWindow): OrderBlock | null {
  const want = side === 'CE' ? 'bullish' : 'bearish';
  const inWindow = blocks.filter((b) => {
    const m = minuteOf(b.confirmedAtMs);
    return b.side === want && m >= window.startMin && m <= window.endMin;
  });
  return inWindow.sort((a, b) => b.confirmedAtMs - a.confirmedAtMs)[0] ?? null;
}

/** Spot stop: the zone's far edge (below a bullish zone, above a bearish one). */
export function retestStopSpot(zone: Pick<OrderBlock, 'zoneLow' | 'zoneHigh'>, side: 'CE' | 'PE'): number {
  return side === 'CE' ? zone.zoneLow : zone.zoneHigh;
}

/** Pure: the watch-list item for one name, from its zone, live spot, the clock and the entry window. */
export function retestItem(
  symbol: string,
  side: 'CE' | 'PE',
  zone: OrderBlock,
  ltp: number | null,
  nowMs: number,
  window: RetestWindow
): RetestWatchItem {
  const stopSpot = retestStopSpot(zone, side);
  const ce = side === 'CE';
  const end = clock(window.endMin);
  const base = {
    symbol,
    side,
    zoneLow: zone.zoneLow,
    zoneHigh: zone.zoneHigh,
    zoneConfirmedAt: hhmm(zone.confirmedAtMs),
    stopSpot,
    ltp,
    triggeredAt: zone.firstRetestAtMs != null ? hhmm(zone.firstRetestAtMs - BAR_MS) : null,
  };
  const zoneTxt = `${ce ? 'bullish' : 'bearish'} zone ${rs(zone.zoneLow)}–${rs(zone.zoneHigh)}`;
  if (zone.state === 'invalidated') {
    return { ...base, status: 'broken', call: `${symbol}: ${zoneTxt} broken by a 5-min close at ${hhmm(zone.invalidatedAtMs ?? nowMs)} — plan cancelled.` };
  }
  if (zone.state === 'expired') {
    return { ...base, status: 'expired', call: `${symbol}: ${zoneTxt} expired at session end.` };
  }
  if (zone.state === 'confirmed_active') {
    if (minuteOf(nowMs) >= window.endMin) {
      return { ...base, status: 'expired', call: `${symbol}: ${zoneTxt} not revisited before ${end} — plan expired.` };
    }
    return {
      ...base,
      status: 'waiting',
      call:
        `${symbol}: WAIT. If a 5-min candle trades back into the ${zoneTxt} before ${end} → BUY ${side}; ` +
        `stop ${rs(stopSpot)} (the zone's ${ce ? 'low' : 'high'}); target ${TARGET_RR}R from the entry.`,
    };
  }
  // 'retested': the trigger candle has closed. Still actionable?
  const trigEnd = zone.firstRetestAtMs as number;
  if (minuteOf(trigEnd - BAR_MS) >= window.endMin) {
    return { ...base, status: 'expired', call: `${symbol}: ${zoneTxt} was only revisited after ${end} — no entry.` };
  }
  if (nowMs - trigEnd > BAR_MS) {
    return { ...base, status: 'missed', call: `${symbol}: touched the ${zoneTxt} at ${base.triggeredAt}; that chance has passed — no late entry.` };
  }
  if (ltp == null || !Number.isFinite(ltp)) {
    return { ...base, status: 'missed', call: `${symbol}: touched the ${zoneTxt} at ${base.triggeredAt} but no live price — no entry.` };
  }
  const pastStop = ce ? ltp <= stopSpot : ltp >= stopSpot;
  const leftZone = ce ? ltp > zone.zoneHigh : ltp < zone.zoneLow;
  if (pastStop) {
    return { ...base, status: 'broken', call: `${symbol}: price ${rs(ltp)} is already at/through the stop ${rs(stopSpot)} — no entry.` };
  }
  if (leftZone) {
    return { ...base, status: 'missed', call: `${symbol}: touched the ${zoneTxt} at ${base.triggeredAt} but price ${rs(ltp)} has already left it — missed, no chasing.` };
  }
  const target = round2(ltp + (ce ? 1 : -1) * TARGET_RR * Math.abs(ltp - stopSpot));
  return {
    ...base,
    status: 'triggered',
    call:
      `${symbol}: TRIGGERED — price ${rs(ltp)} is inside the ${zoneTxt} (candle ${base.triggeredAt}). BUY ${side} now; ` +
      `stop ${rs(stopSpot)}; target ${rs(target)} (${TARGET_RR}R).`,
  };
}

/** Pure: the spot plan for a TRIGGERED retest entered at `entrySpot` — zone-edge stop, TARGET_RR target. */
export function retestSpotPlan(item: Pick<RetestWatchItem, 'side' | 'stopSpot'>, entrySpot: number) {
  const risk = Math.abs(entrySpot - item.stopSpot);
  const target = entrySpot + (item.side === 'CE' ? 1 : -1) * TARGET_RR * risk;
  return { entrySpot, slSpot: item.stopSpot, targetSpot: round2(target), slBasis: 'order-block' as const };
}

/** Best-effort DB-backed watch-list for the scanner's retest-eligible names. */
export async function buildRetestWatchlist(
  names: readonly { symbol: string; side: 'CE' | 'PE' }[],
  date: string,
  nowMs: number,
  ltpBySymbol: ReadonlyMap<string, number | null>,
  window: RetestWindow
): Promise<RetestWatchItem[]> {
  const out: RetestWatchItem[] = [];
  for (const { symbol, side } of names) {
    try {
      const { bars } = await loadObBars(symbol, date, nowMs);
      if (bars.length === 0) continue;
      const state = replayOrderBlocks(symbol, OB_SOURCE, bars, OB_DEFAULT_CONFIG);
      const dayStart = bars.find((b) => b.date === date)?.startMs ?? Number.POSITIVE_INFINITY;
      const zone = pickRetestZone(state.blocks.filter((b) => b.confirmedAtMs > dayStart), side, window);
      if (zone) out.push(retestItem(symbol, side, zone, ltpBySymbol.get(symbol) ?? null, nowMs, window));
    } catch (error) {
      console.warn(`[Retest] ${symbol}: ${(error as Error).message}`);
    }
  }
  return out;
}
