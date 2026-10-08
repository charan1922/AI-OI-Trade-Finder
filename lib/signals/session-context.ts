/**
 * Session context — opening range (9:15–9:45 IST) + day high/low derived from a
 * 5-min bar series. The R-Factor breakout factor's reference levels.
 *
 * Moved out of the retired intraday-candles store: bars now come from the Fyers
 * recorder (lib/fyers/candle-store.ts), but the derivation is source-agnostic —
 * anything with bucketTs/high/low works.
 */

/** Minimal bar shape needed to derive the session context. */
export interface SessionBar {
  /** Bar-START epoch seconds. */
  bucketTs: number;
  high: number;
  low: number;
}

/** IST minute-of-day for an epoch-second bar start (timestamps are UTC). */
function istMinuteOfDay(bucketTs: number): number {
  const istSec = bucketTs + 5.5 * 3600;
  return Math.floor((((istSec % 86400) + 86400) % 86400) / 60);
}

/** Opening-range (9:15–9:45 IST) high/low + session high/low — the R-Factor breakout reference. */
export interface SessionContext {
  openRangeHigh: number | null;
  openRangeLow: number | null;
  openRangeComplete: boolean;
  /** 15-min opening range (09:15–09:30) — the TF selector's breakout reference
   *  (operator, 2026-10-08). The 30-min range above keeps feeding stops, App
   *  R-Factor and spot plans unchanged. */
  openRange15High: number | null;
  openRange15Low: number | null;
  openRange15Complete: boolean;
  dayHigh: number | null;
  dayLow: number | null;
}

const OPEN_MIN = 9 * 60 + 15; // 555
const ENTRY_MIN = 9 * 60 + 45; // 585
const OR15_END_MIN = 9 * 60 + 30; // 570

/** Derive the opening range + day high/low from a 5-min series. */
export function deriveSessionContext(bars: SessionBar[]): SessionContext {
  let orH: number | null = null;
  let orL: number | null = null;
  let or15H: number | null = null;
  let or15L: number | null = null;
  let dH: number | null = null;
  let dL: number | null = null;
  let lastMinute = -1;
  for (const b of bars) {
    if (!(b.high > 0) || !(b.low > 0)) continue;
    dH = dH === null ? b.high : Math.max(dH, b.high);
    dL = dL === null ? b.low : Math.min(dL, b.low);
    const m = istMinuteOfDay(b.bucketTs);
    if (m >= OPEN_MIN && m < ENTRY_MIN) {
      orH = orH === null ? b.high : Math.max(orH, b.high);
      orL = orL === null ? b.low : Math.min(orL, b.low);
    }
    if (m >= OPEN_MIN && m < OR15_END_MIN) {
      or15H = or15H === null ? b.high : Math.max(or15H, b.high);
      or15L = or15L === null ? b.low : Math.min(or15L, b.low);
    }
    if (m > lastMinute) lastMinute = m;
  }
  // The last opening-range bar starts at 9:40 (minute 580); seeing it ⇒ range final.
  const openRangeComplete = lastMinute >= ENTRY_MIN - 5 && orH !== null;
  // The last 15-min bar starts at 9:25 (minute 565).
  const openRange15Complete = lastMinute >= OR15_END_MIN - 5 && or15H !== null;
  return {
    openRangeHigh: orH,
    openRangeLow: orL,
    openRangeComplete,
    openRange15High: or15H,
    openRange15Low: or15L,
    openRange15Complete,
    dayHigh: dH,
    dayLow: dL,
  };
}
