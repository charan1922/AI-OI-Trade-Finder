/**
 * Combined-OI slope — how fast NSE's combined (futures+options) OI %-change is
 * moving over the trailing ~30 minutes.
 *
 * The oi-spurts feed's nseOiPct is CUMULATIVE since the previous EOD, so a
 * single snapshot can't distinguish "position built at 09:20 and stalled" from
 * "building right now". The Fyers poller persists the value per 5-min bucket
 * (fyers_candles FUT rows, nseOiPct column); the delta across that series is
 * the build RATE — the combined-OI analogue of the futures-only oiUrgency.
 *
 * Pure function shared by the live engine (display factor on picks) and the
 * replay harness (scripts/replay-lib.ts variant gate experiments). Result is
 * pct-POINTS over the window (e.g. +1.4 = combined OI grew 1.4 points of
 * yesterday's base in ~30 min), null when the series is too short to say.
 */

export interface NseOiBucketPoint {
  bucketTs: number;
  nseOiPct: number | null;
}

/**
 * Slope of nseOiPct over the trailing `windowSec` (default 30 min) as of
 * `asOfTs` (epoch seconds). Baseline = the newest point at least windowSec
 * older than the latest; falls back to the oldest available point when the
 * series is younger than the window but at least half of it (under-reads
 * slightly in that case — deliberately conservative). Null with <2 usable
 * points or a span under windowSec/2.
 */
export function combinedOiSlope(series: NseOiBucketPoint[], asOfTs: number, windowSec = 1800): number | null {
  const pts = series.filter((p) => p.nseOiPct != null && p.bucketTs <= asOfTs);
  if (pts.length < 2) return null;
  const latest = pts[pts.length - 1];
  let base: NseOiBucketPoint | null = null;
  for (let i = pts.length - 2; i >= 0; i--) {
    if (latest.bucketTs - pts[i].bucketTs >= windowSec) {
      base = pts[i];
      break;
    }
  }
  if (!base) {
    const oldest = pts[0];
    if (latest.bucketTs - oldest.bucketTs < windowSec / 2) return null;
    base = oldest;
  }
  return Math.round(((latest.nseOiPct as number) - (base.nseOiPct as number)) * 100) / 100;
}
