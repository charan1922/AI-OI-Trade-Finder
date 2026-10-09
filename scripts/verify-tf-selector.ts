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
import {
  boardAtMinute,
  dropPreOpen,
  raceAtMinute,
  raceCaptures,
  tfCandidatesAtMinute,
  type TfBoardAt,
  type TfRunnerAt,
} from '@/lib/tf-live/race';
import { sinceEntryFromBars } from '@/lib/tf-live/context';
import { deriveSessionContext } from '@/lib/signals/session-context';
import {
  allPass,
  climberIntervals,
  climbedStocks,
  climbingSince,
  droppedClimbers,
  firstNeed,
  gateStrip,
  pickSector,
  rPath,
  rTrend,
} from '@/lib/tf-live/board-view';
import { isTighterStop, trailedSpotStop } from '@/lib/auto-trade/risk/trailing-stop';
import { MIN_RISK_PCT, TF_BOARD_MAX_AGE_MIN, TF_RACE_MAX_RANK, TRAIL_R } from '@/lib/trade-suggest/config';
import { DEFAULT_SETTINGS } from '@/lib/auto-trade/config';
import { ADR_MAX_STALE_DAYS, dayBaseline, measureStretch } from '@/lib/tf-live/stretch';

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
  breakout15: true,
  tfBeacon: 'BULL',
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
    // Both are PE (negative %), so both carry the matching BEAR beacon.
    const ctx = new Map([['FROZEN', ok({ tfBeacon: 'BEAR' })], ['MOVING', ok({ tfBeacon: 'BEAR' })]]);
    const r = selectTfCandidates(runners, ctx);
    check('frozen R-Factor rejected despite rank #1', !r.candidates.some((c) => c.symbol === 'FROZEN'));
    check('still-accumulating name accepted', r.candidates.some((c) => c.symbol === 'MOVING'));
    check('frozen rejection is counted', r.rejected.frozenR === 1);
  }

  // ── 5. Missing evidence REJECTS — never passes ──────────────────────────
  {
    const base = { rankNow: 1, rankAtBaseline: 5, climb: 4, rFactorNow: 3.0, rFactorAgo: 1.5, deltaR: 1.5, pctChange: 2.5 };
    const cases: [string, Partial<TfSymbolContext> | null, keyof ReturnType<typeof selectTfCandidates>['rejected']][] = [
      ['no breakout', { breakout: false }, 'noBreakout'],
      ['no TF breakout beacon', { tfBeacon: null }, 'noTfBeacon'],
      ['TF beacon against the trade (BEAR on a CE)', { tfBeacon: 'BEAR' }, 'noTfBeacon'],
      // Unknown is counted apart from "not cleared" so the narration never calls missing data a failed range.
      ['unknown breakout (no price data)', { breakout: null }, 'breakoutUnknown'],
      ['unknown premium pool', { premValueCr: null }, 'premiumUnknown'],
      ['thin premium pool', { premValueCr: 3 }, 'thinPremium'],
      ['move already extended', { sinceEntryPct: 5 }, 'moveExhausted'],
    ];
    for (const [label, over, key] of cases) {
      const r = selectTfCandidates([{ symbol: 'X', ...base }], new Map([['X', ok(over ?? {})]]));
      check(`rejects: ${label}`, r.candidates.length === 0 && r.rejected[key] === 1, `n=${r.candidates.length}`);
    }
    for (const supertrendAligned of [null, false]) {
      const r = selectTfCandidates(
        [{ symbol: 'X', ...base }],
        new Map([['X', ok({ supertrendAligned })]])
      );
      check(`Supertrend ${supertrendAligned === null ? 'unknown' : 'disagreement'} is ignored`, r.candidates.length === 1);
    }
    // The GATE is the 30-min ORB (operator, 2026-10-09: "make ORB 30 mins");
    // the 15-min result is a recorded shadow that never decides.
    check(
      '15-min ORB is never a gate',
      selectTfCandidates([{ symbol: 'X', ...base }], new Map([['X', ok({ breakout15: false })]])).candidates.length === 1,
    );
    const why = selectTfCandidates([{ symbol: 'X', ...base }], new Map([['X', ok({ breakout15: false })]])).candidates[0]?.reasons.join(' | ') ?? '';
    check('the gate is described as the 30-min opening range', /cleared its 30-min opening range/.test(why), why);
    check('15-min ORB result is recorded in the reasons as a shadow', /15-min ORB: not cleared \(shadow/.test(why), why);
    check('TF beacon agreement is recorded in the reasons', /TF breakout beacon BULL/.test(why), why);
    // No context row at all.
    const none = selectTfCandidates([{ symbol: 'X', ...base }], new Map());
    check('rejects: no context row at all', none.candidates.length === 0 && none.rejected.noBoard === 1);
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
    check('negative TF % change → PE', selectTfCandidates([mk(-2.5)], new Map([['X', ok({ tfBeacon: 'BEAR' })]])).candidates[0]?.side === 'PE');
    check('a PE needs a BEAR beacon — BULL rejects it', selectTfCandidates([mk(-2.5)], new Map([['X', ok()]])).rejected.noTfBeacon === 1);
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

  // ── 13. 15-min ORB (09:15–09:30) for the TF selector; 30-min unchanged ──
  {
    // Bar-start epoch seconds for an IST minute on 2026-10-08.
    const at = (minIST: number) => Date.UTC(2026, 9, 8, 0, 0, 0) / 1000 + (minIST - 330) * 60;
    const bar = (minIST: number, high: number, low: number) => ({ bucketTs: at(minIST), high, low });
    const early = [bar(555, 101, 100), bar(560, 102, 100.5)]; // 09:15, 09:20
    const sc0 = deriveSessionContext(early);
    check('15-min range is NOT complete before the 09:25 bar', sc0.openRange15Complete === false);
    const full = [...early, bar(565, 101.5, 100.2), bar(570, 103, 101), bar(575, 102, 101), bar(580, 102.5, 101)];
    const sc = deriveSessionContext(full);
    check('15-min range = 09:15–09:30 bars only', sc.openRange15High === 102 && sc.openRange15Low === 100 && sc.openRange15Complete);
    check('30-min range unchanged (09:15–09:45)', sc.openRangeHigh === 103 && sc.openRangeComplete);
  }

  // ── 14. A day with Intraday Boost captures races on those alone ─────────
  {
    const boost = { endpoint: 'market_pulse', payloadJson: '{"payload":{"data":{"intraday_boost":[]}}}' };
    const full = { endpoint: 'sector_scope', payloadJson: '{}' };
    const oldPulse = { endpoint: 'market_pulse', payloadJson: '{"payload":{"data":{"top_gainers":[]}}}' };
    check('race source: Intraday Boost captures win when present', raceCaptures([full, boost]).every((c) => c.endpoint === 'market_pulse'));
    check('race source: never mixes sources within a day', raceCaptures([full, boost]).length === 1);
    check('race source: no Intraday Boost → the full boards', raceCaptures([full, oldPulse]).every((c) => c.endpoint === 'sector_scope'));
  }

  // ── 15. Cockpit view: the dots can never disagree with the selector ─────
  {
    const cfg = DEFAULT_TF_SELECTOR_CONFIG;
    const ctxs: TfSymbolContext[] = [
      ok(), ok({ breakout: false }), ok({ breakout: null }), ok({ tfBeacon: null }), ok({ tfBeacon: 'BEAR' }),
      ok({ premValueCr: 5 }), ok({ premValueCr: null }), ok({ sinceEntryPct: 3 }), ok({ sinceEntryPct: null }),
      ok({ breakout15: false }),
    ];
    const runner = { symbol: 'X', rankNow: 3, rankAtBaseline: 9, climb: 6, rFactorNow: 2.5, rFactorAgo: 2.0, deltaR: 0.5, pctChange: 1.2 };
    let agree = 0;
    let total = 0;
    for (const c of ctxs) {
      for (const deltaR of [0.5, 0.01, null]) {
        for (const pctChange of [1.2, 0.1, null]) {
          const r = { ...runner, deltaR, pctChange };
          const picked = selectTfCandidates([r], new Map([['X', c]]), cfg).candidates.length === 1;
          total++;
          if (allPass(gateStrip(deltaR, pctChange, c, cfg)) === picked) agree++;
        }
      }
    }
    check('all six dots green ⇔ the selector picks it (every combination)', agree === total, `${agree}/${total}`);
    const none = gateStrip(0.5, 1.2, undefined, cfg);
    check('no evidence is grey, never green', none.orb === null && none.pool === null);
    check(
      'needs: names the first missing check',
      firstNeed(gateStrip(0.5, 1.2, ok({ breakout: false }), cfg), ok({ breakout: false }), cfg) === 'our 30-min opening-range breakout',
    );
    check('needs: TF beacon named when only it is missing', firstNeed(gateStrip(0.5, 1.2, ok({ tfBeacon: null }), cfg), ok({ tfBeacon: null }), cfg) === 'TF breakout beacon in the trade direction');
    check('needs: null when everything passes', firstNeed(gateStrip(0.5, 1.2, ok(), cfg), ok(), cfg) === null);

    const b = [
      board(600, [['A', 1.0, 1], ['B', 3.0, 1]]), // 10:00
      board(615, [['A', 1.1, 1], ['B', 3.0, 1]]), // 10:15
      board(630, [['A', 1.6, 1], ['B', 3.0, 1]]), // 10:30
    ];
    check('trend: +0.5 in the last 15 vs +0.1 before = faster', rTrend(b, 'A', 630) === 'faster');
    check('trend: flat in both halves = steady', rTrend(b, 'B', 630) === 'steady');
    check('trend: not enough history = null', rTrend(b, 'A', 615) === null);
    const slow = [board(600, [['A', 1.0, 1]]), board(615, [['A', 1.6, 1]]), board(630, [['A', 1.7, 1]])];
    check('trend: +0.1 in the last 15 vs +0.6 before = slower', rTrend(slow, 'A', 630) === 'slower');
    check('climbing since: the first board of the unbroken climb', climbingSince(b, 'A', 630, 0.05) === 630);
    check('climbing since: not climbing now = null', climbingSince(b, 'B', 630, 0.05) === null);
    check('path: one point per board in range', rPath(b, 'A', 600, 630).length === 3 && rPath(b, 'A', 601, 630).length === 2);

    const d = [
      board(575, [['A', 1.0, 1], ['Z', 0.5, 1]]),
      board(605, [['A', 1.5, 1], ['Z', 0.5, 1]]), // A climbing at 10:05
      board(640, [['Z', 2.0, 1], ['A', 1.0, 1]]), // Z overtakes; with topN 1, A is off the board
    ];
    const dropped = droppedClimbers(d, { asOfMin: 640, fromMin: 575, topN: 1, minDeltaR: 0.05, onBoardNow: new Set(['Z']) });
    check(
      'dropped: a climber that left the top N stays listed',
      dropped.length === 1 && dropped[0].symbol === 'A' && dropped[0].from === 605 && dropped[0].to === 605 && dropped[0].rankNow === 2,
      JSON.stringify(dropped),
    );
    check('dropped: a name on the board now is not repeated', !dropped.some((x) => x.symbol === 'Z'));
    const gone = droppedClimbers([...d.slice(0, 2), board(640, [['Z', 2.0, 1]])], { asOfMin: 640, fromMin: 575, topN: 1, minDeltaR: 0.05, onBoardNow: new Set(['Z']) });
    check('dropped: off the list entirely → rankNow null (left Intraday Boost)', gone[0]?.rankNow === null);

    const vals = new Map([['NIFTY PSU BANK', 3.25], ['NIFTY BANK', 0.04], ['NiFTY 50', -0.06]]);
    check('sector: skips the broad baskets', pickSector(['NiFTY 50', 'NIFTY PSU BANK'], vals)?.name === 'NIFTY PSU BANK');
    check('sector: none with a value = null', pickSector(['OTHERS'], vals) === null);
  }

  // ── 16. Boards before 09:15 are another session's — ignored ────────────
  // 2026-10-08: a manual off-hours capture left a 02:02 board carrying the
  // previous day's R-Factors; at 09:55 the 30-min rate compared against it and
  // showed PNB at −1.90 "stopped climbing". TF restarts its counter each morning.
  {
    const kept = dropPreOpen([board(122, [['PNB', 3.8, 1]]), board(554, [['PNB', 0, 1]]), board(555, [['PNB', 0.2, 1]]), board(595, [['PNB', 1.9, 1]])]);
    check('pre-open boards are dropped, 09:15 onward kept', kept.map((b) => b.minuteIST).join(',') === '555,595');
  }

  // ── 17. When each name entered and left TF Climbers ─────────────────────
  {
    // A climbs 10:05–10:15, stops at 10:20, climbs again from 10:40 to the end.
    const b = [
      board(575, [['A', 1.0, 1], ['B', 2.0, 1]]),
      board(605, [['A', 1.5, 1], ['B', 2.0, 1]]), // A +0.5 vs 09:35 → in
      board(615, [['A', 1.6, 1], ['B', 2.0, 1]]), // A +0.6 vs 09:35 → in
      board(620, [['A', 1.5, 1], ['B', 2.0, 1]]), // A vs 09:50 (=09:35 board) +0.5 … still in
      board(650, [['A', 1.5, 1], ['B', 2.0, 1]]), // A vs 10:20 = 0 → out at 10:50
      board(680, [['A', 2.5, 1], ['B', 2.0, 1]]), // A vs 10:50 +1.0 → in again
    ];
    const iv = climberIntervals(b, { fromMin: 575, asOfMin: 680, topN: 20, minDeltaR: 0.05 });
    const a = iv.filter((x) => x.symbol === 'A');
    check('climbers: an entry and an exit are recorded', a[0]?.enteredAt === 605 && a[0]?.exitedAt === 650, JSON.stringify(a));
    check('climbers: a re-entry opens a second interval, still active', a.length === 2 && a[1].enteredAt === 680 && a[1].exitedAt === null);
    check('climbers: a name that never climbed never appears', !iv.some((x) => x.symbol === 'B'));
    const top1 = climberIntervals(b, { fromMin: 575, asOfMin: 680, topN: 1, minDeltaR: 0.05 });
    check('climbers: only names inside the top N count', !top1.some((x) => x.symbol === 'A' && x.enteredAt === 605));
  }

  // ── 17b. Climbed Stocks: one chip per stock, flicker merged (2026-10-09) ──
  // Patterns from 2026-10-08's real intervals (61 raw entries, 27 stocks).
  {
    const iv = (symbol: string, enteredAt: number, exitedAt: number | null, bestRank = 5) => ({
      symbol,
      enteredAt,
      exitedAt,
      bestRank,
    });
    const raw = [
      iv('TATAELXSI', 624, 776, 3), // 10:24–12:56
      iv('TATAELXSI', 777, 807, 2), // back after ONE minute → same run
      iv('INDIANB', 624, 625), // a 1-minute blip
      iv('JINDALSTEL', 624, 717), // 10:24–11:57
      iv('JINDALSTEL', 740, 790), // out 23 min → a genuine second run
      iv('LUPIN', 753, 875), // 12:33–14:35, back after 30 min, still in
      iv('LUPIN', 905, null),
    ];
    const out = climbedStocks(raw, { asOfMin: 931, graceMin: 10, minStayMin: 5 });
    const get = (s: string) => out.find((x) => x.symbol === s);
    check('climbed: each stock appears once', out.length === new Set(out.map((x) => x.symbol)).size && out.length === 3, out.map((x) => x.symbol).join(','));
    check(
      'climbed: a 1-minute dip merges into one run (TATAELXSI)',
      get('TATAELXSI')?.runs.length === 1 && get('TATAELXSI')?.lastExitedAt === 807 && get('TATAELXSI')?.bestRank === 2
    );
    check('climbed: a 1-minute blip is dropped (INDIANB)', !get('INDIANB'));
    check('climbed: a 23-minute pause stays a separate run (JINDALSTEL ×2)', get('JINDALSTEL')?.runs.length === 2);
    check('climbed: still-in is preserved (LUPIN ×2, open)', get('LUPIN')?.runs.length === 2 && get('LUPIN')?.lastExitedAt === null);
    const pending = climbedStocks([iv('CAMS', 900, 925)], { asOfMin: 930, graceMin: 10, minStayMin: 5 });
    check('climbed: an exit younger than the grace is not yet confirmed (shown as in)', pending[0]?.lastExitedAt === null);
    const confirmed = climbedStocks([iv('CAMS', 900, 915)], { asOfMin: 930, graceMin: 10, minStayMin: 5 });
    check('climbed: an exit older than the grace is confirmed', confirmed[0]?.lastExitedAt === 915);
  }

  // ── 17c. Stretch vs the normal day — RECORDED evidence, never a gate (2026-10-09) ──
  {
    const days = Array.from({ length: 12 }, (_, i) => ({
      date: `2026-09-${String(28 - i).padStart(2, '0')}`,
      high: 1040,
      low: 1000,
      close: 1020 + i,
    }));
    const base = dayBaseline(days, '2026-10-01');
    check('stretch: ADR = mean range of the last 10 sessions', base?.adr === 40, JSON.stringify(base));
    check('stretch: previous close = the newest session before the trade date', base?.prevClose === 1020);
    check(
      'stretch: the trade date itself is never part of its own baseline',
      dayBaseline([...days, { date: '2026-10-01', high: 5000, low: 1, close: 3000 }], '2026-10-01')?.adr === 40
    );
    check('stretch: fewer than 5 sessions → no baseline', dayBaseline(days.slice(0, 4), '2026-10-01') === null);
    check(
      `stretch: newest bar older than ${ADR_MAX_STALE_DAYS} days → no baseline`,
      dayBaseline(days, '2026-10-20') === null
    );
    check(
      'stretch: corrupt rows are skipped, not averaged',
      dayBaseline([...days, { date: '2026-09-29', high: 0, low: 0, close: 0 }], '2026-10-01')?.prevClose === 1020
    );

    // COLPAL 2026-10-09, real 5-min bars 09:15–09:50 (prod fyers_candles), entry 09:57 at 1859.2.
    const t = (hhmm: string) => Date.parse(`2026-10-09T${hhmm}:00+05:30`) / 1000;
    const colpal = [
      { bucketTs: t('09:15'), high: 1804.4, low: 1736.2 },
      { bucketTs: t('09:20'), high: 1828.2, low: 1800.8 },
      { bucketTs: t('09:25'), high: 1831.5, low: 1814 },
      { bucketTs: t('09:30'), high: 1829.7, low: 1820 },
      { bucketTs: t('09:35'), high: 1844.5, low: 1822 },
      { bucketTs: t('09:40'), high: 1845.1, low: 1837 },
      { bucketTs: t('09:45'), high: 1857, low: 1836.7 },
      { bucketTs: t('09:50'), high: 1862, low: 1846.6 },
    ];
    const cBase = { adr: 42.1, prevClose: 1735.7 };
    const ce = measureStretch(colpal, 1859.2, 'CE', cBase);
    check('stretch: COLPAL entry had used 2.99× a normal day', ce?.rangeUsed === 2.99, JSON.stringify(ce));
    check('stretch: COLPAL first candle was 1.62× a normal day', ce?.firstCandle === 1.62);
    check('stretch: COLPAL was +7.12% from prev close, in the CE direction', ce?.fromPrevClosePct === 7.12);
    check(
      'stretch: the same move reads negative for a PE (it ran against a put)',
      measureStretch(colpal, 1859.2, 'PE', cBase)?.fromPrevClosePct === -7.12
    );
    check(
      'stretch: the decision price counts toward the range (a new high)',
      measureStretch(colpal, 1870, 'CE', cBase)?.rangeUsed === Math.round(((1870 - 1736.2) / 42.1) * 100) / 100
    );
    check('stretch: no 09:15 candle → first candle unknown', measureStretch(colpal.slice(1), 1859.2, 'CE', cBase)?.firstCandle === null);
    check('stretch: no baseline → null, never a guess', measureStretch(colpal, 1859.2, 'CE', null) === null);
    check('stretch: no price → null', measureStretch(colpal, null, 'CE', cBase) === null);
    // It is recorded only: the selector must ignore it entirely.
    const runner: TfRunnerAt[] = [
      { symbol: 'AAA', rankNow: 1, rankAtBaseline: 5, climb: 4, rFactorNow: 3, rFactorAgo: 2.5, deltaR: 0.5, pctChange: 1.2 },
    ];
    const plain = selectTfCandidates(runner, new Map([['AAA', ok()]]));
    const stretched = selectTfCandidates(
      runner,
      new Map([['AAA', ok({ stretch: { rangeUsed: 9.99, firstCandle: 5, fromPrevClosePct: 20 } })]])
    );
    check(
      'stretch: the selector ignores it — same picks and same reasons with or without it',
      JSON.stringify(plain) === JSON.stringify(stretched)
    );
  }

  // ── 18. Missing price data is described as missing, not as a failed range ──
  {
    const none = { noBoard: 0, frozenR: 0, unknownDeltaR: 0, flatPrice: 0, noBreakout: 0, breakoutUnknown: 3, noTfBeacon: 0, thinPremium: 0, premiumUnknown: 0, moveExhausted: 0 };
    const text = describeRejections(none, 3);
    check('rejections: unknown breakout reads as missing price data', /no price data/.test(text) && !/not cleared/.test(text), text);
  }

  // ── 19. Candidates = TF top 20 minus 'avoid', NO rank-climb filter (2026-10-08) ──
  // ADANIENT showed all six checks green on the card, but the engine only
  // evaluated rank-climbers, so it was never considered. One set for both now.
  {
    const base = board(575, [['HIGH', 4.0, 1], ['AVOID', 3.5, 1], ['RISER', 1.2, 1], ...filler(10)]);
    const now = board(640, [['HIGH', 4.6, 1], ['AVOID', 4.0, 1], ['RISER', 2.0, 1], ...filler(10)]);
    const eligible = new Set(['HIGH', 'RISER', ...filler(10).map((f) => f[0])]);
    const c = tfCandidatesAtMinute([base, now], 640, 20, eligible);
    const syms = c.runners.map((r) => r.symbol);
    check('candidates: a name that did NOT climb in rank is still a candidate', syms.includes('HIGH'), syms.join(','));
    check("candidates: an 'avoid'-band name is never a candidate", !syms.includes('AVOID'));
    check('candidates: rank cap still applies', tfCandidatesAtMinute([base, now], 640, 2, eligible).runners.every((r) => r.rankNow <= 2));
    const early = board(570, Array.from({ length: 12 }, (_, i) => [`Z${i}`, 0, 0.5] as [string, number, number]));
    check('candidates: no usable baseline (degenerate board) → none', !tfCandidatesAtMinute([early], 570, 20, eligible).available);
  }

  // ── 20. "Since 09:45" anchors on the 09:45 CANDLE, never a recorded quote ──
  // 2026-10-08: the recorded price sat at 1318.3 from 09:22 to 10:05 (stale), so
  // ADANIGREEN read 3.45% extended and was rejected; the 09:45 candle opened 1300.8.
  {
    const at = (minIST: number) => Date.UTC(2026, 9, 8, 0, 0, 0) / 1000 + (minIST - 330) * 60;
    const bars = [
      { bucketTs: at(580), open: 1318.3, high: 1320, low: 1300, close: 1302 },
      { bucketTs: at(585), open: 1300.8, high: 1305, low: 1299, close: 1303.8 },
      { bucketTs: at(625), open: 1275.7, high: 1279.8, low: 1270, close: 1272.8 },
    ];
    const pe = sinceEntryFromBars(bars, 1272.8, 'PE');
    check('since 09:45: PE move measured from the 09:45 candle open', pe != null && Math.abs(pe - 2.15) < 0.01, String(pe));
    check('since 09:45: CE sign is the other way', (sinceEntryFromBars(bars, 1272.8, 'CE') ?? 0) < 0);
    check('since 09:45: no 09:45 candle yet → null', sinceEntryFromBars(bars.slice(0, 1), 1272.8, 'PE') === null);
    check('since 09:45: no price → null', sinceEntryFromBars(bars, null, 'PE') === null);
  }

  // ── 21. The summary never says "none tradeable" when something was picked ──
  // Found replaying 2026-10-08 10:25: 3 picks, summary "13 runners, none tradeable".
  {
    const r = { noBoard: 0, frozenR: 2, unknownDeltaR: 0, flatPrice: 0, noBreakout: 0, breakoutUnknown: 0, noTfBeacon: 0, thinPremium: 4, premiumUnknown: 0, moveExhausted: 0 };
    const withPicks = describeRejections(r, 9, 3);
    check('summary: picks are stated, not "none tradeable"', /3 picked/.test(withPicks) && !/none tradeable/.test(withPicks), withPicks);
    check('summary: still "none tradeable" when nothing was picked', /none tradeable/.test(describeRejections(r, 6, 0)));
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
