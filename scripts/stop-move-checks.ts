/**
 * Stop-MOVE guard checks — pure, DB-free, run in CI by verify-quant-shadow.ts.
 *
 * These exist because of a real, measured loss. Review of every executed trade
 * since 2026-07-22 (2026-08-06):
 *  - 12 trades had their spot stop moved to EXACTLY the entry price by the AI's
 *    modify_stop tool; 11 of those were then killed by that stop, for −₹7,535.
 *  - The kills were inside pure noise: MANKIND stopped 0.3 points from its stop,
 *    APLAPOLLO 0.6, LICHSGFIN 1.1, INFY 2.8.
 *  - The AI's stated reason: "spot has moved 2 points above entry; tightening
 *    stop to entry level to reduce risk" — protecting ~0.1R by guaranteeing an exit.
 *  - The repo's OWN profit-protect shadow report (183 resolved picks) had already
 *    measured breakeven stops NEGATIVE: breakeven@1R ΔR −0.07, trail ΔR −0.07.
 *
 * The scanner already floors the stop at PLACEMENT (MIN_RISK_PCT). This asserts
 * the same floor is now enforced on MOVES, and that it FAILS CLOSED — the whole
 * point of a risk gate (see the PR#18 lesson recorded in premium-stop-checks.ts:
 * a gate that reads "cannot calculate" as "allow" is not a gate).
 */
import { MIN_STOP_MOVE_DISTANCE_PCT, checkStopMove } from '../lib/auto-trade/risk/gates';

type Check = (name: string, ok: boolean, detail?: string) => void;

export function runStopMoveChecks(check: Check): void {
  // ── direction discipline (pre-existing behaviour, must not regress) ────────
  check(
    'stop move: a bullish stop may not move DOWN (loosening is never allowed)',
    checkStopMove('bullish', 100, 99, 105).allow === false
  );
  check(
    'stop move: a bearish stop may not move UP (loosening is never allowed)',
    checkStopMove('bearish', 100, 101, 95).allow === false
  );
  check('stop move: a non-finite stop is refused', checkStopMove('bullish', 100, Number.NaN, 105).allow === false);
  check('stop move: a zero/negative stop is refused', checkStopMove('bullish', 100, 0, 105).allow === false);

  // ── the noise floor: THE regression this file exists for ───────────────────
  // BAJAJFINSV 2026-07-31, reproduced exactly: entry/spot 1997, AI moved the
  // stop to 1997 ("tightening stop to entry level"). Stopped out for −₹1,020.
  const bajaj = checkStopMove('bullish', 1983.3, 1997, 1997);
  check('stop move: THE BUG — moving the stop to breakeven at spot is REFUSED', bajaj.allow === false);
  check(
    'stop move: the refusal explains it is inside the noise floor',
    bajaj.reasons[0]?.includes('noise floor') === true,
    bajaj.reasons[0]
  );

  // MANKIND 2026-07-31: bearish, entry 2450.1, stop moved to 2450.1, stopped
  // out 0.3 points later for −₹75.
  check(
    'stop move: the bearish breakeven case is refused too',
    checkStopMove('bearish', 2458.68, 2450.1, 2450.1).allow === false
  );

  // A stop just INSIDE the floor is refused; just OUTSIDE is allowed. At spot
  // 1000 the floor is 3.50, so 997.00 is exactly at it and 996.00 is clear.
  check('stop move: just inside the floor is refused', checkStopMove('bullish', 990, 997.4, 1000).allow === false);
  check('stop move: exactly AT the floor is allowed (the check is <, not <=)', checkStopMove('bullish', 990, 996.5, 1000).allow === true);
  check('stop move: comfortably outside the floor is allowed', checkStopMove('bullish', 990, 995, 1000).allow === true);
  check(
    'stop move: a genuine trailing tighten still works (bearish)',
    checkStopMove('bearish', 1010, 1004, 1000).allow === true
  );

  // ── fails CLOSED (the PR#18 lesson) ────────────────────────────────────────
  check('stop move: a MISSING spot refuses the move (never assumed safe)', checkStopMove('bullish', 990, 995, null).allow === false);
  check('stop move: an undefined spot refuses the move', checkStopMove('bullish', 990, 995, undefined).allow === false);
  check('stop move: a NaN spot refuses the move', checkStopMove('bullish', 990, 995, Number.NaN).allow === false);
  check('stop move: a zero spot refuses the move', checkStopMove('bullish', 990, 995, 0).allow === false);
  check(
    'stop move: refusing on an unknown spot leaves the EXISTING stop in place (the safe direction)',
    checkStopMove('bullish', 990, 995, null).reasons[0]?.includes('existing stop stands') === true
  );

  // ── a stop through spot is an exit, not a move ─────────────────────────────
  check(
    'stop move: a bullish stop at/above spot is refused as an exit, not a move',
    checkStopMove('bullish', 900, 1001, 1000).allow === false
  );
  check(
    'stop move: a bearish stop at/below spot is refused as an exit, not a move',
    checkStopMove('bearish', 1100, 999, 1000).allow === false
  );

  // ── the floor tracks the constant, not a hard-coded number ────────────────
  check(
    'stop move: the floor is MIN_STOP_MOVE_DISTANCE_PCT of spot, not a fixed rupee amount',
    (() => {
      const spot = 20000; // a high-priced name (BOSCHLTD/FORCEMOT class)
      const floor = (spot * MIN_STOP_MOVE_DISTANCE_PCT) / 100; // 70 points
      return (
        checkStopMove('bullish', spot - 200, spot - floor + 1, spot).allow === false &&
        checkStopMove('bullish', spot - 200, spot - floor - 1, spot).allow === true
      );
    })(),
    `floor at spot 20000 = ${(20000 * MIN_STOP_MOVE_DISTANCE_PCT) / 100}`
  );

  // FORCEMOT 2026-08-05: entry 18770, stopped at 18693 (77 points). Under the
  // new floor (18770 × 0.35% = 65.7) a stop at entry would have been refused.
  check(
    'stop move: FORCEMOT 05-Aug — a stop at entry 18770 would now be refused',
    checkStopMove('bullish', 18600, 18770, 18770).allow === false
  );
}
