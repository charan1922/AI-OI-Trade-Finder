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
  dayHigh: number | null;
  dayLow: number | null;
}

const OPEN_MIN = 9 * 60 + 15; // 555
const ENTRY_MIN = 9 * 60 + 45; // 585

/** Derive the opening range + day high/low from a 5-min series. */
export function deriveSessionContext(bars: SessionBar[]): SessionContext {
  let orH: number | null = null;
  let orL: number | null = null;
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
    if (m > lastMinute) lastMinute = m;
  }
  // The last opening-range bar starts at 9:40 (minute 580); seeing it ⇒ range final.
  const openRangeComplete = lastMinute >= ENTRY_MIN - 5 && orH !== null;
  return { openRangeHigh: orH, openRangeLow: orL, openRangeComplete, dayHigh: dH, dayLow: dL };
}
