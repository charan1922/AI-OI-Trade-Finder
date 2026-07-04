/**
 * Classic intraday indicators computed from the recorded 5-min bars — pure
 * functions, no I/O. Standard formulations only (Wilder ATR, Supertrend
 * (10, 3), session VWAP), so values match what the user's charting tools
 * show and nothing is invented:
 *
 * - ATR(14, Wilder): TR = max(H−L, |H−prevC|, |L−prevC|); first ATR = SMA of
 *   the first 14 TRs, then ATR = (prevATR×13 + TR)/14.
 * - Supertrend(10, 3): bands at (H+L)/2 ± 3×ATR(10) with the standard
 *   band-ratchet and close-cross flip rules.
 * - Session VWAP: Σ(typicalPrice×volume) ÷ Σvolume, typical = (H+L+C)/3.
 */

export interface IndicatorBar {
  bucketTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const usable = (bars: IndicatorBar[]): IndicatorBar[] => bars.filter((b) => b.high > 0 && b.low > 0 && b.close > 0);

/** True range series (needs the previous close; first bar uses H−L). */
function trueRanges(bars: IndicatorBar[]): number[] {
  return bars.map((b, i) =>
    i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)),
  );
}

/**
 * Wilder ATR over the whole series; returns the latest value, or null when
 * there aren't enough bars (period + 1, so the first TR has a previous close).
 */
export function atr(bars: IndicatorBar[], period = 14): number | null {
  const bs = usable(bars);
  if (bs.length < period + 1) return null;
  const trs = trueRanges(bs).slice(1); // drop the H−L seed bar
  let value = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) value = (value * (period - 1) + trs[i]) / period;
  return value;
}

export interface SupertrendResult {
  /** 'up' = price above the Supertrend line (bullish), 'down' = below. */
  direction: 'up' | 'down';
  /** The current Supertrend line — the trailing stop level. */
  line: number;
  /** Bars since the last flip (1 = flipped on the latest bar). */
  barsInTrend: number;
}

/**
 * Supertrend(period, multiplier) over the session's bars. Null when there
 * aren't enough bars to seed the ATR.
 */
export function supertrend(bars: IndicatorBar[], period = 10, multiplier = 3): SupertrendResult | null {
  const bs = usable(bars);
  if (bs.length < period + 2) return null;

  // Wilder ATR series aligned to bars (atrSeries[i] = ATR at bar i, from i=period).
  const trs = trueRanges(bs);
  const atrSeries: (number | null)[] = bs.map(() => null);
  let a = trs.slice(1, period + 1).reduce((x, y) => x + y, 0) / period;
  atrSeries[period] = a;
  for (let i = period + 1; i < bs.length; i++) {
    a = (a * (period - 1) + trs[i]) / period;
    atrSeries[i] = a;
  }

  let upper = 0;
  let lower = 0;
  let dir: 'up' | 'down' = 'up';
  let line = 0;
  let flipBar = period;
  for (let i = period; i < bs.length; i++) {
    const mid = (bs[i].high + bs[i].low) / 2;
    const av = atrSeries[i] as number;
    const basicUpper = mid + multiplier * av;
    const basicLower = mid - multiplier * av;
    if (i === period) {
      upper = basicUpper;
      lower = basicLower;
      dir = bs[i].close >= mid ? 'up' : 'down';
    } else {
      const prevClose = bs[i - 1].close;
      // Band ratchet: bands only tighten while price respects them.
      upper = basicUpper < upper || prevClose > upper ? basicUpper : upper;
      lower = basicLower > lower || prevClose < lower ? basicLower : lower;
      const prevDir: 'up' | 'down' = dir;
      if (dir === 'up' && bs[i].close < lower) dir = 'down';
      else if (dir === 'down' && bs[i].close > upper) dir = 'up';
      if (dir !== prevDir) flipBar = i;
    }
    line = dir === 'up' ? lower : upper;
  }
  return { direction: dir, line, barsInTrend: bs.length - flipBar };
}

/** Session VWAP from the recorded bars. Null when no volume has printed. */
export function sessionVwap(bars: IndicatorBar[]): number | null {
  let pv = 0;
  let v = 0;
  for (const b of usable(bars)) {
    if (b.volume <= 0) continue;
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    v += b.volume;
  }
  return v > 0 ? pv / v : null;
}
