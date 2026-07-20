/**
 * PURE checks for the profit-protection SHADOW (lib/trade-suggest/profit-protect.ts)
 * — no DB, no clocks. Covers the simulator (baseline agreement, the +1R-giveback
 * headline, no-lookahead, trail ratcheting, entry-candle TRIGGER ambiguity, exact
 * boundary, PE) AND the pure aggregation (savedStops / hurt / paired denominators
 * / missing-rule) + the blob parser. Run by the DB-free CI runner AND the box bench.
 */
import { aggregateProtection, parseProtectBlob, PROTECT_PRESETS, simulateAllPresets, simulateProtected } from '../lib/trade-suggest/profit-protect';

export type CheckFn = (name: string, ok: boolean, detail?: string) => void;

const bar = (bucketTs: number, high: number, low: number, close = (high + low) / 2) => ({ bucketTs, high, low, close });
const MID = 700; // mid entry-candle suggestion (entry candle at 600)

// CE plan throughout: entry 100, stop 90 (risk 10), target 120 (RR 2).
// +1R = spot 110; +1.5R = 115; +2R (target) = 120.
const BE1 = PROTECT_PRESETS.find((r) => r.name === 'breakeven@1R')!;
const BE15 = PROTECT_PRESETS.find((r) => r.name === 'breakeven@1.5R')!;
const TRAIL = PROTECT_PRESETS.find((r) => r.name === 'trail@1R-lock0.5')!;

export function runProfitProtectChecks(check: CheckFn): void {
  // 1. Stop hit BEFORE the +1R trigger → still a full −1R stop (protection never
  //    armed). Must match grade.ts's baseline exactly.
  const s1 = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 101, 89)], MID, BE1);
  check('protect BE@1R: stop before trigger → stop −1R', s1?.outcome === 'stop' && s1?.outcomeR === -1, `${s1?.outcome} ${s1?.outcomeR}`);

  // 2. THE HEADLINE: reaches +1.3R (on a LATER candle, not the entry candle), then
  //    crashes through the original stop. Baseline takes −1R; breakeven exits at
  //    0R when price returns to entry first.
  const s2 = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 113, 105), bar(1200, 108, 89)], MID, BE1);
  check('protect BE@1R: +1.3R then reverses to stop → protected 0R (baseline was −1R)', s2?.outcome === 'protected' && s2?.outcomeR === 0, `${s2?.outcome} ${s2?.outcomeR}`);

  // 3. Clean target is untouched by protection → still +2R (level-fill).
  const s3 = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 122, 110)], MID, BE1);
  check('protect BE@1R: clean target → target +2R', s3?.outcome === 'target' && s3?.outcomeR === 2, `${s3?.outcome} ${s3?.outcomeR}`);

  // 4. No intra-candle lookahead: the SAME later candle spikes to +1.3R and
  //    crashes to the stop → −1R (its high can't arm the stop that guards its low).
  const s4 = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 113, 89)], MID, BE1);
  check('protect BE@1R: +1R and stop in one candle → stop −1R (no lookahead)', s4?.outcome === 'stop' && s4?.outcomeR === -1, `${s4?.outcome} ${s4?.outcomeR}`);

  // 5. Trail locks a gain: MFE +1.8R → stop ratchets to +1.3R (1.8−0.5), pullback
  //    through it → exit AT the locked +1.3R.
  const s5 = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 118, 106), bar(1200, 115, 112)], MID, TRAIL);
  check('protect trail: +1.8R then pullback → protected +1.3R locked', s5?.outcome === 'protected' && s5?.outcomeR === 1.3, `${s5?.outcome} ${s5?.outcomeR}`);

  // 6. Below the trigger the whole time → plain timeout, close-based (== baseline).
  const s6 = simulateProtected('CE', 100, 90, 120, [bar(600, 104, 98), bar(900, 105, 99, 102)], MID, BE1, 900);
  check('protect BE@1R: never triggers → timeout close-based 0.2', s6?.outcome === 'timeout' && s6?.outcomeR === 0.2, `${s6?.outcome} ${s6?.outcomeR}`);

  // 7. PR#5 #1 — the ENTRY candle itself reached the trigger. Timing within it is
  //    unknowable, so the RULE whose trigger it touched is entry-ambiguous, while
  //    a STRICTER rule whose trigger it did NOT reach still resolves.
  const entryHot = [bar(600, 113, 101), bar(900, 108, 89)]; // entry candle MFE +1.3R
  const e1 = simulateProtected('CE', 100, 90, 120, entryHot, MID, BE1);
  const e15 = simulateProtected('CE', 100, 90, 120, entryHot, MID, BE15);
  check('protect BE@1R: entry candle reached +1.3R → entry-ambiguous (null)', e1?.outcome === 'entry-ambiguous' && e1?.outcomeR === null, `${e1?.outcome}`);
  check('protect BE@1.5R: entry candle only +1.3R (< trigger) → still resolves (stop −1R)', e15?.outcome === 'stop' && e15?.outcomeR === -1, `${e15?.outcome} ${e15?.outcomeR}`);
  const eBlob = simulateAllPresets('CE', 100, 90, 120, entryHot, MID);
  check('protect presets: hot entry candle omits BE@1R & trail (ambiguous), keeps BE@1.5R', eBlob['breakeven@1R'] === undefined && eBlob['trail@1R-lock0.5'] === undefined && eBlob['breakeven@1.5R'] === -1, JSON.stringify(eBlob));

  // 8. Exact trigger boundary: a later candle whose MFE is EXACTLY 1.00R arms
  //    breakeven (trigger is inclusive, `>=`), so a return to entry exits at 0R.
  const s8 = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 110, 104), bar(1200, 106, 100)], MID, BE1);
  check('protect BE@1R: exactly +1.00R arms breakeven → protected 0R', s8?.outcome === 'protected' && s8?.outcomeR === 0, `${s8?.outcome} ${s8?.outcomeR}`);

  // 9. Protected stop AND target in the same later candle → conservative stop wins
  //    (breakeven 0R), never the target.
  const s9 = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 111, 105), bar(1200, 125, 99)], MID, BE1);
  check('protect BE@1R: armed, then a candle spans breakeven-stop & target → protected 0R (stop wins)', s9?.outcome === 'protected' && s9?.outcomeR === 0, `${s9?.outcome} ${s9?.outcomeR}`);

  // 10. Trail ratchets MONOTONICALLY (never loosens): MFE 1.2R (stop→0.7) then
  //     1.6R (stop→1.1); a later pullback to +1.0R exits at the RATCHETED 1.1R,
  //     not the earlier 0.7R (which would not have triggered at +1.0R).
  const s10 = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 112, 106), bar(1200, 116, 111), bar(1500, 114, 110)], MID, TRAIL);
  check('protect trail: stop ratchets up & never loosens → protected +1.1R', s10?.outcome === 'protected' && s10?.outcomeR === 1.1, `${s10?.outcome} ${s10?.outcomeR}`);

  // 11. PE trailing stop: MFE +1.2R down → stop locks +0.7R, adverse rally hits it.
  //     PE plan: entry 100, stop 110 (risk 10), target 80. +1R = spot 90.
  const s11 = simulateProtected('PE', 100, 110, 80, [bar(600, 101, 99), bar(900, 96, 88), bar(1200, 94, 91)], MID, TRAIL);
  check('protect PE trail: +1.2R down then rally → protected +0.7R locked', s11?.outcome === 'protected' && s11?.outcomeR === 0.7, `${s11?.outcome} ${s11?.outcomeR}`);

  // 12. Unresolvable cases mirror grade.ts.
  const s12a = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 99), bar(1200, 108, 105)], MID, BE1);
  check('protect: candle gap → incomplete (null)', s12a?.outcome === 'incomplete' && s12a?.outcomeR === null, `${s12a?.outcome}`);
  const s12b = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 96), bar(900, 106, 97)], MID, BE1, 1200);
  check('protect: final candle missing → incomplete (null)', s12b?.outcome === 'incomplete', `${s12b?.outcome}`);
  check('protect: missing stop → null', simulateProtected('CE', 100, null, 120, [bar(600, 105, 99)], MID, BE1) === null);

  // ── Pure aggregation (PR#5 #4): savedStops / hurt / paired denominators / a
  //    row missing one rule only shrinks THAT rule's n. ─────────────────────────
  const rows = [
    { baseR: -1, blob: { 'breakeven@1R': 0, 'breakeven@1.5R': -1, 'trail@1R-lock0.5': 0.8 } },
    { baseR: 2, blob: { 'breakeven@1R': 0, 'breakeven@1.5R': 2, 'trail@1R-lock0.5': 2 } },
    { baseR: -0.5, blob: { 'breakeven@1.5R': -0.5 } }, // BE@1R & trail were entry-ambiguous here
  ];
  const agg = aggregateProtection(rows);
  const be1 = agg.rules.find((r) => r.name === 'breakeven@1R')!;
  const be15 = agg.rules.find((r) => r.name === 'breakeven@1.5R')!;
  const trail = agg.rules.find((r) => r.name === 'trail@1R-lock0.5')!;
  check('agg: overall n=3, baselineAvgR=0.17', agg.n === 3 && agg.baselineAvgR === 0.17, `n=${agg.n} base=${agg.baselineAvgR}`);
  check('agg BE@1R: paired n=2, savedStops=1, hurt=1, ΔR=−0.5', be1.n === 2 && be1.savedStops === 1 && be1.hurt === 1 && be1.deltaR === -0.5, JSON.stringify(be1));
  check('agg BE@1.5R: missing-rule handling → n=3 (only rule present on row 3)', be15.n === 3 && be15.savedStops === 0 && be15.hurt === 0, JSON.stringify(be15));
  check('agg trail: paired n=2, ΔR=+0.9, savedStops=1', trail.n === 2 && trail.deltaR === 0.9 && trail.savedStops === 1, JSON.stringify(trail));

  // ── Blob parser: drops non-numbers, never throws on garbage. ────────────────
  check('parseProtectBlob: drops non-numeric values', JSON.stringify(parseProtectBlob('{"a":1,"b":"x","c":2}')) === '{"a":1,"c":2}');
  check('parseProtectBlob: malformed JSON → {}', JSON.stringify(parseProtectBlob('{not json')) === '{}');
  check('parseProtectBlob: null → {}', JSON.stringify(parseProtectBlob(null)) === '{}');
}
