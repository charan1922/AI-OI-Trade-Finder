/**
 * "Trend day" chart shape — the 10th dot on /live's TF Climbers card. ADVISORY ONLY:
 * the selector, the auto-trader and the AI never read it (verify-tf-selector.ts proves it).
 *
 * WHY. TradeFinder trades "R-Factor + chart analysis" (operator, 2026-10-14). Their
 * verified daily trades (Sensibull fanged-okra, Jul–Oct 2026) were, on every one of the
 * 12 days we hold 5-min candles for, the same chart: the 30-min opening range broken in
 * the trade's direction by 10:25, price on the trade's side of VWAP for nearly every bar
 * after 10:00, shallow pullbacks, and a move that kept going into the close. Our own
 * checks call such a stock "extended" and walk away from it.
 *
 * MEASURED (no lookahead — bars strictly before the decision bucket, outcome from the
 * decision bar's open to 15:12, 1% spot stop), 20 sessions 2026-09-15..10-13, every F&O
 * stock at 11:00:
 *   all stocks, traded with their move      n=3,320  +0.155R  54% win
 *   this shape                              n=509    +0.258R  56% win  (±0.05)
 *   TradeFinder's own pick inside the set   11 of 12 of their days
 * About 2 standard errors over baseline, in ONE market regime, on one decision minute,
 * thresholds chosen once and not tuned. Evidence, not proof — hence advisory. Promote it
 * to a check only after pairing it with graded outcomes over more sessions.
 */

/** The rule's thresholds — set once from the TradeFinder chart study, deliberately not tuned. */
export const TREND_RULE = {
  /** Move from the previous close in the trade's direction, %. */
  minMovePct: 1.5,
  /** Share of 5-min closes since 10:00 on the trade's side of session VWAP. */
  minVwapShare: 0.9,
  /** Deepest pullback since 10:00 from the running best close, % of price. */
  maxPullbackPct: 1.5,
} as const;

const OR_END_MIN = 9 * 60 + 45; // 30-min opening range 09:15–09:45
const MEASURE_FROM_MIN = 10 * 60;

export interface TrendBar {
  bucketTs: number; // seconds
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TrendShape {
  /** 'trend' only when all four parts hold; 'not' names the first that failed. */
  state: 'trend' | 'not';
  /** Direction-aware % from the previous close (positive = the trade's way). */
  movePct: number;
  orbBroken: boolean;
  /** 0–1: share of closes since 10:00 on the trade's side of VWAP. */
  vwapShare: number;
  pullbackPct: number;
  /** First failing part, in plain English; null when state is 'trend'. */
  failed: string | null;
}

/** IST minute-of-day for a bucket timestamp (IST has no DST, so a fixed offset is exact). */
const istMinute = (bucketTs: number): number => {
  const d = new Date(bucketTs * 1000 + 330 * 60_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/**
 * Trend-day shape from bars that CLOSED before the decision (the caller passes only
 * those). Null = not enough evidence yet (no previous close, opening range not
 * complete, nothing since 10:00) — never guessed, so the dot stays grey.
 */
export function trendShape(prior: TrendBar[], side: 'CE' | 'PE', prevClose: number | null): TrendShape | null {
  if (prevClose == null || !(prevClose > 0)) return null;
  const bars = prior.filter((b) => b.high > 0 && b.close > 0).sort((a, b) => a.bucketTs - b.bucketTs);
  const range = bars.filter((b) => istMinute(b.bucketTs) < OR_END_MIN);
  const since10 = bars.filter((b) => istMinute(b.bucketTs) >= MEASURE_FROM_MIN);
  if (range.length < 5 || since10.length === 0) return null;

  const dir = side === 'CE' ? 1 : -1;
  const last = bars[bars.length - 1].close;
  const movePct = (dir * (last - prevClose) * 100) / prevClose;

  const orHigh = Math.max(...range.map((b) => b.high));
  const orLow = Math.min(...range.map((b) => b.low));
  const orbBroken = bars.some(
    (b) => istMinute(b.bucketTs) >= OR_END_MIN && (dir > 0 ? b.close > orHigh : b.close < orLow)
  );

  // Session VWAP from 09:15, typical price weighted by volume; each bar compared with the VWAP through itself.
  let cumV = 0;
  let cumPV = 0;
  let onSide = 0;
  let best = -Infinity;
  let pullbackPct = 0;
  for (const b of bars) {
    cumV += b.volume;
    cumPV += b.volume * ((b.high + b.low + b.close) / 3);
    if (istMinute(b.bucketTs) < MEASURE_FROM_MIN) continue;
    const vwap = cumV > 0 ? cumPV / cumV : b.close;
    if (dir * (b.close - vwap) > 0) onSide++;
    best = Math.max(best, dir * b.close);
    pullbackPct = Math.max(pullbackPct, ((best - dir * b.close) * 100) / b.close);
  }
  const vwapShare = onSide / since10.length;

  const failed =
    movePct < TREND_RULE.minMovePct
      ? `move ${movePct.toFixed(2)}% from yesterday's close (needs ${TREND_RULE.minMovePct}%)`
      : !orbBroken
        ? 'opening range not broken the trade’s way'
        : vwapShare < TREND_RULE.minVwapShare
          ? `on the right side of VWAP only ${Math.round(vwapShare * 100)}% of the time since 10:00 (needs ${TREND_RULE.minVwapShare * 100}%)`
          : pullbackPct > TREND_RULE.maxPullbackPct
            ? `pulled back ${pullbackPct.toFixed(2)}% since 10:00 (max ${TREND_RULE.maxPullbackPct}%)`
            : null;

  return {
    state: failed == null ? 'trend' : 'not',
    movePct: Math.round(movePct * 100) / 100,
    orbBroken,
    vwapShare: Math.round(vwapShare * 100) / 100,
    pullbackPct: Math.round(pullbackPct * 100) / 100,
    failed,
  };
}

/** Green / hollow / grey for the advisory dot. */
export const trendDot = (s: TrendShape | null): boolean | null => (s == null ? null : s.state === 'trend');

/** One plain-English line for the tooltip. */
export function describeTrend(s: TrendShape | null): string {
  if (s == null) return 'not enough of today’s chart yet (needs the opening range and bars after 10:00)';
  if (s.state === 'trend')
    return `clean trend day: ${s.movePct >= 0 ? '+' : ''}${s.movePct}% the trade’s way, opening range broken, on the right side of VWAP ${Math.round(s.vwapShare * 100)}% of the time, deepest pullback ${s.pullbackPct}%`;
  return `not a clean trend yet — ${s.failed}`;
}
