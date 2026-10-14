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
  describeSector,
  GATE_ORDER,
  passedCount,
  realSectors,
  SECTOR_TOP_N,
  sectorDot,
  sectorStrength,
} from '@/lib/tf-live/board-view';
import { isTighterStop, trailedSpotStop } from '@/lib/auto-trade/risk/trailing-stop';
import { MIN_RISK_PCT, TF_BOARD_MAX_AGE_MIN, TF_RACE_MAX_RANK, TRAIL_R } from '@/lib/trade-suggest/config';
import { DEFAULT_SETTINGS } from '@/lib/auto-trade/config';
import { ADR_MAX_STALE_DAYS, dayBaseline, measureStretch } from '@/lib/tf-live/stretch';
import { describeTrend, TREND_RULE, trendDot, trendShape, type TrendBar } from '@/lib/tf-live/trend-shape';
import { readFileSync } from 'node:fs';
import {
  assembleVisibleLists,
  filterToLiveUniverse,
  listMembership,
  NSE_LIST_MAX_AGE_MS,
  type NseListMembership,
} from '@/lib/nse/live-lists';

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
  // A calm, unstretched stock — passes the "not chasing" check (2026-10-09).
  stretch: { rangeUsed: 1, firstCandle: 0.4, fromPrevClosePct: 1.5, fromPrevCloseAdr: 1 },
  // In the visible F&O OI Build-up list (#3) — passes the 8th check (operator, 2026-10-12).
  nseLists: { oiBuildupRank: 3, mostActiveRank: null, complete: true },
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
      // "Don't chase" (operator rule 2026-10-09): missing evidence is its own counter, never "chasing".
      ['no daily baseline', { stretch: null }, 'stretchUnknown'],
      ['no 09:15 candle', { stretch: { rangeUsed: 1, firstCandle: null, fromPrevClosePct: 1, fromPrevCloseAdr: 1 } }, 'stretchUnknown'],
      ['long opening candle (COLPAL 1.62×)', { stretch: { rangeUsed: 3, firstCandle: 1.62, fromPrevClosePct: 7, fromPrevCloseAdr: 1 } }, 'chasing'],
      ['already ran (TCS 2.37×)', { stretch: { rangeUsed: 2.3, firstCandle: 0.5, fromPrevClosePct: 6, fromPrevCloseAdr: 2.37 } }, 'chasing'],
      ['opening candle exactly at the 1.25× limit', { stretch: { rangeUsed: 1, firstCandle: 1.25, fromPrevClosePct: 1, fromPrevCloseAdr: 1 } }, 'chasing'],
      ['ran exactly the 2.0× limit', { stretch: { rangeUsed: 1, firstCandle: 0.5, fromPrevClosePct: 1, fromPrevCloseAdr: 2 } }, 'chasing'],
      // 8th check — must be in the visible F&O OI Build-up or Most Active list.
      ['in neither visible list (all lists read)', { nseLists: { oiBuildupRank: null, mostActiveRank: null, complete: true } }, 'notInNseLists'],
      ['lists unavailable (null) is UNKNOWN, not "in neither"', { nseLists: null }, 'listsUnknown'],
      ['in no readable list while another list is unavailable is UNKNOWN', { nseLists: { oiBuildupRank: null, mostActiveRank: null, complete: false } }, 'listsUnknown'],
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
    // Operator rule 2026-10-12: TF Climbers considers only TF's top 15 (was 20). One constant, read by the
    // card, the engine, Climbed Stocks and the poller - pinned so it is only ever changed on purpose.
    check('race rank cap is 15 (operator rule 2026-10-12)', TF_RACE_MAX_RANK === 15);
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
      // The 7th check — "don't chase" (2026-10-09): unknown, long opening candle, already ran.
      ok({ stretch: null }),
      ok({ stretch: { rangeUsed: 1, firstCandle: null, fromPrevClosePct: 1, fromPrevCloseAdr: 1 } }),
      ok({ stretch: { rangeUsed: 3, firstCandle: 1.62, fromPrevClosePct: 7, fromPrevCloseAdr: 2.92 } }),
      ok({ stretch: { rangeUsed: 2, firstCandle: 0.5, fromPrevClosePct: 6, fromPrevCloseAdr: 2.37 } }),
      // The 8th check - in neither list, lists unknown, one list down, in M only.
      ok({ nseLists: { oiBuildupRank: null, mostActiveRank: null, complete: true } }),
      ok({ nseLists: null }),
      ok({ nseLists: { oiBuildupRank: null, mostActiveRank: null, complete: false } }),
      ok({ nseLists: { oiBuildupRank: null, mostActiveRank: 7, complete: true } }),
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
    check('all eight dots green ⇔ the selector picks it (every combination)', agree === total, `${agree}/${total}`);
    const none = gateStrip(0.5, 1.2, undefined, cfg);
    check('no evidence is grey, never green', none.orb === null && none.pool === null);
    check(
      'needs: names the first missing check',
      firstNeed(gateStrip(0.5, 1.2, ok({ breakout: false }), cfg), ok({ breakout: false }), cfg) === 'our 30-min opening-range breakout',
    );
    check('needs: TF beacon named when only it is missing', firstNeed(gateStrip(0.5, 1.2, ok({ tfBeacon: null }), cfg), ok({ tfBeacon: null }), cfg) === 'TF breakout beacon in the trade direction');
    check('needs: null when everything passes', firstNeed(gateStrip(0.5, 1.2, ok(), cfg), ok(), cfg) === null);
    const longOpen = ok({ stretch: { rangeUsed: 3, firstCandle: 1.62, fromPrevClosePct: 7, fromPrevCloseAdr: 1 } });
    check(
      'needs: a long opening candle is named with its size',
      firstNeed(gateStrip(0.5, 1.2, longOpen, cfg), longOpen, cfg) ===
        'a calmer open — the 09:15 candle was 1.62× a normal day (max 1.25×)',
      String(firstNeed(gateStrip(0.5, 1.2, longOpen, cfg), longOpen, cfg))
    );
    const ran = ok({ stretch: { rangeUsed: 2, firstCandle: 0.5, fromPrevClosePct: 6, fromPrevCloseAdr: 2.37 } });
    check(
      'needs: an already-run stock is named with how far it ran',
      firstNeed(gateStrip(0.5, 1.2, ran, cfg), ran, cfg) ===
        "room left — already 2.37× a normal day from yesterday's close (max 2×)",
      String(firstNeed(gateStrip(0.5, 1.2, ran, cfg), ran, cfg))
    );
    check('no daily range is grey, never green', gateStrip(0.5, 1.2, ok({ stretch: null }), cfg).notChasing === null);
    const noList = ok({ nseLists: { oiBuildupRank: null, mostActiveRank: null, complete: true } });
    check(
      'needs: names the lists when the stock is in neither',
      firstNeed(gateStrip(0.5, 1.2, noList, cfg), noList, cfg) ===
        "a spot in /live's F&O OI Build-up or Most Active list (it is in neither right now)",
      String(firstNeed(gateStrip(0.5, 1.2, noList, cfg), noList, cfg))
    );
    const unkList = ok({ nseLists: null });
    check(
      'needs: unknown lists are described as unavailable, not as "in neither"',
      firstNeed(gateStrip(0.5, 1.2, unkList, cfg), unkList, cfg) ===
        "NSE's live OI Build-up and Most Active lists (unavailable or stale)",
      String(firstNeed(gateStrip(0.5, 1.2, unkList, cfg), unkList, cfg))
    );
    check('lists unknown is grey, never green', gateStrip(0.5, 1.2, unkList, cfg).inNseList === null);
    check('in neither list (all read) is hollow-red, not grey', gateStrip(0.5, 1.2, noList, cfg).inNseList === false);

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
    // Previous close must be the LAST session: if the overnight bhavcopy sync missed a day
    // that our own candle store saw trade, "from yesterday's close" would be measured
    // against an older close — refuse the baseline instead (self-review 2026-10-09).
    check(
      'stretch: daily data that missed a known session → no baseline (stale previous close)',
      dayBaseline(days, '2026-10-01', '2026-09-30') === null
    );
    check(
      'stretch: daily data as recent as the last known session → baseline kept',
      dayBaseline(days, '2026-10-01', '2026-09-28')?.prevClose === 1020
    );
    check(
      'stretch: no known prior session (fresh candle store) → no extra constraint',
      dayBaseline(days, '2026-10-01', null)?.prevClose === 1020
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
    check('stretch: …which is 2.93 normal days from prev close', ce?.fromPrevCloseAdr === 2.93, String(ce?.fromPrevCloseAdr));
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
    // The gate on REAL entries (spec 2026-10-09-dont-chase-gate-design.md): the two chase
    // entries blocked, every good / picked entry of 2026-10-06/08 still picked.
    const runner = (pct: number): TfRunnerAt[] => [
      { symbol: 'AAA', rankNow: 1, rankAtBaseline: 5, climb: 4, rFactorNow: 3, rFactorAgo: 2.5, deltaR: 0.5, pctChange: pct },
    ];
    const real: [string, 'CE' | 'PE', number, number, boolean][] = [
      ['COLPAL 10-09 (−₹4,001)', 'CE', 1.62, 2.92, false],
      ['TCS 10-09 (−₹2,351)', 'CE', 1.54, 2.37, false],
      ['JUBLFOOD 10-08 (+2R)', 'PE', 1.02, 1.85, true],
      ['ITC 10-08', 'PE', 0.78, 1.8, true],
      ['ADANIGREEN 10-08', 'PE', 0.7, 1.56, true],
      ['ADANIENT 10-08 (TF traded it)', 'PE', 0.44, 1.34, true],
      ['ADANIPORTS 10-08', 'PE', 0.53, 1.33, true],
      ['RELIANCE 10-06', 'CE', 0.21, 0.9, true],
    ];
    for (const [label, side, firstCandle, fromPrevCloseAdr, picked] of real) {
      const r = selectTfCandidates(
        runner(side === 'CE' ? 1.2 : -1.2),
        new Map([
          [
            'AAA',
            ok({ tfBeacon: side === 'CE' ? 'BULL' : 'BEAR', stretch: { rangeUsed: 1, firstCandle, fromPrevClosePct: 1, fromPrevCloseAdr } }),
          ],
        ])
      );
      check(
        `don't chase: ${label} ${picked ? 'still picked' : 'BLOCKED'}`,
        (r.candidates.length === 1) === picked && (picked || r.rejected.chasing === 1),
        JSON.stringify(r.rejected)
      );
    }
    const passed = selectTfCandidates(runner(1.2), new Map([['AAA', ok()]])).candidates[0];
    check(
      "don't chase: a pick says how far it had moved",
      passed?.reasons.some((x) => x.includes('not chasing: 09:15 candle 0.40× a normal day, 1.00× from yesterday')) === true,
      passed?.reasons.join(' | ')
    );
  }

  // ── 17d. 8th check: must be in the visible F&O OI Build-up / Most Active list (operator 2026-10-12) ──
  // "F, M or FM should inside it": in the OI Build-up list (F), the Most Active list (M), or both.
  {
    const runner: TfRunnerAt[] = [
      { symbol: 'AAA', rankNow: 1, rankAtBaseline: 5, climb: 4, rFactorNow: 3, rFactorAgo: 2.5, deltaR: 0.5, pctChange: 1.2 },
    ];
    const run = (nseLists: NseListMembership | null, cfg = DEFAULT_TF_SELECTOR_CONFIG) =>
      selectTfCandidates(runner, new Map([['AAA', ok({ nseLists })]]), cfg);
    const inF = { oiBuildupRank: 3, mostActiveRank: null, complete: true };
    const inM = { oiBuildupRank: null, mostActiveRank: 7, complete: true };
    const inFM = { oiBuildupRank: 3, mostActiveRank: 7, complete: true };
    check('lists: in F (OI Build-up) only passes', run(inF).candidates.length === 1);
    check('lists: in M (Most Active) only passes', run(inM).candidates.length === 1);
    check('lists: in both F and M passes', run(inFM).candidates.length === 1);
    check(
      'lists: in a list that was read while another feed is down still passes',
      run({ oiBuildupRank: 3, mostActiveRank: null, complete: false }).candidates.length === 1
    );
    check(
      'lists: a pick says which list(s) it is in',
      run(inFM).candidates[0]?.reasons.some((x) => x.includes('F&O OI Build-up #3') && x.includes('Most Active #7')) === true,
      run(inFM).candidates[0]?.reasons.join(' | ')
    );
    const top10 = { ...DEFAULT_TF_SELECTOR_CONFIG, maxNseListRank: 10 };
    check('lists: with a top-10 cut-off, rank 10 passes', run({ ...inF, oiBuildupRank: 10 }, top10).candidates.length === 1);
    check('lists: with a top-10 cut-off, rank 11 is refused', run({ ...inF, oiBuildupRank: 11 }, top10).rejected.notInNseLists === 1);
    check('lists: default is the WHOLE visible list (no rank cut-off)', DEFAULT_TF_SELECTOR_CONFIG.maxNseListRank === null);
    check(
      'lists: the check can be switched off (requireNseList false) and then passes without evidence',
      run(null, { ...DEFAULT_TF_SELECTOR_CONFIG, requireNseList: false }).candidates.length === 1
    );

    // listMembership — pure ranking over the visible lists
    const lists = { oiBuildup: ['ITC', 'JUBLFOOD', 'ADANIENT'], mostActiveValue: ['TCS', 'ITC'], mostActiveVolume: ['ITC'] };
    check('membership: OI Build-up rank is 1-based', listMembership(lists, 'ADANIENT').oiBuildupRank === 3);
    check('membership: Most Active takes the better of value/volume (ITC #1 by volume)', listMembership(lists, 'ITC').mostActiveRank === 1);
    check(
      'membership: a name in no list has null ranks and complete lists',
      (() => {
        const m = listMembership(lists, 'COLPAL');
        return m.oiBuildupRank === null && m.mostActiveRank === null && m.complete;
      })()
    );
    check(
      'membership: an unavailable list makes the answer incomplete (unknown, not "in neither")',
      listMembership({ ...lists, mostActiveValue: null }, 'COLPAL').complete === false
    );

    // filterToLiveUniverse — the SAME filter /live uses
    const fno = new Map([
      ['ITC', { sector: 'FMCG', tradeBand: 'ok', isIndex: false }],
      ['JUBLFOOD', { sector: 'CONSUMER', tradeBand: 'ok', isIndex: false }],
      ['SLOWCO', { sector: 'X', tradeBand: 'avoid', isIndex: false }],
      ['NIFTY', { sector: 'IDX', tradeBand: 'ok', isIndex: true }],
      ['NOFUT', { sector: 'Y', tradeBand: 'ok', isIndex: false }],
    ]);
    const liveFut = new Set(['ITC', 'JUBLFOOD', 'SLOWCO', 'NIFTY']);
    const raw = ['PENNY', 'ITC', 'SLOWCO', 'NIFTY', 'NOFUT', 'ITC', 'JUBLFOOD'].map((symbol, i) => ({ symbol, pct: 10 - i }));
    const f = filterToLiveUniverse(raw, fno, liveFut);
    check(
      'live universe: keeps F&O, drops non-F&O / index / avoid / no live future, in NSE order',
      f.picks.map((x) => x.symbol).join() === 'ITC,JUBLFOOD',
      f.picks.map((x) => x.symbol).join()
    );
    check('live universe: duplicates collapse to the first (best) rank', f.picks.filter((x) => x.symbol === 'ITC').length === 1);
    check('live universe: counts avoid-band exclusions', f.excludedAvoid === 1);

    // The freshness / per-feed-failure rule (assembleVisibleLists).
    const NOW = 1_000_000_000_000;
    const read = (symbols: string[], ageMs: number) => ({
      movers: symbols.map((symbol, i) => ({ symbol, pct: 10 - i })),
      fetchedAt: NOW - ageMs,
    });
    const allFresh = assembleVisibleLists(
      { oi: read(['ITC', 'JUBLFOOD'], 60_000), value: read(['ITC'], 60_000), volume: read([], 60_000) },
      fno,
      liveFut,
      NOW
    );
    check('assemble: fresh feeds give every list (an empty list is still a list)', allFresh?.oiBuildup?.join() === 'ITC,JUBLFOOD' && allFresh.mostActiveVolume?.length === 0);
    check(
      'assemble: a feed exactly at the age limit is still fresh',
      assembleVisibleLists({ oi: read(['ITC'], NSE_LIST_MAX_AGE_MS), value: null, volume: null }, fno, liveFut, NOW)?.oiBuildup?.join() === 'ITC'
    );
    const staleOi = assembleVisibleLists(
      { oi: read(['ITC'], NSE_LIST_MAX_AGE_MS + 1), value: read(['ITC'], 1000), volume: null },
      fno,
      liveFut,
      NOW
    );
    check('assemble: a feed 1 ms past the limit is dropped to null (stale ≠ visible)', staleOi?.oiBuildup === null && staleOi.mostActiveValue?.join() === 'ITC');
    check(
      'assemble: a dropped feed leaves the others counting, and membership is then incomplete',
      staleOi != null && listMembership(staleOi, 'ITC').mostActiveRank === 1 && listMembership(staleOi, 'JUBLFOOD').complete === false
    );
    check(
      'assemble: no usable feed at all → null (every name becomes unknown)',
      assembleVisibleLists({ oi: null, value: read(['ITC'], NSE_LIST_MAX_AGE_MS + 5), volume: null }, fno, liveFut, NOW) === null
    );

    // The past trades, with OI Build-up ranks rebuilt from stored NSE OI % (fyers_candles.nseOiPct,
    // top-24 BEFORE the F&O filter, so the real visible list is the same or stricter). Most Active has
    // no history, so M is unknown for these. Honest read: it blocks EICHERMOT (the loser nothing else
    // catches) and TCS, passes COLPAL (#1 - the don't-chase check blocks that one), and would also have
    // blocked RELIANCE (a +0.69R winner, 6 Oct replay).
    const past: [string, number, boolean][] = [
      ['COLPAL 10-09 (lost 4,001)', 1, true],
      ['TCS 10-09 (lost 2,351)', 36, false],
      ['EICHERMOT 10-09 (lost 970)', 80, false],
      ['ADANIENT 10-08 (won, TF traded it)', 4, true],
      ['JUBLFOOD 10-08 (won +2R)', 3, true],
      ['ITC 10-08 (won)', 2, true],
      ['RELIANCE 10-06 (won +0.69R)', 92, false],
    ];
    for (const [label, oiRank, passes] of past) {
      const r = run({ oiBuildupRank: oiRank <= 24 ? oiRank : null, mostActiveRank: null, complete: true });
      check(`lists: ${label} OI rank #${oiRank} ${passes ? 'passes' : 'is refused'}`, (r.candidates.length === 1) === passes, JSON.stringify(r.rejected));
    }
  }

  // ── 17e. 9th dot: sector strength — ADVISORY, never a check (operator 2026-10-12) ──
  // Real TF sector readings (the newest sector_scope capture of each session).
  {
    const today = new Map<string, number>([
      ['NIFTY AUTO', 0.95], ['NIFTY METAL', 0.48], ['NIFTY REALTY', 0.47], ['NIFTY PHARMA', 0.33], ['NIFTY IT', 0.17],
      ['NIFTY MID SELECT', 0.05], ['OTHERS', 0], ['NIFTY FIN SERVICE', -0.07], ['NIFTY BANK', -0.09], ['NiFTY 50', -0.1],
      ['SENSEX', -0.11], ['NIFTY CEMENT', -0.14], ['NIFTY PVT BANK', -0.14], ['NIFTY ENERGY', -0.31],
      ['NIFTY PSU BANK', -1.01], ['NIFTY FMCG', -1.29],
    ]);
    const sectors = realSectors(today);
    const pick = (name: string) => ({ name, value: today.get(name)! });
    check('sector: broad baskets are not sectors (NIFTY 50 / SENSEX / MID SELECT / OTHERS dropped)', sectors.length === 12 && !sectors.some((x) => /50|SENSEX|MID SELECT|OTHERS/i.test(x.name)), String(sectors.length));
    const auto = sectorStrength(pick('NIFTY AUTO'), sectors, 'CE');
    check('sector: CE, AUTO +0.95 is the #1 of 5 sectors moving up → top', auto?.state === 'top' && auto.rank === 1 && auto.of === 5, JSON.stringify(auto));
    const it = sectorStrength(pick('NIFTY IT'), sectors, 'CE');
    check('sector: CE, IT +0.17 moves up but is #5 of 5 → with (not top 3)', it?.state === 'with' && it.rank === 5, JSON.stringify(it));
    const energyCe = sectorStrength(pick('NIFTY ENERGY'), sectors, 'CE');
    check('sector: CE, ENERGY −0.31 moves AGAINST a call', energyCe?.state === 'against' && energyCe.rank === null, JSON.stringify(energyCe));
    const fmcg = sectorStrength(pick('NIFTY FMCG'), sectors, 'PE');
    check('sector: PE, FMCG −1.29 is the #1 of 7 sectors moving down → top', fmcg?.state === 'top' && fmcg.rank === 1 && fmcg.of === 7, JSON.stringify(fmcg));
    check('sector: PE, PSU BANK −1.01 is #2 → top', sectorStrength(pick('NIFTY PSU BANK'), sectors, 'PE')?.rank === 2);
    check('sector: PE, AUTO +0.95 moves AGAINST a put', sectorStrength(pick('NIFTY AUTO'), sectors, 'PE')?.state === 'against');
    check('sector: PE, FIN SERVICE −0.07 is #7 of 7 → with (the weakest down-mover)', sectorStrength(pick('NIFTY FIN SERVICE'), sectors, 'PE')?.state === 'with');
    check('sector: the top-N is configurable (top 1: METAL +0.48 is only #2)', sectorStrength(pick('NIFTY METAL'), sectors, 'CE', 1)?.state === 'with');
    check('sector: default top-N is 3', SECTOR_TOP_N === 3 && sectorStrength(pick('NIFTY REALTY'), sectors, 'CE')?.state === 'top');
    check('sector: an exactly-flat sector has no direction', sectorStrength({ name: 'NIFTY X', value: 0 }, [...sectors, { name: 'NIFTY X', value: 0 }], 'CE')?.state === 'flat');
    check('sector: no sector reading → null (missing evidence, never a guess)', sectorStrength(null, sectors, 'CE') === null);
    check('sector: a non-finite reading → null', sectorStrength({ name: 'NIFTY AUTO', value: Number.NaN }, sectors, 'CE') === null);

    // The dot: green ONLY for the strong case; hollow otherwise; grey with no reading.
    check('sector dot: top → green', sectorDot(auto) === true);
    check('sector dot: with / against → hollow (false), never green', sectorDot(it) === false && sectorDot(energyCe) === false);
    check('sector dot: no reading → grey (null), never green', sectorDot(null) === null);

    // Plain English — and never a "%": the reading is TF's own unit.
    check(
      'sector text: top call reads in plain English with no %',
      describeSector(auto, 'CE') === 'AUTO is #1 of 5 sectors moving up (TF reading +0.95) — strong, with the trade',
      describeSector(auto, 'CE')
    );
    check('sector text: a put speaks of "down"', describeSector(fmcg, 'PE').includes('moving down') && !describeSector(fmcg, 'PE').includes('%'));
    check('sector text: against is stated', describeSector(energyCe, 'CE').includes('against this trade'));
    check('sector text: no reading is stated', describeSector(null, 'CE') === 'no sector reading for this stock');

    // A very different day: 2026-10-09 (a rising market, every sector positive) — calls are with the market, puts are against it.
    const rising = realSectors(new Map([['NIFTY FMCG', 4.14], ['NIFTY IT', 3.82], ['NIFTY PHARMA', 2.97], ['NIFTY ENERGY', 2.73], ['NIFTY AUTO', 2.65]]));
    check('sector: rising day, CE on IT is #2 of 5 → top', sectorStrength({ name: 'NIFTY IT', value: 3.82 }, rising, 'CE')?.rank === 2);
    check('sector: rising day, every PE is against its sector', rising.every((x) => sectorStrength(x, rising, 'PE')?.state === 'against'));

    // NEVER a check: not one of the eight, and the strip's verdict ignores it.
    check('sector: the advisory dot is not in GATE_ORDER (still exactly eight checks)', GATE_ORDER.length === 8 && !(GATE_ORDER as readonly string[]).includes('sectorStrength'));
    const strip = gateStrip(0.5, 1.2, ok(), DEFAULT_TF_SELECTOR_CONFIG);
    check('sector: all eight checks green is TAKE whatever the sector says', allPass(strip) && sectorDot(energyCe) === false);
    check('sector: passedCount can never exceed eight', passedCount(strip) === 8);
  }

  // ── 18. Missing price data is described as missing, not as a failed range ──
  {
    const none = { noBoard: 0, frozenR: 0, unknownDeltaR: 0, flatPrice: 0, noBreakout: 0, breakoutUnknown: 3, noTfBeacon: 0, thinPremium: 0, premiumUnknown: 0, moveExhausted: 0, stretchUnknown: 0, chasing: 0, listsUnknown: 0, notInNseLists: 0 };
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

    // The TF top-N rule (N = TF_RACE_MAX_RANK = 15), through the SAME call the engine, the card and the poller make.
    const wide = board(575, Array.from({ length: 18 }, (_, i) => [`T${i + 1}`, 5 - i * 0.2, 1] as [string, number, number]));
    const wideNow = board(640, Array.from({ length: 18 }, (_, i) => [`T${i + 1}`, 6 - i * 0.2, 1] as [string, number, number]));
    const all = new Set(Array.from({ length: 18 }, (_, i) => `T${i + 1}`));
    const top = tfCandidatesAtMinute([wide, wideNow], 640, TF_RACE_MAX_RANK, all).runners.map((r) => r.rankNow);
    check('top-15 rule: rank 15 is a candidate', top.includes(15), top.join(','));
    check('top-15 rule: rank 16 is NOT a candidate', !top.includes(16) && Math.max(...top) === 15, top.join(','));
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
    const r = { noBoard: 0, frozenR: 2, unknownDeltaR: 0, flatPrice: 0, noBreakout: 0, breakoutUnknown: 0, noTfBeacon: 0, thinPremium: 4, premiumUnknown: 0, moveExhausted: 0, stretchUnknown: 0, chasing: 0, listsUnknown: 0, notInNseLists: 0 };
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

  // ── 22. The 10th dot — "trend day" chart shape — is ADVISORY and point-in-time ──
  {
    // 5-min bars on an IST session; minute m (IST minute-of-day) → bucket seconds.
    const ts = (m: number) => Date.UTC(2026, 9, 13, 0, 0) / 1000 + (m - 330) * 60;
    // A path given as closes from 09:15 every 5 min; high/low hug the close, flat volume.
    const series = (closes: number[]): TrendBar[] =>
      closes.map((c, i) => ({ bucketTs: ts(555 + 5 * i), high: c + 0.2, low: c - 0.2, close: c, volume: 1000 }));
    // 09:15–09:40 ranges 100–101, then a steady climb to 104 by 11:00 (prev close 100.5).
    const climb = series([100, 100.5, 101, 100.4, 100.8, 100.6, 101.6, 102, 102.2, 102.5, 102.8, 103, 103.1, 103.3, 103.5, 103.6, 103.8, 103.9, 104, 104.1, 104.2]);
    const up = trendShape(climb, 'CE', 100.5);
    check('trend: steady climb above VWAP after an OR break → trend', up?.state === 'trend', JSON.stringify(up));
    check('trend: dot green only for a trend', trendDot(up) === true);
    check('trend: description states it in plain words', describeTrend(up).startsWith('clean trend day'));
    // Mirror image for a put.
    const fall = trendShape(climb.map((b) => ({ ...b, high: 201 - b.low, low: 201 - b.high, close: 201 - b.close })), 'PE', 100.5);
    check('trend: the mirror-image fall is a trend for a PE', fall?.state === 'trend', JSON.stringify(fall));
    // Same climb but the wrong side for the trade.
    check('trend: a rising stock is not a PE trend', trendShape(climb, 'PE', 100.5)?.state === 'not');
    // Breaks out, then sags back under VWAP for most of the time after 10:00.
    const sag = series([100, 100.5, 101, 100.4, 100.8, 100.6, 101.6, 102.4, 101.2, 100.9, 100.8, 100.7, 100.8, 100.6, 100.9, 101.0, 101.1, 101.0, 102.3, 102.4, 102.5]);
    const s = trendShape(sag, 'CE', 100.5);
    check('trend: below VWAP most of the time → not a trend', s?.state === 'not' && (s.failed ?? '').includes('VWAP'), JSON.stringify(s));
    check('trend: "not" is hollow, never green', trendDot(s) === false);
    // Clean climb that then gives back more than the max pullback.
    const deep = series([100, 100.5, 101, 100.4, 100.8, 100.6, 101.6, 102.5, 103, 103.5, 104, 104.5, 105, 105.5, 106, 106.5, 107, 105.0, 105.2, 105.4, 105.3]);
    const d = trendShape(deep, 'CE', 100.5);
    check(`trend: a pullback deeper than ${TREND_RULE.maxPullbackPct}% → not a trend`, d?.state === 'not' && (d.failed ?? '').includes('pulled back'), JSON.stringify(d));
    // Too small a move from yesterday's close.
    check('trend: under the minimum move from prev close → not', trendShape(climb, 'CE', 103.8)?.state === 'not');
    // Missing evidence stays grey.
    check('trend: no previous close → null (grey), never guessed', trendShape(climb, 'CE', null) === null && trendDot(null) === null);
    check('trend: nothing after 10:00 yet → null', trendShape(climb.slice(0, 9), 'CE', 100.5) === null);
    check('trend: opening range incomplete → null', trendShape(climb.slice(0, 3), 'CE', 100.5) === null);
    // Advisory only: the selector never reads it and it is not one of the checks.
    const selectorSrc = readFileSync('lib/tf-live/selector.ts', 'utf8');
    check(
      'trend: selectTfCandidates never reads trendShape (only the context field declares it)',
      (selectorSrc.match(/trendShape/g) ?? []).length === 1
    );
    check('trend: not in GATE_ORDER — still exactly eight checks', GATE_ORDER.length === 8 && !(GATE_ORDER as readonly string[]).includes('trendShape'));
    check('trend: no selector config knob for it', !JSON.stringify(DEFAULT_TF_SELECTOR_CONFIG).toLowerCase().includes('trend'));
  }

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
}

main();
