/**
 * Order-block READ for one trade direction at one price — what the auto-trader
 * sees per pick and per held position (operator 2026-11-19: "AI considers it").
 * ADVISORY ONLY: no gate reads it, and the prompt says so. Zones come from OUR
 * rule set (engine.ts) over the recorded 5-min EQ candles; only bars completed
 * by `asOfMs` are used, so the read never contains a zone confirmed later.
 */
import { prisma } from '@/lib/db';
import { invalidBarReason, OB_ALGORITHM_VERSION, OB_DEFAULT_CONFIG, replayOrderBlocks, type ObBar, type OrderBlock } from './engine';

const FIVE_MIN_MS = 300_000;
export const OB_SOURCE = 'fyers_candles — 5-min EQ candles recorded by the Fyers poller';

export interface DatedBar extends ObBar {
  date: string;
}

/** `date`'s completed EQ bars (≤ asOfMs) plus the previous recorded session as ATR/pivot warm-up. */
export async function loadObBars(symbol: string, date: string, asOfMs: number): Promise<{ bars: DatedBar[]; skipped: number }> {
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT date, bucketTs, open, high, low, close, volume FROM fyers_candles
      WHERE symbol = ? AND instrument = 'EQ' AND open > 0
        AND date IN (SELECT DISTINCT date FROM fyers_candles
                      WHERE symbol = ? AND instrument = 'EQ' AND date <= ?
                      ORDER BY date DESC LIMIT 2)
      ORDER BY bucketTs ASC`,
    symbol,
    symbol,
    date
  );
  let skipped = 0;
  const bars: DatedBar[] = [];
  for (const r of rows) {
    const startMs = Number(r.bucketTs) * 1000;
    const b: DatedBar = {
      date: String(r.date),
      startMs,
      endMs: startMs + FIVE_MIN_MS,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume ?? 0),
    };
    // Only COMPLETED bars as of asOf; the recorder also stores the forming bar.
    if (b.endMs > asOfMs) continue;
    if (invalidBarReason(b)) {
      skipped++;
      continue;
    }
    bars.push(b);
  }
  return { bars, skipped };
}

export interface ObZoneRef {
  side: 'bullish' | 'bearish';
  zoneLow: number;
  zoneHigh: number;
  /** % from price to the zone's nearest edge; 0 when price is inside it. */
  distancePct: number;
  state: 'confirmed_active' | 'retested';
  confirmedAt: string;
}

export interface OrderBlockRead {
  algorithmVersion: string;
  /** False = not enough history for ATR yet, so no zone could form. */
  atrReady: boolean;
  /** Nearest live zone ON the trade's side: under price for a CE, over price for a PE. */
  withTrade: ObZoneRef | null;
  /** Nearest live OPPOSITE zone in the trade's path: over price for a CE, under price for a PE. */
  against: ObZoneRef | null;
  /** Price is inside a live zone of this kind right now. */
  insideZone: 'with' | 'against' | null;
  /** Latest of today's with-trade zones broken by a 5-min close (support/resistance gone). */
  brokenWithTrade: { zoneLow: number; zoneHigh: number; at: string } | null;
  /** Plain-English summary for the AI (prices only — no derived statistics). */
  read: string;
}

const hhmm = (ms: number) => new Date(ms + 19_800_000).toISOString().slice(11, 16);
const rupee = (n: number) => `₹${n.toFixed(2)}`;
const pct = (n: number) => `${n.toFixed(2)}%`;

/** Pure: summarise today's zones relative to a trade direction and a price. */
export function summarizeOrderBlocks(
  blocks: readonly OrderBlock[],
  direction: 'bullish' | 'bearish',
  price: number,
  atrReady: boolean
): OrderBlockRead {
  const base = { algorithmVersion: OB_ALGORITHM_VERSION, atrReady };
  if (!atrReady) {
    return { ...base, withTrade: null, against: null, insideZone: null, brokenWithTrade: null, read: 'Not enough 5-min history yet for order blocks.' };
  }
  const tradeSide = direction;
  const oppSide = direction === 'bullish' ? 'bearish' : 'bullish';
  const live = blocks.filter((b) => b.state === 'confirmed_active' || b.state === 'retested');
  const ref = (b: OrderBlock): ObZoneRef => {
    const inside = price >= b.zoneLow && price <= b.zoneHigh;
    const dist = inside ? 0 : price > b.zoneHigh ? ((price - b.zoneHigh) / price) * 100 : ((b.zoneLow - price) / price) * 100;
    return {
      side: b.side,
      zoneLow: b.zoneLow,
      zoneHigh: b.zoneHigh,
      distancePct: Math.round(dist * 100) / 100,
      state: b.state as ObZoneRef['state'],
      confirmedAt: hhmm(b.confirmedAtMs),
    };
  };
  const below = (b: OrderBlock) => b.zoneLow <= price;
  const above = (b: OrderBlock) => b.zoneHigh >= price;
  const nearestBelow = (xs: OrderBlock[]) => xs.filter(below).sort((a, b) => b.zoneHigh - a.zoneHigh)[0];
  const nearestAbove = (xs: OrderBlock[]) => xs.filter(above).sort((a, b) => a.zoneLow - b.zoneLow)[0];
  const withZones = live.filter((b) => b.side === tradeSide);
  const oppZones = live.filter((b) => b.side === oppSide);
  const w = direction === 'bullish' ? nearestBelow(withZones) : nearestAbove(withZones);
  const a = direction === 'bullish' ? nearestAbove(oppZones) : nearestBelow(oppZones);
  const withTrade = w ? ref(w) : null;
  const against = a ? ref(a) : null;
  const insideZone = against?.distancePct === 0 ? 'against' : withTrade?.distancePct === 0 ? 'with' : null;
  const broken = blocks
    .filter((b) => b.side === tradeSide && b.state === 'invalidated' && b.invalidatedAtMs != null)
    .sort((x, y) => (y.invalidatedAtMs ?? 0) - (x.invalidatedAtMs ?? 0))[0];
  const brokenWithTrade = broken
    ? { zoneLow: broken.zoneLow, zoneHigh: broken.zoneHigh, at: hhmm(broken.invalidatedAtMs as number) }
    : null;

  const parts: string[] = [];
  const word = (s: 'bullish' | 'bearish') => (s === 'bullish' ? 'bullish' : 'bearish');
  if (insideZone === 'against' && against) {
    parts.push(`Price is INSIDE a ${word(against.side)} order block ${rupee(against.zoneLow)}–${rupee(against.zoneHigh)} (against this trade).`);
  } else if (against) {
    parts.push(
      `A ${against.state === 'retested' ? 'retested' : 'fresh'} ${word(against.side)} order block ${rupee(against.zoneLow)}–${rupee(against.zoneHigh)} sits ${pct(against.distancePct)} ${direction === 'bullish' ? 'above' : 'below'} price — in this trade's path.`
    );
  }
  if (insideZone === 'with' && withTrade) {
    parts.push(`Price is inside a ${word(withTrade.side)} order block ${rupee(withTrade.zoneLow)}–${rupee(withTrade.zoneHigh)} (with this trade).`);
  } else if (withTrade) {
    parts.push(
      `A ${withTrade.state === 'retested' ? 'retested' : 'fresh'} ${word(withTrade.side)} order block ${rupee(withTrade.zoneLow)}–${rupee(withTrade.zoneHigh)} sits ${pct(withTrade.distancePct)} ${direction === 'bullish' ? 'below' : 'above'} price — with this trade.`
    );
  }
  if (brokenWithTrade) {
    parts.push(
      `The ${word(tradeSide)} zone ${rupee(brokenWithTrade.zoneLow)}–${rupee(brokenWithTrade.zoneHigh)} was broken by a 5-min close at ${brokenWithTrade.at}.`
    );
  }
  if (parts.length === 0) parts.push('No live order blocks near price today.');
  return { ...base, withTrade, against, insideZone, brokenWithTrade, read: parts.join(' ') };
}

/** Best-effort DB-backed read for the scanner; null on any failure (advisory, never blocks). */
export async function orderBlockRead(
  symbol: string,
  date: string,
  direction: 'bullish' | 'bearish',
  price: number | null,
  asOfMs: number = Date.now()
): Promise<OrderBlockRead | null> {
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  try {
    const { bars } = await loadObBars(symbol, date, asOfMs);
    if (bars.length === 0) return null;
    const state = replayOrderBlocks(symbol, OB_SOURCE, bars, OB_DEFAULT_CONFIG);
    const dayBars = bars.filter((b) => b.date === date);
    const dayStartMs = dayBars[0]?.startMs ?? Number.POSITIVE_INFINITY;
    const today = state.blocks.filter((b) => b.confirmedAtMs > dayStartMs);
    return summarizeOrderBlocks(today, direction, price, (state.atr.at(-1) ?? null) !== null);
  } catch (error) {
    console.warn(`[OrderBlocks] read failed for ${symbol}: ${(error as Error).message}`);
    return null;
  }
}
