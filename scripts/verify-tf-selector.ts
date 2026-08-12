/**
 * CI bench for the TF Running Race selector and the trailing stop — the two
 * pieces that now decide what gets bought and when it gets sold.
 *
 * DB-free and network-free by construction: both modules under test are pure
 * (no db, no env, no clock), so these assertions run in the CI container rather
 * than only on a box with credentials. Same rule as the premium-stop checks —
 * money-touching logic that lives only in a DB-dependent bench is claimed, not
 * verified.
 *
 * The properties here are the ones a future edit could silently break:
 *  - a sub-1.0 TF R-Factor must be structurally unreachable (the −0.317R,
 *    t=−11.12 band that produced the losses this change exists to stop);
 *  - a FROZEN R-Factor must be rejected (APOLLOHOSP 2026-08-11 held rank #1 all
 *    day at R 3.50 and chopped: high level, zero rate);
 *  - MISSING evidence must reject, never pass;
 *  - the trailing stop must only ever TIGHTEN.
 */

import {
  DEFAULT_TF_SELECTOR_CONFIG,
  describeRejections,
  selectTfCandidates,
  type TfSymbolContext,
} from '@/lib/tf-live/selector';
import { boardAtMinute, raceAtMinute, type TfBoardAt } from '@/lib/tf-live/race';
import { isTighterStop, trailedSpotStop } from '@/lib/auto-trade/risk/trailing-stop';
import { MIN_RISK_PCT, TF_BOARD_MAX_AGE_MIN, TF_RACE_MAX_RANK, TRAIL_R } from '@/lib/trade-suggest/config';
import { DEFAULT_SETTINGS } from '@/lib/auto-trade/config';

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Build a board from [symbol, rFactor, pctChange] triples, ranked desc. */
function board(minuteIST: number, rows: [string, number, number][]): TfBoardAt {
  const sorted = [...rows].sort((a, b) => b[1] - a[1]);
  return {
    minuteIST,
    // Distinct per board. Built from the FULL minute-of-day, not minuteIST % 60
    // — 09:36 and 10:36 share a minute-of-hour and would collide.
    capturedAt: `2026-08-12T${String(Math.floor(minuteIST / 60)).padStart(2, '0')}:${String(minuteIST % 60).padStart(2, '0')}:00.000Z`,
    rank: new Map(sorted.map((r, i) => [r[0], i + 1])),
    rFactor: new Map(sorted.map((r) => [r[0], r[1]])),
    pctChange: new Map(sorted.map((r) => [r[0], r[2]])),
    spread: sorted.filter((r) => r[1] > 1).length,
  };
}

const ok = (over: Partial<TfSymbolContext> = {}): TfSymbolContext => ({
  supertrendAligned: true,
  breakout: true,
  premValueCr: 50,
  sinceEntryPct: 0.8,
  ...over,
});

/** 12 names above R=1 so a board clears MIN_SPREAD_SYMBOLS (8). */
const filler = (n: number, base = 1.05): [string, number, number][] =>
  Array.from({ length: n }, (_, i) => [`FILL${i}`, base + i * 0.01, 0.5] as [string, number, number]);

function main(): void {
  console.log('\nTF Running Race selector + trailing stop\n');

  // ── 1. The point-in-time race ────────────────────────────────────────────
  {
    // AAA accumulates (1.2 → 2.4 → 3.6) and overtakes BBB, which fades.
    const boards = [
      board(9 * 60 + 36, [['AAA', 1.2, 2], ['BBB', 3.0, 1], ...filler(12)]),
      board(10 * 60 + 6, [['AAA', 2.4, 2.2], ['BBB', 2.0, 1], ...filler(12)]),
      board(10 * 60 + 36, [['AAA', 3.6, 2.5], ['BBB', 2.0, 1], ...filler(12)]),
    ];
    const race = raceAtMinute(boards, 10 * 60 + 36, TF_RACE_MAX_RANK);
    check('race is available with a valid baseline', race.available);
    check('baseline is the 09:36 board', race.baselineMinuteIST === 9 * 60 + 36, `got ${race.baselineMinuteIST}`);
    const aaa = race.runners.find((r) => r.symbol === 'AAA');
    check('AAA is a runner (climbed to #1)', aaa != null && aaa.rankNow === 1);
    check('deltaR measures the 30-min rate', aaa != null && Math.abs((aaa.deltaR ?? 0) - 1.2) < 1e-9, `got ${aaa?.deltaR}`);
    check('BBB did not climb, so is not a runner', !race.runners.some((r) => r.symbol === 'BBB'));

    // NO LOOKAHEAD: asking at 10:06 must not see the 10:36 board.
    const earlier = raceAtMinute(boards, 10 * 60 + 6, TF_RACE_MAX_RANK);
    const aaaEarly = earlier.runners.find((r) => r.symbol === 'AAA');
    check('as-of 10:06 uses only boards ≤ 10:06', earlier.boardMinuteIST === 10 * 60 + 6);
    check('no lookahead into a later R-Factor', aaaEarly != null && aaaEarly.rFactorNow === 2.4, `got ${aaaEarly?.rFactorNow}`);
  }

  // ── 2. A degenerate board can never be the baseline ──────────────────────
  // TradeFinder zeroes the whole board while resetting for the day (2026-08-10
  // 09:16: all 210 R-Factors exactly 0). Anchoring there ranks in arbitrary
  // order and reports the ENTIRE board as climbing.
  {
    const boards = [
      board(9 * 60 + 36, [['AAA', 0, 0], ['BBB', 0, 0], ['CCC', 0, 0]]),
      board(10 * 60, [['AAA', 2.0, 2], ['BBB', 1.0, 1], ...filler(12)]),
    ];
    const race = raceAtMinute(boards, 10 * 60, TF_RACE_MAX_RANK);
    check('an all-zero board is refused as a baseline', !race.available);
  }

  // ── 3. Sub-1.0 TF R-Factor is structurally unreachable ──────────────────
  // THE headline statistic: TF R < 1.0 → −0.317R over n=1603, t = −11.12.
  {
    const weak: [string, number, number][] = Array.from(
      { length: 30 },
      (_, i) => [`WEAK${i}`, 0.2 + i * 0.01, 2] as [string, number, number]
    );
    const boards = [board(9 * 60 + 36, [...weak, ...filler(12, 1.5)]), board(10 * 60, [...weak, ...filler(12, 1.5)])];
    const race = raceAtMinute(boards, 10 * 60, TF_RACE_MAX_RANK);
    const anyWeak = race.runners.some((r) => r.rFactorNow < 1.0);
    check('no runner below TF R 1.0 survives the rank cap', !anyWeak);
  }

  // ── 4. A FROZEN R-Factor is rejected — the APOLLOHOSP case ──────────────
  {
    const runners = [
      { symbol: 'FROZEN', rankNow: 1, rankAtBaseline: 5, climb: 4, rFactorNow: 3.5, rFactorAgo: 3.5, deltaR: 0, pctChange: -1.6 },
      { symbol: 'MOVING', rankNow: 2, rankAtBaseline: 9, climb: 7, rFactorNow: 3.0, rFactorAgo: 1.8, deltaR: 1.2, pctChange: -3.8 },
    ];
    const ctx = new Map([['FROZEN', ok()], ['MOVING', ok()]]);
    const r = selectTfCandidates(runners, ctx);
    check('frozen R-Factor rejected despite rank #1', !r.candidates.some((c) => c.symbol === 'FROZEN'));
    check('still-accumulating name accepted', r.candidates.some((c) => c.symbol === 'MOVING'));
    check('frozen rejection is counted', r.rejected.frozenR === 1);
  }

  // ── 5. Missing evidence REJECTS — never passes ──────────────────────────
  {
    const base = { rankNow: 1, rankAtBaseline: 5, climb: 4, rFactorNow: 3.0, rFactorAgo: 1.5, deltaR: 1.5, pctChange: 2.5 };
    const cases: [string, Partial<TfSymbolContext> | null, keyof ReturnType<typeof selectTfCandidates>['rejected']][] = [
      ['unknown Supertrend', { supertrendAligned: null }, 'supertrendUnknown'],
      ['Supertrend disagrees', { supertrendAligned: false }, 'supertrendDisagrees'],
      ['no breakout', { breakout: false }, 'noBreakout'],
      ['unknown breakout', { breakout: null }, 'noBreakout'],
      ['unknown premium pool', { premValueCr: null }, 'premiumUnknown'],
      ['thin premium pool', { premValueCr: 3 }, 'thinPremium'],
      ['move already extended', { sinceEntryPct: 5 }, 'moveExhausted'],
    ];
    for (const [label, over, key] of cases) {
      const r = selectTfCandidates([{ symbol: 'X', ...base }], new Map([['X', ok(over ?? {})]]));
      check(`rejects: ${label}`, r.candidates.length === 0 && r.rejected[key] === 1, `n=${r.candidates.length}`);
    }
    // No context row at all.
    const none = selectTfCandidates([{ symbol: 'X', ...base }], new Map());
    check('rejects: no context row at all', none.candidates.length === 0);
    // A null deltaR is UNKNOWN, and unknown must not be treated as flat-but-ok.
    const nullDelta = selectTfCandidates(
      [{ symbol: 'X', ...base, rFactorAgo: null, deltaR: null }],
      new Map([['X', ok()]])
    );
    check('rejects: unknown accumulation rate', nullDelta.candidates.length === 0 && nullDelta.rejected.unknownDeltaR === 1);
    // sinceEntryPct null is NOT a rejection — the other gates already fired.
    const nullSince = selectTfCandidates([{ symbol: 'X', ...base }], new Map([['X', ok({ sinceEntryPct: null })]]));
    check('unrecorded since-09:45 does not block', nullSince.candidates.length === 1);
  }

  // ── 6. Direction comes from TF's own % change ───────────────────────────
  {
    const mk = (pct: number) => ({ symbol: 'X', rankNow: 1, rankAtBaseline: 5, climb: 4, rFactorNow: 3, rFactorAgo: 1.5, deltaR: 1.5, pctChange: pct });
    check('positive TF % change → CE', selectTfCandidates([mk(2.5)], new Map([['X', ok()]])).candidates[0]?.side === 'CE');
    check('negative TF % change → PE', selectTfCandidates([mk(-2.5)], new Map([['X', ok()]])).candidates[0]?.side === 'PE');
    const flat = selectTfCandidates([mk(0.1)], new Map([['X', ok()]]));
    check('a flat name has no direction and is dropped', flat.candidates.length === 0 && flat.rejected.flatPrice === 1);
  }

  // ── 7. Ordering + cap ───────────────────────────────────────────────────
  {
    const runners = [3.9, 3.5, 3.1, 2.8, 2.4, 2.0, 1.8, 1.6, 1.5].map((rf, i) => ({
      symbol: `S${i}`, rankNow: i + 1, rankAtBaseline: i + 10, climb: 9,
      rFactorNow: rf, rFactorAgo: rf - 0.5, deltaR: 0.5, pctChange: 2,
    }));
    const ctx = new Map(runners.map((r) => [r.symbol, ok()]));
    const r = selectTfCandidates(runners, ctx);
    check('capped at maxCandidates', r.candidates.length === DEFAULT_TF_SELECTOR_CONFIG.maxCandidates);
    check('strongest TF R-Factor first', r.candidates[0].tfRFactor === 3.9);
    check(
      'order is strictly descending by TF R',
      r.candidates.every((c, i) => i === 0 || r.candidates[i - 1].tfRFactor >= c.tfRFactor)
    );
  }

  // ── 8. An empty result always explains itself ──────────────────────────
  {
    const r = selectTfCandidates(
      [{ symbol: 'X', rankNow: 1, rankAtBaseline: 5, climb: 4, rFactorNow: 3, rFactorAgo: 3, deltaR: 0, pctChange: 2 }],
      new Map([['X', ok()]])
    );
    const msg = describeRejections(r.rejected, r.considered);
    check('empty result carries a reason', msg.includes('stopped climbing'), msg);
    check('zero runners reads as no race', describeRejections(r.rejected, 0).includes('no runners'));
  }

  // ── 9. Trailing stop: TIGHTEN-ONLY is the safety property ──────────────
  {
    const bull = { direction: 'bullish' as const, entrySpot: 100, currentStop: 99, riskPoints: 1, trailR: 2 };
    check('below the trail trigger, stop is unchanged', trailedSpotStop({ ...bull, favourableExtreme: 101.5 }) === 99);
    check('at +2R the stop advances to extreme − 2R', trailedSpotStop({ ...bull, favourableExtreme: 103 }) === 101);
    check('a lower extreme can never loosen the stop', trailedSpotStop({ ...bull, currentStop: 101, favourableExtreme: 102 }) === 101);
    check('null extreme leaves the stop alone', trailedSpotStop({ ...bull, favourableExtreme: null }) === 99);
    check('zero risk leaves the stop alone', trailedSpotStop({ ...bull, riskPoints: 0, favourableExtreme: 110 }) === 99);
    check('NaN risk leaves the stop alone', trailedSpotStop({ ...bull, riskPoints: Number.NaN, favourableExtreme: 110 }) === 99);
    check('trailR null disables trailing', trailedSpotStop({ ...bull, trailR: null, favourableExtreme: 110 }) === 99);

    const bear = { direction: 'bearish' as const, entrySpot: 100, currentStop: 101, riskPoints: 1, trailR: 2 };
    check('bearish: below trigger unchanged', trailedSpotStop({ ...bear, favourableExtreme: 98.5 }) === 101);
    check('bearish: at +2R stop advances down', trailedSpotStop({ ...bear, favourableExtreme: 97 }) === 99);
    check('bearish: a higher extreme cannot loosen', trailedSpotStop({ ...bear, currentStop: 99, favourableExtreme: 98 }) === 99);

    check('isTighterStop, bullish', isTighterStop('bullish', 99, 101) && !isTighterStop('bullish', 101, 99));
    check('isTighterStop, bearish', isTighterStop('bearish', 101, 99) && !isTighterStop('bearish', 99, 101));

    // Monotonicity under a rising then falling extreme — the real sequence.
    let stop = 99;
    for (const ex of [101, 103, 105, 104, 102, 106, 100]) {
      const next = trailedSpotStop({ ...bull, currentStop: stop, favourableExtreme: ex });
      if (next < stop) { check('stop never loosened across a path', false, `${stop} → ${next} at extreme ${ex}`); break; }
      stop = next;
    }
    check('stop ratcheted to the highest extreme seen', stop === 104, `got ${stop}`);
  }

  // ── 10. Config invariants ──────────────────────────────────────────────
  {
    check('MIN_RISK_PCT widened to 1.0', MIN_RISK_PCT === 1.0, `got ${MIN_RISK_PCT}`);
    check('TRAIL_R is set (fixed target retired)', TRAIL_R === 2, `got ${TRAIL_R}`);
    check('TF board staleness cap is 10 min', TF_BOARD_MAX_AGE_MIN === 10);
    check('race rank cap is 20', TF_RACE_MAX_RANK === 20);
    // The inversion: ONE full stop ends the day. If someone "fixes" this back to
    // 2×, the strategy silently regains the revenge trade it was designed to lose.
    check(
      'one full stop ends the day (halt == per-lot risk)',
      DEFAULT_SETTINGS.dailyLossHaltRupees === DEFAULT_SETTINGS.maxRiskPerLotRupees,
      `halt ${DEFAULT_SETTINGS.dailyLossHaltRupees} vs risk ${DEFAULT_SETTINGS.maxRiskPerLotRupees}`
    );
    check('paper is not the shipped default mode by accident', DEFAULT_SETTINGS.mode === 'off');
  }

  // ── 11. The full board hides nothing (the PNB regression) ───────────────
  // rank-climb is a poor proxy for accumulation: rank is capped, so a name
  // already strong at the baseline cannot climb. On the real 2026-08-12 board
  // that hid PNB at TF R 4.33 — the SECOND-strongest name on the whole board.
  {
    const boards = [
      // ALREADY-STRONG never climbs (it is #1 at the baseline and stays #1).
      board(9 * 60 + 36, [['ALREADYSTRONG', 4.3, 3], ['CLIMBER', 1.1, 2], ...filler(12)]),
      board(10 * 60 + 6, [['ALREADYSTRONG', 4.3, 3], ['CLIMBER', 2.0, 2], ...filler(12)]),
      board(10 * 60 + 36, [['ALREADYSTRONG', 4.4, 3], ['CLIMBER', 3.0, 2], ...filler(12)]),
    ];
    const race = raceAtMinute(boards, 10 * 60 + 36, TF_RACE_MAX_RANK);
    const full = boardAtMinute(boards, 10 * 60 + 36, TF_RACE_MAX_RANK);
    check(
      'climb-filtered race HIDES an already-strong name',
      !race.runners.some((r) => r.symbol === 'ALREADYSTRONG')
    );
    check('full board SHOWS it', full.runners.some((r) => r.symbol === 'ALREADYSTRONG'));
    check('full board leads with the highest TF R', full.runners[0]?.symbol === 'ALREADYSTRONG');
    check(
      'full board is ordered by TF R desc',
      full.runners.every((r, i) => i === 0 || full.runners[i - 1].rFactorNow >= r.rFactorNow)
    );
    check(
      'full board still reports the accumulation rate',
      Math.abs((full.runners.find((r) => r.symbol === 'CLIMBER')?.deltaR ?? 0) - 1.0) < 1e-9
    );
    check('a non-climber gets climb 0, never a fabricated jump',
      full.runners.find((r) => r.symbol === 'ALREADYSTRONG')?.climb === 0);
  }

  // ── 12. Sector evidence must stay OUT of the selector ──────────────────
  // The operator asked whether sectors are considered. They are surfaced as
  // evidence only; if someone later wires sector strength into a gate without
  // a measurement, this is the check that should stop them.
  {
    check(
      'selectTfCandidates has no sector input at all',
      !('sector' in DEFAULT_TF_SELECTOR_CONFIG) &&
        !JSON.stringify(DEFAULT_TF_SELECTOR_CONFIG).toLowerCase().includes('sector')
    );
  }

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
}

main();
