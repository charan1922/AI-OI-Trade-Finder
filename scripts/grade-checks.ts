/**
 * PURE checks for the honest path-dependent spot grader (lib/trade-suggest/grade.ts) —
 * no DB, no clocks. Covers the headline bug (stop-first-then-recover ≠ win) AND
 * the 5-min blind-spot cases from the PR#3 review: the entry candle, missing
 * candles, and an early-truncated session. Run by the DB-free CI runner AND the
 * box bench.
 */
import { gradeSpotPath } from '../lib/trade-suggest/grade';

export type CheckFn = (name: string, ok: boolean, detail?: string) => void;

// 5-min buckets in seconds. Entry candle at 600; a mid-candle suggestion sits at
// 700 (inside [600, 900)); the boundary case uses exactly 600.
const bar = (bucketTs: number, high: number, low: number, close = (high + low) / 2) => ({ bucketTs, high, low, close });
const MID = 700; // mid entry-candle suggestion
const BND = 600; // on the bucket boundary

export function runGradeChecks(check: CheckFn): void {
  // CE plan: entry 100, stop 90 (risk 10), target 120 (reward 20 → RR 2).

  // Clean target: entry candle (600) clear; target hit on a contiguous later bar.
  const g1 = gradeSpotPath('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 122, 110)], MID);
  check('grade CE: clean target → target +2R', g1?.outcome === 'target' && g1?.outcomeR === 2, `${g1?.outcome} ${g1?.outcomeR}`);

  // THE BUG: stop on the first post-entry bar, later runs past target → STOP.
  const g2 = gradeSpotPath('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 101, 89), bar(1200, 125, 110)], MID);
  check('grade CE: stop-first then recovers → STOP −1R (old code scored a win)', g2?.outcome === 'stop' && g2?.outcomeR === -1, `${g2?.outcome} ${g2?.outcomeR}`);

  // PR#3 #1 — the ENTRY candle touched the stop: unknowable timing → ambiguous,
  // NOT a false target from the next bar. (The 10:03-suggestion / stop-at-10:04 case.)
  const gA = gradeSpotPath('CE', 100, 90, 120, [bar(600, 101, 89), bar(900, 125, 110)], MID);
  check('grade CE: stop touched inside the entry candle → entry-ambiguous (null R)', gA?.outcome === 'entry-ambiguous' && gA?.outcomeR === null, `${gA?.outcome}`);

  // Entry candle touched the TARGET → also ambiguous (could be pre-suggestion).
  const gB = gradeSpotPath('CE', 100, 90, 120, [bar(600, 122, 100), bar(900, 118, 112)], MID);
  check('grade CE: target touched inside the entry candle → entry-ambiguous', gB?.outcome === 'entry-ambiguous');

  // Boundary suggestion (exactly on the bucket): the whole entry candle is
  // post-suggestion → graded normally, NOT ambiguous.
  const gBnd = gradeSpotPath('CE', 100, 90, 120, [bar(600, 122, 110), bar(900, 118, 112)], BND);
  check('grade CE: boundary suggestion includes the entry candle → target +2R', gBnd?.outcome === 'target' && gBnd?.outcomeR === 2, `${gBnd?.outcome}`);

  // PR#3 #4 — missing entry candle (no bar at 600): a stop could have hit unseen.
  const gMiss = gradeSpotPath('CE', 100, 90, 120, [bar(900, 110, 100)], MID);
  check('grade CE: missing entry candle → incomplete (null R)', gMiss?.outcome === 'incomplete' && gMiss?.outcomeR === null, `${gMiss?.outcome}`);

  // PR#3 #4 — gap before the target (900 missing): a hidden stop can't be ruled
  // out → incomplete, not target.
  const gGap = gradeSpotPath('CE', 100, 90, 120, [bar(600, 105, 99), bar(1200, 125, 110)], MID);
  check('grade CE: candle gap before target → incomplete (hidden stop possible)', gGap?.outcome === 'incomplete', `${gGap?.outcome}`);

  // PR#3 #4 — timeout whose data ends >1 candle before the session's last bucket.
  const gTrunc = gradeSpotPath('CE', 100, 90, 120, [bar(600, 105, 96), bar(900, 106, 97), bar(1200, 105, 98)], MID, 3000);
  check('grade CE: early-truncated session (no hit) → incomplete', gTrunc?.outcome === 'incomplete', `${gTrunc?.outcome}`);

  // Clean full-session timeout: neither hit, data runs to the expected last bar.
  const gTo = gradeSpotPath('CE', 100, 90, 120, [bar(600, 105, 96), bar(900, 106, 97), bar(1200, 104, 101)], MID, 1200);
  check('grade CE: full-session neither hit → timeout, close-based R 0.25', gTo?.outcome === 'timeout' && gTo?.outcomeR === 0.25, `${gTo?.outcome} ${gTo?.outcomeR}`);

  // Same candle spans both stop and target → conservative STOP.
  const gBoth = gradeSpotPath('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 125, 88)], MID);
  check('grade CE: one post-entry candle hits both → conservative stop', gBoth?.outcome === 'stop');

  // PE plan: entry 100, stop 110 (risk 10), target 80 (reward 20 → RR 2).
  const gPeT = gradeSpotPath('PE', 100, 110, 80, [bar(600, 101, 95), bar(900, 90, 79)], MID);
  check('grade PE: clean target (down) → target +2R', gPeT?.outcome === 'target' && gPeT?.outcomeR === 2, `${gPeT?.outcome}`);
  const gPeS = gradeSpotPath('PE', 100, 110, 80, [bar(600, 105, 99), bar(900, 111, 99)], MID);
  check('grade PE: stop-first (up) → STOP −1R', gPeS?.outcome === 'stop' && gPeS?.outcomeR === -1, `${gPeS?.outcome}`);

  // Degenerate / missing inputs → null (caller keeps the excursion-only view).
  check('grade: missing stop → null', gradeSpotPath('CE', 100, null, 120, [bar(600, 105, 99)], MID) === null);
  check('grade: zero risk (entry == stop) → null', gradeSpotPath('CE', 100, 100, 120, [bar(600, 105, 99)], MID) === null);
  check('grade: target on the wrong side → null', gradeSpotPath('CE', 100, 90, 95, [bar(600, 105, 99)], MID) === null);
  check('grade: no bars → null', gradeSpotPath('CE', 100, 90, 120, [], MID) === null);
  check('grade: non-positive suggestion time → null', gradeSpotPath('CE', 100, 90, 120, [bar(600, 105, 99)], 0) === null);
}
