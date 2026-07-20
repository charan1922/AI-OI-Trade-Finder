/**
 * PURE checks for the honest path-dependent spot grader (lib/trade-suggest/grade.ts) —
 * no DB, no clocks. The headline case is the exact bug the old scorecard had:
 * a trade that hit its STOP first and only later recovered used to be scored a
 * WIN. Run by the DB-free CI runner AND the box bench.
 */
import { gradeSpotPath } from '../lib/trade-suggest/grade';

export type CheckFn = (name: string, ok: boolean, detail?: string) => void;

const bar = (high: number, low: number, close = (high + low) / 2) => ({ high, low, close });

export function runGradeChecks(check: CheckFn): void {
  // CE plan: entry 100, stop 90 (risk 10), target 120 (reward 20 → RR 2).

  // Target reached with no prior stop → target, +2R.
  const g1 = gradeSpotPath('CE', 100, 90, 120, [bar(105, 99), bar(122, 110)]);
  check('grade CE: clean target → outcome target, +2R', g1?.outcome === 'target' && g1?.outcomeR === 2, `${g1?.outcome} ${g1?.outcomeR}`);

  // THE BUG FIX: stop hit on bar 1, price later runs past the target on bar 2.
  // Old scorecard (maxUp ≥ 1%) scored this a WIN; honest grade = STOP, −1R.
  const g2 = gradeSpotPath('CE', 100, 90, 120, [bar(101, 89), bar(125, 110)]);
  check('grade CE: stop-first then recovers past target → STOP −1R (old code scored a win)', g2?.outcome === 'stop' && g2?.outcomeR === -1, `${g2?.outcome} ${g2?.outcomeR}`);

  // One candle spans BOTH stop and target → conservative STOP (can't prove order).
  const g3 = gradeSpotPath('CE', 100, 90, 120, [bar(125, 88)]);
  check('grade CE: single candle hits both → conservative stop', g3?.outcome === 'stop');

  // Neither level reached → timeout, close-based R. close of last bar = 104.5.
  const g4 = gradeSpotPath('CE', 100, 90, 120, [bar(105, 96), bar(108, 101)]);
  check('grade CE: neither hit → timeout, close-based R 0.45', g4?.outcome === 'timeout' && g4?.outcomeR === 0.45, `${g4?.outcome} ${g4?.outcomeR}`);

  // PE plan: entry 100, stop 110 (risk 10), target 80 (reward 20 → RR 2).
  const g5 = gradeSpotPath('PE', 100, 110, 80, [bar(101, 95), bar(90, 79)]);
  check('grade PE: clean target (down) → target +2R', g5?.outcome === 'target' && g5?.outcomeR === 2, `${g5?.outcome} ${g5?.outcomeR}`);
  const g6 = gradeSpotPath('PE', 100, 110, 80, [bar(111, 99), bar(90, 78)]);
  check('grade PE: stop-first (up) then recovers → STOP −1R', g6?.outcome === 'stop' && g6?.outcomeR === -1, `${g6?.outcome} ${g6?.outcomeR}`);

  // Degenerate / missing plans → null (caller keeps the excursion-only view).
  check('grade: missing stop → null', gradeSpotPath('CE', 100, null, 120, [bar(105, 99)]) === null);
  check('grade: zero risk (entry == stop) → null', gradeSpotPath('CE', 100, 100, 120, [bar(105, 99)]) === null);
  check('grade: target on the wrong side (CE target < entry) → null', gradeSpotPath('CE', 100, 90, 95, [bar(105, 99)]) === null);
  check('grade: no bars → null', gradeSpotPath('CE', 100, 90, 120, []) === null);
}
