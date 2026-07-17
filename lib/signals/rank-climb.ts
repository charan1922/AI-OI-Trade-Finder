/**
 * Rank climb — how many spots a name moved UP a movers leaderboard over the
 * trailing ~30 minutes. Positive = climbing (the rank NUMBER is falling:
 * #15 → #7 is a climb of +8), negative = sliding down the board.
 *
 * WHY THIS EXISTS (ADANIENSOL 2026-07-16 post-mortem)
 * ---------------------------------------------------
 * The options-led OI gate is a SNAPSHOT (is nseOiPct ≥ X right now?), so it
 * can't tell "still building" from "stale morning print". Relaxing its NSE%
 * floor to catch ADANIENSOL-class names (TF +₹10.1k, we found 0) floods ~16
 * fires at coin-flip precision — but the leaderboard TRAJECTORY split them:
 * winners were climbing 5/8 while losers climbed only 1/7, and ADANIENSOL
 * climbed gainers #15→#7 and the OI board #50→#26 through the window. The
 * climb is the movie the snapshot can't see.
 *
 * The poller persists every 5-min leaderboard (rank_snapshots, feeds
 * 'gainers'/'oi'), so the 30-min-ago rank is a lookup, not new data.
 *
 * Pure function (no imports) shared by the replay harness variant gate
 * (scripts/replay-lib.ts) — and by the live engine if the multi-day A/B says
 * it earns its place. Same window/baseline convention as combined-oi-slope.ts.
 */

export interface RankPoint {
  /** 5-min bucket epoch seconds (rank_snapshots convention). */
  bucketTs: number;
  /** Position on the board — 1 is the top, so climbing = rank falling. */
  rank: number;
}

/**
 * Spots climbed over the trailing `windowSec` (default 30 min) as of `asOfTs`:
 * `baselineRank − latestRank` (positive = climbing). Baseline = the newest
 * point at least windowSec older than the latest; falls back to the oldest
 * point when the series is younger than the window but at least half of it.
 * Null when the read isn't supportable: <2 points, span under windowSec/2, or
 * the latest point is older than `staleSec` (the name fell off the board —
 * there is no current rank to measure a climb TO).
 */
export function rankClimb(
  series: readonly RankPoint[],
  asOfTs: number,
  windowSec = 1800,
  staleSec = 600
): number | null {
  const pts = series.filter((p) => p.bucketTs <= asOfTs);
  if (pts.length < 2) return null;
  const latest = pts[pts.length - 1];
  if (asOfTs - latest.bucketTs > staleSec) return null;
  let base: RankPoint | null = null;
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
  return base.rank - latest.rank;
}
