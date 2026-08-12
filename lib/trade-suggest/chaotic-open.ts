/**
 * Chaotic-open gate — skip names whose OPENING was a violent spike relative to
 * their own normal 5-minute movement.
 *
 * WHY THIS EXISTS (2026-07-15/16 evidence, N=4)
 * -----------------------------------------------------------------------
 * Both auto-trade losers opened in a mess and both winners opened calmly:
 *
 *   HYUNDAI  15-Jul LOSS −₹1,911 : opening 15-min range 5.5× its settled ATR
 *   SRF      16-Jul LOSS (order failed; would-be loss) : 5.7×
 *   MANKIND  15-Jul WIN  +₹3,988 : 2.5×
 *   PATANJALI 15-Jul WIN +₹6,504 : 2.9×
 *
 * The losers blew the day's energy in the first 15 minutes (a bar ~5–6× a
 * normal one), we bought the "continuation" near the top, and it reverted
 * within 30 minutes (HYUNDAI −19 pts, SRF −40 pts). The winners opened at
 * ~2.5–3× and trended. Absolute range/extension filters fail here — PATANJALI
 * won while 13% extended with an 8.7-daily-ATR move — because width only
 * means "chaos" relative to the stock's OWN noise. Hence the ratio:
 *
 *   chaoticOpenRatio = (first-15-min high−low) ÷ (avg 5-min true range after 09:30)
 *
 * The threshold (CHAOTIC_OPEN_MAX_RATIO = 5) was calibrated by the 2026-07-17
 * full-universe backtest over both recorded sessions: an initial 4 would have
 * blocked the trend-day winners (KALYANKJIL 4.46, SIEMENS 4.37, CGPOWER 4.29
 * at ~10:30) because most stocks open "hot" (universe median ≈4.6); 5 keeps
 * that whole class while still blocking both proven losers and 6 losing picks
 * with zero winners lost. Note the ratio SELF-HEALS on real trend days: as the
 * stock keeps moving, its settled ATR grows and the open stops looking
 * anomalous (SIEMENS: 4.37 at 10:30 → 1.83 by its 10:45 pick).
 *
 * HONEST CAVEAT: 2 recorded days is a hypothesis, not proof. Default ON at the
 * user's explicit request (2026-07-17); the nightly scorecard + 20-session
 * candle retention accrue the replay evidence to confirm or kill it. Skipped
 * names are counted transparently (gated.chaoticOpen).
 *
 * PURE (no imports) so it is unit-testable and the replay harness can A/B it
 * across recorded days — same convention as extended-bypass.ts.
 */

export interface OpenBar {
  /** Bar-START epoch seconds on the 300s grid (fyers_candles convention). */
  bucketTs: number;
  high: number;
  low: number;
  close: number;
}

const IST_OFFSET_SEC = 330 * 60;
const minuteOfDayIST = (ts: number) => Math.floor(((ts + IST_OFFSET_SEC) % 86400) / 60);
const SESSION_OPEN_MIN = 9 * 60 + 15;
const OPEN_RANGE_END_MIN = 9 * 60 + 30; // first three 5-min bars: 09:15, 09:20, 09:25

/**
 * Opening 15-min range ÷ average settled 5-min true range.
 * Null (gate skipped, transparently) until the data can support the read:
 * needs the full 3-bar opening range plus ≥4 settled bars (≥3 true-range
 * samples — available from ~09:50, before the first 09:45 entries settle).
 */
export function chaoticOpenRatio(bars: readonly OpenBar[]): number | null {
  const orBars: OpenBar[] = [];
  const settled: OpenBar[] = [];
  for (const b of bars) {
    const m = minuteOfDayIST(b.bucketTs);
    if (m < SESSION_OPEN_MIN) continue;
    if (m < OPEN_RANGE_END_MIN) orBars.push(b);
    else settled.push(b);
  }
  if (orBars.length < 3 || settled.length < 4) return null;
  const orHigh = Math.max(...orBars.map((b) => b.high));
  const orLow = Math.min(...orBars.map((b) => b.low));
  const orRange = orHigh - orLow;
  if (!(orRange > 0)) return null;
  let trSum = 0;
  let trN = 0;
  for (let i = 1; i < settled.length; i++) {
    const prev = settled[i - 1];
    const bar = settled[i];
    trSum += Math.max(bar.high - bar.low, Math.abs(bar.high - prev.close), Math.abs(bar.low - prev.close));
    trN++;
  }
  if (trN < 3 || !(trSum > 0)) return null;
  return orRange / (trSum / trN);
}

/** True when the open was chaotic (ratio above `maxRatio`). Null = not yet
 *  computable — callers must treat null as "gate skipped", never as chaotic. */
export function isChaoticOpen(bars: readonly OpenBar[], maxRatio: number): boolean | null {
  const ratio = chaoticOpenRatio(bars);
  return ratio == null ? null : ratio > maxRatio;
}
