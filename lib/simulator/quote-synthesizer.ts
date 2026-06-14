/**
 * Market Simulator — quote synthesizer.
 *
 * Expands a coarse OHLCV+OI candle timeline into a fine-grained stream of
 * live-like `SimQuote` ticks. Each candle becomes `ticksPerCandle` sub-ticks
 * walking a realistic open→wick→close path, while day-level aggregates (VWAP,
 * cumulative volume, day high/low, OI change vs prior day) accumulate exactly
 * as a real feed would report them.
 *
 * Fully deterministic: identical (candles, config) always produce identical
 * ticks because all randomness flows through the seeded PRNG.
 */

import type { SimulatorConfig } from './config';
import { createPrng, type Prng } from './prng';
import type { SimCandle, SimQuote } from './types';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Unix seconds → IST calendar date (YYYY-MM-DD) for day-boundary grouping. */
function istDate(unixSeconds: number): string {
  return new Date((unixSeconds + 5.5 * 3600) * 1000).toISOString().split('T')[0];
}

/**
 * Build an intra-candle price path of length `n` that opens at `open`, closes
 * exactly at `close`, and touches both `high` and `low` along the way.
 */
function buildPricePath(candle: SimCandle, n: number, prng: Prng): number[] {
  if (n <= 1) return [candle.close];

  const up = candle.close >= candle.open;
  const waypoints = up
    ? [candle.open, candle.low, candle.high, candle.close]
    : [candle.open, candle.high, candle.low, candle.close];

  const segments = 3;
  const perSegment = Math.max(1, Math.floor((n - 1) / segments));
  const counts: number[] = [];
  let remaining = n - 1;
  for (let s = 0; s < segments; s++) {
    const cnt = s === segments - 1 ? remaining : Math.min(perSegment, remaining);
    counts.push(cnt);
    remaining -= cnt;
  }

  const range = candle.high - candle.low;
  const amp = range * 0.06;
  const path: number[] = [waypoints[0]];

  for (let s = 0; s < segments; s++) {
    const a = waypoints[s];
    const b = waypoints[s + 1];
    const cnt = counts[s];
    for (let k = 1; k <= cnt; k++) {
      const t = cnt === 0 ? 1 : k / cnt;
      let price = a + (b - a) * t;
      const isFinal = s === segments - 1 && k === cnt;
      if (!isFinal && amp > 0) price += prng.noise(amp);
      price = Math.min(candle.high, Math.max(candle.low, price));
      path.push(round2(price));
    }
  }

  path[path.length - 1] = candle.close;
  return path;
}

/** Distribute a candle's volume across `n` ticks with seeded weights. */
function distributeVolume(total: number, n: number, prng: Prng): number[] {
  if (total <= 0) return new Array(n).fill(0);
  const weights: number[] = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const w = prng.range(0.3, 1);
    weights.push(w);
    sum += w;
  }
  const out = weights.map((w) => Math.max(0, Math.round((w / sum) * total)));
  // Reconcile rounding drift onto the last tick.
  const allocated = out.reduce((acc, v) => acc + v, 0);
  out[n - 1] = Math.max(0, out[n - 1] + (total - allocated));
  return out;
}

/**
 * Expand candles → flat tick timeline. Returns every `SimQuote` in replay order.
 */
export function synthesizeTicks(candles: SimCandle[], config: SimulatorConfig): SimQuote[] {
  const prng = createPrng(config.seed);
  const ticks: SimQuote[] = [];
  if (candles.length === 0) return ticks;

  // Pre-compute per-day last close + last OI so each day knows its prior basis.
  const dayLastClose = new Map<string, number>();
  const dayLastOi = new Map<string, number>();
  for (const c of candles) {
    const d = istDate(c.time);
    dayLastClose.set(d, c.close);
    dayLastOi.set(d, c.oi);
  }
  const orderedDays = [...new Set(candles.map((c) => istDate(c.time)))];
  const prevCloseByDay = new Map<string, number>();
  const prevOiByDay = new Map<string, number>();
  for (let i = 0; i < orderedDays.length; i++) {
    const day = orderedDays[i];
    if (i === 0) {
      prevCloseByDay.set(day, candles[0].open);
      prevOiByDay.set(day, candles[0].oi);
    } else {
      const prior = orderedDays[i - 1];
      prevCloseByDay.set(day, dayLastClose.get(prior) ?? candles[0].open);
      prevOiByDay.set(day, dayLastOi.get(prior) ?? 0);
    }
  }

  let currentDay = '';
  let dayOpen = 0;
  let dayHigh = 0;
  let dayLow = 0;
  let dayOpenOi = 0;
  let prevClose = candles[0].open;
  let prevDayOi = candles[0].oi;
  let cumVolume = 0;
  let turnover = 0;
  let prevCandleOi = candles[0].oi;
  let tickIndex = 0;

  const ticksPerCandle = Math.max(1, config.ticksPerCandle);

  for (let ci = 0; ci < candles.length; ci++) {
    const candle = candles[ci];
    const day = istDate(candle.time);

    // New trading day → reset day aggregates.
    if (day !== currentDay) {
      currentDay = day;
      dayOpen = candle.open;
      dayHigh = candle.high;
      dayLow = candle.low;
      dayOpenOi = candle.oi;
      prevClose = prevCloseByDay.get(day) ?? candle.open;
      prevDayOi = prevOiByDay.get(day) ?? candle.oi;
      cumVolume = 0;
      turnover = 0;
      prevCandleOi = candle.oi;
    }

    const path = buildPricePath(candle, ticksPerCandle, prng);
    const volSlices = distributeVolume(candle.volume, ticksPerCandle, prng);

    let formingHigh = candle.open;
    let formingLow = candle.open;
    let candleVolume = 0;

    for (let j = 0; j < ticksPerCandle; j++) {
      const isCandleClose = j === ticksPerCandle - 1;
      // On the closing sub-tick, snap to the EXACT downloaded candle so every
      // closed bar is the real OHLCV. Intra-bar sub-ticks are only smooth motion
      // between the real open and real close, bounded by the real high/low.
      const ltp = isCandleClose ? candle.close : path[j];
      const ltq = volSlices[j];
      candleVolume += ltq;
      cumVolume += ltq;
      turnover += ltp * ltq;

      if (isCandleClose) {
        formingHigh = candle.high;
        formingLow = candle.low;
      } else {
        formingHigh = Math.max(formingHigh, ltp);
        formingLow = Math.min(formingLow, ltp);
      }
      dayHigh = Math.max(dayHigh, formingHigh);
      dayLow = Math.min(dayLow, formingLow);

      // OI interpolates from the prior candle's OI, landing exactly on candle.oi.
      const frac = (j + 1) / ticksPerCandle;
      const oi = Math.round(prevCandleOi + (candle.oi - prevCandleOi) * frac);
      const oiChange = oi - prevDayOi;

      const vwap = cumVolume > 0 ? turnover / cumVolume : ltp;
      const change = ltp - prevClose;

      ticks.push({
        symbol: config.symbol,
        securityId: config.securityId,
        instrumentKind: config.instrumentKind,
        segment: config.segment,

        ltp: round2(ltp),
        ltq,
        lastTradeTime: candle.time + Math.round(frac * intervalSeconds(config)),
        candleTime: candle.time,

        open: round2(candle.open),
        high: round2(formingHigh),
        low: round2(formingLow),
        close: round2(ltp),

        dayOpen: round2(dayOpen),
        dayHigh: round2(dayHigh),
        dayLow: round2(dayLow),
        prevClose: round2(prevClose),
        change: round2(change),
        changePct: prevClose > 0 ? round2((change / prevClose) * 100) : 0,

        volume: cumVolume,
        candleVolume,
        vwap: round2(vwap),
        turnover: Math.round(turnover),

        oi,
        oiChange,
        oiChangePct: prevDayOi > 0 ? round2((oiChange / prevDayOi) * 100) : 0,
        dayOpenOi,

        ts: 0, // stamped by the engine at emit time
        candleIndex: ci,
        tickIndex: tickIndex++,
        isCandleClose,
      });
    }

    prevCandleOi = candle.oi;
  }

  return ticks;
}

/** Interval length in seconds for sub-tick timestamp spreading. */
function intervalSeconds(config: SimulatorConfig): number {
  return Number.parseInt(config.interval, 10) * 60;
}
