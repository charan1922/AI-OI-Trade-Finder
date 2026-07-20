/**
 * PURE checks for the profit-protection SHADOW simulator
 * (lib/trade-suggest/profit-protect.ts) — no DB, no clocks. Proves the
 * counterfactual matches the fixed-plan baseline where it should (clean target,
 * pre-trigger stop) and diverges exactly where the protection rule earns its
 * keep (a +1R runner that gives it back is scratched at breakeven, not −1R).
 * Run by the DB-free CI runner AND the box bench.
 */
import { PROTECT_PRESETS, simulateAllPresets, simulateProtected } from '../lib/trade-suggest/profit-protect';

export type CheckFn = (name: string, ok: boolean, detail?: string) => void;

const bar = (bucketTs: number, high: number, low: number, close = (high + low) / 2) => ({ bucketTs, high, low, close });
const MID = 700; // mid entry-candle suggestion (entry candle at 600)

// CE plan throughout: entry 100, stop 90 (risk 10), target 120 (RR 2).
// +1R = spot 110; +1.5R = 115; +2R (target) = 120.
const BE1 = PROTECT_PRESETS.find((r) => r.name === 'breakeven@1R')!;
const TRAIL = PROTECT_PRESETS.find((r) => r.name === 'trail@1R-lock0.5')!;

export function runProfitProtectChecks(check: CheckFn): void {
  // 1. Stop hit BEFORE the +1R trigger → still a full −1R stop (protection never
  //    armed). Must match grade.ts's baseline exactly.
  const s1 = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 101, 89)], MID, BE1);
  check('protect BE@1R: stop before trigger → stop −1R', s1?.outcome === 'stop' && s1?.outcomeR === -1, `${s1?.outcome} ${s1?.outcomeR}`);

  // 2. THE HEADLINE: reaches +1.3R, then crashes through the original stop. The
  //    baseline takes −1R; breakeven exits at 0R when price returns to entry
  //    FIRST — the exact "loser that reached +1R" the investigation flagged.
  const s2 = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 113, 105), bar(1200, 108, 89)], MID, BE1);
  check('protect BE@1R: +1.3R then reverses to stop → protected 0R (baseline was −1R)', s2?.outcome === 'protected' && s2?.outcomeR === 0, `${s2?.outcome} ${s2?.outcomeR}`);

  // 3. Clean target is untouched by protection → still +2R.
  const s3 = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 122, 110)], MID, BE1);
  check('protect BE@1R: clean target → target +2R', s3?.outcome === 'target' && s3?.outcomeR === 2, `${s3?.outcome} ${s3?.outcomeR}`);

  // 4. No intra-candle lookahead: the SAME candle spikes to +1.3R and crashes to
  //    the stop. The stop that guards this candle is still −1R (set from prior
  //    bars), so it's a −1R stop — protection can't use this candle's own high to
  //    save this candle's low.
  const s4 = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 113, 89)], MID, BE1);
  check('protect BE@1R: +1R and stop in one candle → stop −1R (no lookahead)', s4?.outcome === 'stop' && s4?.outcomeR === -1, `${s4?.outcome} ${s4?.outcomeR}`);

  // 5. Trail locks a gain: MFE reaches +1.8R, stop ratchets to +1.3R (1.8−0.5),
  //    price pulls back through it → exit AT the locked +1.3R level.
  const s5 = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 118, 106), bar(1200, 115, 112)], MID, TRAIL);
  check('protect trail@1R-lock0.5: +1.8R then pullback → protected +1.3R locked', s5?.outcome === 'protected' && s5?.outcomeR === 1.3, `${s5?.outcome} ${s5?.outcomeR}`);

  // 6. Below the trigger the whole time → plain timeout, close-based (== baseline).
  const s6 = simulateProtected('CE', 100, 90, 120, [bar(600, 104, 98), bar(900, 105, 99, 102)], MID, BE1, 900);
  check('protect BE@1R: never triggers → timeout close-based 0.2', s6?.outcome === 'timeout' && s6?.outcomeR === 0.2, `${s6?.outcome} ${s6?.outcomeR}`);

  // 7. Unresolvable cases mirror grade.ts (excluded from any aggregate).
  const s7 = simulateProtected('CE', 100, 90, 120, [bar(600, 101, 89), bar(900, 125, 110)], MID, BE1);
  check('protect: stop inside entry candle → entry-ambiguous (null)', s7?.outcome === 'entry-ambiguous' && s7?.outcomeR === null, `${s7?.outcome}`);
  const s8 = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 99), bar(1200, 108, 105)], MID, BE1);
  check('protect: candle gap → incomplete (null)', s8?.outcome === 'incomplete' && s8?.outcomeR === null, `${s8?.outcome}`);
  const s9 = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 96), bar(900, 106, 97)], MID, BE1, 1200);
  check('protect: final candle missing → incomplete (null)', s9?.outcome === 'incomplete', `${s9?.outcome}`);

  // 8. Degenerate plan → null (like grade.ts).
  check('protect: missing stop → null', simulateProtected('CE', 100, null, 120, [bar(600, 105, 99)], MID, BE1) === null);

  // 9. PE direction: reaches +1.3R down then reverses up to entry → breakeven 0R.
  //    PE plan: entry 100, stop 110 (risk 10), target 80. +1R = spot 90.
  const sPe = simulateProtected('PE', 100, 110, 80, [bar(600, 101, 99), bar(900, 95, 87), bar(1200, 111, 92)], MID, BE1);
  check('protect PE BE@1R: +1.3R down then reverses to stop → protected 0R', sPe?.outcome === 'protected' && sPe?.outcomeR === 0, `${sPe?.outcome} ${sPe?.outcomeR}`);

  // 10. simulateAllPresets: the headline path — BE@1R scratches (0), BE@1.5R never
  //     arms so takes the full −1R, trail@1R locks +0.8R (MFE 1.3 − 0.5).
  const all = simulateAllPresets('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 113, 105), bar(1200, 108, 89)], MID);
  check('protect presets: BE@1R=0, BE@1.5R=−1, trail=+0.8 on the same path', all['breakeven@1R'] === 0 && all['breakeven@1.5R'] === -1 && all['trail@1R-lock0.5'] === 0.8, JSON.stringify(all));
}
