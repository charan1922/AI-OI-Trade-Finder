/**
 * PURE checks for the profit-protection SHADOW (lib/trade-suggest/profit-protect.ts)
 * — no DB, no clocks. Covers the simulator (baseline agreement, the +1R-giveback
 * headline, no-lookahead, trail ratcheting, entry-candle TRIGGER ambiguity, exact
 * boundary, PE) AND the pure aggregation (savedStops / hurt / paired denominators
 * / missing-rule) + the blob parser. Run by the DB-free CI runner AND the box bench.
 */
import { gradeSpotPath } from '../lib/trade-suggest/grade';
import { aggregateProtection, parseProtectBlob, type ProtectAggRow, type ProtectRule, PROTECT_MODEL_VERSION, PROTECT_PRESETS, simulateAllPresets, simulateProtected } from '../lib/trade-suggest/profit-protect';

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

  // 5. Trail locks a gain: MFE +1.8R → stop ratchets to +1.3R (1.8−0.5). The
  //    arming candle CLOSES at +1.4R (above the new stop, so the stop is a valid
  //    resting level), then a LATER candle pulls back through it → exit AT +1.3R.
  const s5 = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 118, 106, 114), bar(1200, 115, 112)], MID, TRAIL);
  check('protect trail: +1.8R (closes above stop) then pullback → protected +1.3R locked', s5?.outcome === 'protected' && s5?.outcomeR === 1.3, `${s5?.outcome} ${s5?.outcomeR}`);

  // 5b. PR#6 #blocker — the arming candle CLOSES BELOW its new trail stop (+1.2R
  //     close vs +1.3R stop). A stop can't rest above the market, so the exit is
  //     the observable close (+1.2R), never the unreachable +1.3R level.
  const s5b = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 118, 106, 112)], MID, TRAIL);
  check('protect trail: arming candle closes below its new stop → exit at close +1.2R (not +1.3R)', s5b?.outcome === 'protected' && s5b?.outcomeR === 1.2, `${s5b?.outcome} ${s5b?.outcomeR}`);

  // 5c. PR#6 — breakeven arms (+1.1R high) but the SAME candle CLOSES below entry
  //     (−0.2R). Price is already through breakeven, so the exit is the close
  //     (−0.2R), NOT a free 0R — the old code overstated breakeven here.
  const s5c = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 111, 98, 98)], MID, BE1);
  check('protect BE@1R: arms but closes below entry → protected −0.2R (not 0R)', s5c?.outcome === 'protected' && s5c?.outcomeR === -0.2, `${s5c?.outcome} ${s5c?.outcomeR}`);

  // 5d. PR#6 — the FINAL candle raises the stop above its own close: exit at the
  //     close (+1.2R), not the timeout floored at the ratcheted +1.3R.
  const s5d = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 110, 104, 108), bar(1200, 118, 112, 112)], MID, TRAIL, 1200);
  check('protect trail: final candle stop above its close → exit at close +1.2R (no timeout floor)', s5d?.outcome === 'protected' && s5d?.outcomeR === 1.2, `${s5d?.outcome} ${s5d?.outcomeR}`);

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

  // 11b. PR#6 — PE arming candle closes above its new stop (adverse side): MFE
  //      +1.8R down (low 82), stop → +1.3R, but the candle closes at +1.2R (spot
  //      88, on the WRONG side of the +1.3R stop) → exit at the close +1.2R.
  const s11b = simulateProtected('PE', 100, 110, 80, [bar(600, 101, 99), bar(900, 90, 82, 88)], MID, TRAIL);
  check('protect PE trail: arming candle closes past its new stop → exit at close +1.2R', s11b?.outcome === 'protected' && s11b?.outcomeR === 1.2, `${s11b?.outcome} ${s11b?.outcomeR}`);

  // 12. Unresolvable cases mirror grade.ts.
  const s12a = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 99), bar(1200, 108, 105)], MID, BE1);
  check('protect: candle gap → incomplete (null)', s12a?.outcome === 'incomplete' && s12a?.outcomeR === null, `${s12a?.outcome}`);
  const s12b = simulateProtected('CE', 100, 90, 120, [bar(600, 105, 96), bar(900, 106, 97)], MID, BE1, 1200);
  check('protect: final candle missing → incomplete (null)', s12b?.outcome === 'incomplete', `${s12b?.outcome}`);
  check('protect: missing stop → null', simulateProtected('CE', 100, null, 120, [bar(600, 105, 99)], MID, BE1) === null);

  // ── Target detection by PRICE, matching grade.ts (PR#6 review blocker) ──────
  //    Decimal plan where rounded plannedRR (1.99) < the exact target's R
  //    (1.989…): a candle touching the exact target price must still be 'target'.
  const dCE = simulateProtected('CE', 100.03, 99.12, 101.84, [bar(600, 100.5, 100), bar(900, 101.84, 100.5)], MID, BE1);
  check('protect CE decimal: candle touches exact target price → target 1.99', dCE?.outcome === 'target' && dCE?.outcomeR === 1.99, `${dCE?.outcome} ${dCE?.outcomeR}`);
  const dPE = simulateProtected('PE', 100.03, 100.94, 98.22, [bar(600, 100.2, 99.8), bar(900, 99, 98.22)], MID, BE1);
  check('protect PE decimal: candle touches exact target price → target 1.99', dPE?.outcome === 'target' && dPE?.outcomeR === 1.99, `${dPE?.outcome} ${dPE?.outcomeR}`);
  const dBoth = simulateProtected('CE', 100.03, 99.12, 101.84, [bar(600, 100.5, 100), bar(900, 101.84, 99.12)], MID, BE1);
  check('protect CE decimal: exact target & stop in one candle → stop wins (−1R)', dBoth?.outcome === 'stop' && dBoth?.outcomeR === -1, `${dBoth?.outcome} ${dBoth?.outcomeR}`);

  // Baseline agreement: a rule that NEVER arms (unreachable trigger) must resolve
  // identically to grade.ts on target / stop / timeout — proves the protection
  // walker and the baseline grader share their target/stop/timeout logic.
  const NEVER: ProtectRule = { name: 'never', triggerR: 99, mode: 'breakeven' };
  const agree = (label: string, opt: 'CE' | 'PE', e: number, sl: number, tg: number, bars: Parameters<typeof simulateProtected>[4], since: number, last?: number) => {
    const g = gradeSpotPath(opt, e, sl, tg, bars, since, last);
    const p = simulateProtected(opt, e, sl, tg, bars, since, NEVER, last);
    check(`baseline agreement: ${label} — protect(never) == grade`, p?.outcome === g?.outcome && p?.outcomeR === g?.outcomeR, `grade ${g?.outcome}/${g?.outcomeR} vs protect ${p?.outcome}/${p?.outcomeR}`);
  };
  agree('target', 'CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 122, 110)], MID);
  agree('stop-first', 'CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 101, 89), bar(1200, 125, 110)], MID);
  agree('timeout', 'CE', 100, 90, 120, [bar(600, 105, 96), bar(900, 106, 97), bar(1200, 104, 101)], MID, 1200);

  // ── Pure aggregation (PR#5 #4): savedStops / hurt / paired denominators / a
  //    row missing one rule only shrinks THAT rule's n. All at the CURRENT
  //    version, so all are counted. ─────────────────────────────────────────────
  const V = PROTECT_MODEL_VERSION;
  const rows: ProtectAggRow[] = [
    { baseR: -1, version: V, rules: { 'breakeven@1R': 0, 'breakeven@1.5R': -1, 'trail@1R-lock0.5': 0.8 } },
    { baseR: 2, version: V, rules: { 'breakeven@1R': 0, 'breakeven@1.5R': 2, 'trail@1R-lock0.5': 2 } },
    { baseR: -0.5, version: V, rules: { 'breakeven@1.5R': -0.5 } }, // BE@1R & trail were entry-ambiguous here
  ];
  const agg = aggregateProtection(rows);
  const be1 = agg.rules.find((r) => r.name === 'breakeven@1R')!;
  const be15 = agg.rules.find((r) => r.name === 'breakeven@1.5R')!;
  const trail = agg.rules.find((r) => r.name === 'trail@1R-lock0.5')!;
  check('agg: overall n=3, baselineAvgR=0.17', agg.n === 3 && agg.baselineAvgR === 0.17, `n=${agg.n} base=${agg.baselineAvgR}`);
  check('agg BE@1R: paired n=2, savedStops=1, hurt=1, ΔR=−0.5', be1.n === 2 && be1.savedStops === 1 && be1.hurt === 1 && be1.deltaR === -0.5, JSON.stringify(be1));
  check('agg BE@1.5R: missing-rule handling → n=3 (only rule present on row 3)', be15.n === 3 && be15.savedStops === 0 && be15.hurt === 0, JSON.stringify(be15));
  check('agg trail: paired n=2, ΔR=+0.9, savedStops=1', trail.n === 2 && trail.deltaR === 0.9 && trail.savedStops === 1, JSON.stringify(trail));

  // ── Version enforcement (PR#6 review): the aggregator MUST NOT mix simulator
  //    versions. Only rows whose `_v` equals the current model version are
  //    averaged; unversioned (pre-_v / PR#5) and other-version rows are excluded
  //    and merely counted, so a shrunk denominator is visible not silent. ───────
  const mixed = [
    { baseR: -1, version: V, rules: { 'breakeven@1R': 0 } }, // current → counted
    { baseR: 2, version: null, rules: { 'breakeven@1R': 0 } }, // unversioned → excludedLegacy
    { baseR: 2, version: 1, rules: { 'breakeven@1R': 2 } }, // old version → excludedOtherVersion
    { baseR: 2, version: V + 1, rules: { 'breakeven@1R': 2 } }, // future version → excludedOtherVersion
  ];
  const magg = aggregateProtection(mixed);
  const mbe1 = magg.rules.find((r) => r.name === 'breakeven@1R')!;
  check(
    'agg version: only current-version row averaged (n=1), others excluded & counted',
    magg.n === 1 && magg.version === V && magg.excludedLegacy === 1 && magg.excludedOtherVersion === 2,
    JSON.stringify({ n: magg.n, v: magg.version, legacy: magg.excludedLegacy, other: magg.excludedOtherVersion }),
  );
  check(
    'agg version: the rule stat reflects ONLY the current-version row (baseR −1, saved 1) — never mixed',
    mbe1.n === 1 && mbe1.baselineAvgR === -1 && mbe1.avgR === 0 && mbe1.savedStops === 1,
    JSON.stringify(mbe1),
  );
  // An explicit target version arg excludes even "current" rows written by a
  // different build — the guard is about the version, not "now".
  const asV1 = aggregateProtection(mixed, PROTECT_PRESETS, 1);
  check('agg version: explicit version=1 selects only the _v:1 row', asV1.n === 1 && asV1.version === 1 && asV1.rules.find((r) => r.name === 'breakeven@1R')!.avgR === 2, `n=${asV1.n}`);

  // ── Blob parser: returns { version, rules }; drops non-numbers + `_`-metadata,
  //    reads `_v` SEPARATELY, never throws on garbage. ─────────────────────────
  const pA = parseProtectBlob('{"a":1,"b":"x","c":2}');
  check('parseProtectBlob: drops non-numeric values, version null when no _v', pA.version === null && JSON.stringify(pA.rules) === '{"a":1,"c":2}', JSON.stringify(pA));
  const pB = parseProtectBlob('{"_v":2,"breakeven@1R":0}');
  check('parseProtectBlob: reads _v version stamp, strips it from rules', pB.version === 2 && JSON.stringify(pB.rules) === '{"breakeven@1R":0}', JSON.stringify(pB));
  const pC = parseProtectBlob('{not json');
  check('parseProtectBlob: malformed JSON → {version:null, rules:{}}', pC.version === null && JSON.stringify(pC.rules) === '{}');
  const pD = parseProtectBlob(null);
  check('parseProtectBlob: null → {version:null, rules:{}}', pD.version === null && JSON.stringify(pD.rules) === '{}');

  // Round-trip: what simulateAllPresets WRITES carries the current _v and parses
  // back to that version — so freshly-written rows are never excluded as legacy.
  const written = parseProtectBlob(JSON.stringify(simulateAllPresets('CE', 100, 90, 120, [bar(600, 105, 99), bar(900, 122, 110)], MID)));
  check('parseProtectBlob: round-trips simulateAllPresets _v stamp', written.version === PROTECT_MODEL_VERSION && written.rules['breakeven@1R'] === 2, JSON.stringify(written));
}
