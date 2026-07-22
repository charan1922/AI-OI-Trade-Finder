/**
 * Deterministic checks for the R-Factor V2 shadow engine. Pure computation only
 * — no database, no network, safe to run any time.
 *
 * Run:  npx tsx scripts/verify-rfactor-v2.ts   (or: pnpm verify:r-factor-v2)
 */
import assert from 'node:assert/strict';
import type { DetailedOptionChain, DetailedOptionSide } from '@/lib/dhan/market-feed';
import { computeCoreActivity, computeRFactorV2, computeRFactorV2Batch } from '@/lib/r-factor-v2';
import { deriveOptionActivityEvidence } from '@/lib/r-factor-v2/option-evidence';
import { robustZScore, type SameTimeBaseline } from '@/lib/r-factor-v2/store';
import type { OptionActivityEvidence, RFactorV2Input } from '@/lib/r-factor-v2/types';

let checks = 0;
const check = (label: string, fn: () => void): void => {
  fn();
  checks += 1;
  void label;
};

const baseInput = (symbol: string, overrides: Partial<RFactorV2Input> = {}): RFactorV2Input => ({
  symbol,
  sector: 'Testing',
  priceChangePct: -3,
  rangeRatio: 2.2,
  turnoverPace: 2.4,
  turnoverZ: null,
  turnoverBaselineKind: 'same-time',
  oiLevel: 1.35,
  futuresOiChangePct: 7,
  oiVelocity: 1.4,
  nseCombinedOiChangePct: 9,
  nseOiSlope30m: 0.8,
  nsePremiumPace: 2.1,
  spreadPct: 0.08,
  imbalance: 0.25,
  option: null,
  ...overrides,
});

const bearishOption: OptionActivityEvidence = {
  capturedAt: '2026-07-23T05:30:00.000Z',
  expiry: '2026-07-30',
  underlyingLtp: 1000,
  strikesUsed: 8,
  totalStrikes: 40,
  activityScore: 0.9,
  directionScore: -0.85,
  direction: 'bearish',
  directionConfidence: 0.85,
  directionEvidenceLegs: 8,
  oiPcr: 1.5,
  volumePcr: 1.8,
  premiumValuePcr: 2,
  moneynessWeightedOiPcr: 1.6,
  premiumTurnoverPace: 3.4,
  paceBaselineKind: 'same-time',
  premiumValue: 1_000_000,
  optionVolume: 50_000,
  callOiChangePct: 4,
  putOiChangePct: 18,
  gammaNetSharePct: -12.5,
  gammaConcentrationStrike: 1000,
  gammaConcentrationDistancePct: 0,
  grossGamma: 1234,
  rows: [],
};

// ── Separation of activity and direction ────────────────────────────────────
const withoutOption = computeRFactorV2(baseInput('WITHOUT'));
const withOption = computeRFactorV2(baseInput('WITH', { option: bearishOption }));
check('option evidence is reported, not assumed', () => {
  assert.equal(withoutOption.optionStatus, 'pending');
  assert.equal(withOption.optionStatus, 'available');
});
check('option evidence raises coverage and activity', () => {
  assert.ok(withOption.coverage > withoutOption.coverage);
  assert.ok(withOption.activityScore > withoutOption.activityScore);
});
check('high activity is never mistaken for bullish', () => {
  assert.equal(withOption.direction, 'bearish');
});

// ── Missing data is penalised, never silently reweighted ────────────────────
const sparse = computeRFactorV2(
  baseInput('SPARSE', {
    rangeRatio: null,
    turnoverPace: null,
    oiLevel: null,
    futuresOiChangePct: null,
    oiVelocity: null,
    nseCombinedOiChangePct: null,
    nsePremiumPace: null,
    option: null,
  }),
);
check('sparse input is marked too incomplete to rank', () => {
  assert.ok(sparse.comparableCoverage < 0.55);
  assert.ok(sparse.activityScore < withOption.activityScore);
});

// ── Ranking must not reward being chosen for option enrichment ──────────────
check('option evidence cannot change comparable activity', () => {
  const plain = computeRFactorV2(baseInput('X'));
  const enriched = computeRFactorV2(baseInput('X', { option: bearishOption }));
  assert.equal(
    plain.comparableActivity,
    enriched.comparableActivity,
    'the ranking score must ignore a factor only shortlisted names can earn',
  );
  assert.ok(enriched.rawActivity > plain.rawActivity, 'the absolute score should still reflect it');
});

check('an enriched leader cannot out-rank a genuinely stronger name', () => {
  // WEAK is enriched; STRONG is not. Ranking must still put STRONG first.
  const ranked = computeRFactorV2Batch([
    baseInput('STRONG', { rangeRatio: 3.4, turnoverPace: 3.9, option: null }),
    baseInput('WEAK', { rangeRatio: 1.0, turnoverPace: 0.9, option: bearishOption }),
  ]);
  assert.equal(ranked.get('STRONG')?.activityRank, 1);
  assert.equal(ranked.get('WEAK')?.activityRank, 2);
});

const ranked = computeRFactorV2Batch([
  baseInput('STRONG', { option: bearishOption }),
  baseInput('MEDIUM', { rangeRatio: 1.3, turnoverPace: 1.1, option: bearishOption }),
  baseInput('SPARSE', { rangeRatio: null, turnoverPace: null, oiLevel: null, futuresOiChangePct: null }),
]);
check('batch ranking excludes unrankable names from the universe', () => {
  assert.equal(ranked.get('STRONG')?.activityRank, 1);
  assert.equal(ranked.get('SPARSE')?.activityRank, 0);
  assert.equal(ranked.get('STRONG')?.universeSize, 2);
});

// ── Direction weighting ─────────────────────────────────────────────────────
check('an unknown price move does not dilute direction toward neutral', () => {
  // nseOiSlope30m can only confirm a side price already implies. With no price
  // it must be skipped, not counted as a zero vote.
  const noPrice = computeRFactorV2(baseInput('NOPRICE', { priceChangePct: null }));
  const noPriceNoSlope = computeRFactorV2(baseInput('NOPRICE2', { priceChangePct: null, nseOiSlope30m: null }));
  assert.equal(noPrice.directionScore, noPriceNoSlope.directionScore);
});

check('direction confidence scales with how much evidence backed the side', () => {
  const thin = computeRFactorV2(
    baseInput('THIN', { imbalance: null, nseOiSlope30m: null, futuresOiChangePct: null, option: null }),
  );
  const rich = computeRFactorV2(baseInput('RICH', { option: bearishOption }));
  assert.ok(rich.directionConfidence > thin.directionConfidence);
  assert.ok(rich.directionConfidence <= 1);
});

// ── Sector-relative activity ────────────────────────────────────────────────
check('sector comparison needs peers and excludes the stock itself', () => {
  const alone = computeRFactorV2Batch([baseInput('ONLY')]);
  const sectorFactor = alone.get('ONLY')?.factors.find((f) => f.key === 'sectorRelative');
  assert.equal(sectorFactor?.available, false, 'one name is not a sector');

  const crowd = computeRFactorV2Batch([
    baseInput('HOT', { rangeRatio: 3.5, turnoverPace: 3.8 }),
    baseInput('COLD1', { rangeRatio: 0.9, turnoverPace: 0.8 }),
    baseInput('COLD2', { rangeRatio: 0.9, turnoverPace: 0.8 }),
    baseInput('COLD3', { rangeRatio: 0.9, turnoverPace: 0.8 }),
  ]);
  const hot = crowd.get('HOT')?.factors.find((f) => f.key === 'sectorRelative');
  const cold = crowd.get('COLD1')?.factors.find((f) => f.key === 'sectorRelative');
  assert.equal(hot?.available, true);
  assert.ok((hot?.score ?? 0) > (cold?.score ?? 1), 'standing out from quiet peers must score higher');
});

check('a name with no sector still scores, without a sector factor', () => {
  const result = computeRFactorV2Batch([baseInput('NOSECTOR', { sector: null })]);
  const factor = result.get('NOSECTOR')?.factors.find((f) => f.key === 'sectorRelative');
  assert.equal(factor?.available, false);
  assert.ok((result.get('NOSECTOR')?.activityScore ?? 0) > 1);
});

// ── Per-stock robust z-score ────────────────────────────────────────────────
const quiet: SameTimeBaseline = { median: 100, mad: 2, sessions: 12, premiumMedian: null, premiumSessions: 0 };
const wild: SameTimeBaseline = { median: 100, mad: 60, sessions: 12, premiumMedian: null, premiumSessions: 0 };
check('2x in a quiet name outranks 2x in a violent one', () => {
  const quietZ = robustZScore(quiet, 200) ?? 0;
  const wildZ = robustZScore(wild, 200) ?? 0;
  assert.ok(quietZ > wildZ, 'identical ratios must not produce identical scores');
  const quietScore = computeRFactorV2(baseInput('Q', { turnoverZ: quietZ, turnoverPace: 2 }));
  const wildScore = computeRFactorV2(baseInput('W', { turnoverZ: wildZ, turnoverPace: 2 }));
  assert.ok(quietScore.activityScore > wildScore.activityScore);
});
check('z-score is withheld until the stock has enough of its own history', () => {
  assert.equal(robustZScore({ ...quiet, sessions: 4 }, 200), null);
  assert.equal(robustZScore({ ...quiet, mad: 0 }, 200), null);
  assert.equal(robustZScore(undefined, 200), null);
  assert.equal(robustZScore(quiet, null), null);
});
check('a missing z falls back to the ratio curve, not to zero', () => {
  const fallback = computeRFactorV2(baseInput('F', { turnoverZ: null, turnoverPace: 2.4 }));
  const turnover = fallback.factors.find((f) => f.key === 'turnover');
  assert.equal(turnover?.available, true);
  assert.ok((turnover?.score ?? 0) > 0);
});

// ── Core activity helper ────────────────────────────────────────────────────
check('core activity ignores option and sector evidence', () => {
  const a = computeCoreActivity(baseInput('A'));
  const b = computeCoreActivity(baseInput('A', { option: bearishOption }));
  assert.equal(a.raw, b.raw);
  assert.ok(a.coverage > 0.9);
});

// ── Option chain evidence ───────────────────────────────────────────────────
const side = (over: Partial<DetailedOptionSide>): DetailedOptionSide => ({
  securityId: '1',
  lastPrice: 7,
  averagePrice: 8,
  oi: 1100,
  previousOi: 1000,
  previousClosePrice: 9,
  previousVolume: 500,
  volume: 800,
  impliedVolatility: 22,
  topBidPrice: 6.9,
  topBidQuantity: 100,
  topAskPrice: 7.1,
  topAskQuantity: 100,
  greeks: { delta: 0.5, gamma: 0.01, theta: -0.1, vega: 0.2 },
  ...over,
});

const chain: DetailedOptionChain = {
  underlyingLastPrice: 1000,
  fetchedAt: '2026-07-23T05:30:00.000Z',
  strikes: [
    {
      strike: 1000,
      ce: side({}),
      pe: side({
        securityId: '2',
        lastPrice: 14,
        oi: 1500,
        previousOi: 1000,
        previousClosePrice: 8,
        volume: 1800,
        impliedVolatility: 27,
        topBidPrice: 13.9,
        topAskPrice: 14.1,
        greeks: { delta: -0.5, gamma: 0.01, theta: -0.1, vega: 0.2 },
      }),
    },
  ],
};

const evidence = deriveOptionActivityEvidence(chain, '2026-07-30');
check('near-money legs are retained and read directionally', () => {
  assert.equal(evidence.strikesUsed, 2);
  assert.equal(evidence.direction, 'bearish', 'put buying plus call writing should read bearish');
  assert.ok((evidence.oiPcr ?? 0) > 1);
  assert.ok((evidence.premiumValuePcr ?? 0) > 1);
});

check('the pace denominator is always labelled', () => {
  assert.equal(evidence.paceBaselineKind, 'prior-session-linear');
  const measured = deriveOptionActivityEvidence(chain, '2026-07-30', 5_000);
  assert.equal(measured.paceBaselineKind, 'same-time');
  assert.ok(measured.premiumValue > 0, 'raw premium value must be retained for future baselines');
});

check('an estimated pace leans on the assumption-free level comparison', () => {
  // Heavy OI build, modest premium turnover. Traded premium is 550, so a
  // same-clock baseline of 550 gives a measured pace of exactly 1.0 — roughly
  // three times what the linear estimate produces. The linear variant must
  // STILL score higher, because it correctly shifts weight onto the OI change,
  // which needs no assumption about how activity spreads through the day.
  const oiHeavy: DetailedOptionChain = {
    underlyingLastPrice: 1000,
    fetchedAt: '2026-07-23T05:30:00.000Z',
    strikes: [
      {
        strike: 1000,
        ce: side({ oi: 1400, previousOi: 1000, lastPrice: 7, previousClosePrice: 6.9, volume: 50, previousVolume: 500 }),
        pe: side({
          oi: 1300,
          previousOi: 1000,
          lastPrice: 5,
          previousClosePrice: 5.1,
          volume: 40,
          previousVolume: 500,
          greeks: { delta: -0.5, gamma: 0.01, theta: -0.1, vega: 0.2 },
        }),
      },
    ],
  };
  const linear = deriveOptionActivityEvidence(oiHeavy, '2026-07-30', null);
  const measured = deriveOptionActivityEvidence(oiHeavy, '2026-07-30', 550);
  assert.equal(linear.paceBaselineKind, 'prior-session-linear');
  assert.equal(measured.paceBaselineKind, 'same-time');
  assert.ok((measured.premiumTurnoverPace ?? 0) > (linear.premiumTurnoverPace ?? 0));
  assert.ok(
    linear.activityScore > measured.activityScore,
    'an untrustworthy pace must carry less of the score than the OI level change',
  );
});

check('far, cheap open interest cannot masquerade as conviction', () => {
  const wings: DetailedOptionChain = {
    underlyingLastPrice: 1000,
    fetchedAt: '2026-07-23T05:30:00.000Z',
    strikes: [
      {
        strike: 1000,
        ce: side({ oi: 1000, greeks: { delta: 0.5, gamma: 0.01, theta: -0.1, vega: 0.2 } }),
        pe: side({ oi: 1000, greeks: { delta: -0.5, gamma: 0.01, theta: -0.1, vega: 0.2 } }),
      },
      {
        // A wall of far out-of-the-money puts: equal raw OI, far less delta.
        strike: 940,
        ce: null,
        pe: side({ oi: 4000, greeks: { delta: -0.12, gamma: 0.004, theta: -0.05, vega: 0.1 } }),
      },
    ],
  };
  const result = deriveOptionActivityEvidence(wings, '2026-07-30');
  assert.ok((result.oiPcr ?? 0) > 1, 'raw OI PCR is dominated by the cheap wing');
  assert.ok(
    (result.moneynessWeightedOiPcr ?? 0) < (result.oiPcr ?? 0),
    'delta-weighted PCR must discount the far wing',
  );
});

// ── An uninformative chain must not vote ────────────────────────────────────
// Having a chain is not the same as the chain saying something. A full-weight
// neutral vote would drag a genuinely one-sided read back toward neutral, which
// is exactly the failure the OI-slope vote is written to avoid.
check('premium turnover values contracts at traded price, not last print', () => {
  // Same volume, same LTP; only the session VWAP differs. A leg that ran hard
  // intraday must not be priced as if every contract traded at the last print.
  const chainWith = (averagePrice: number): DetailedOptionChain => ({
    underlyingLastPrice: 1000,
    fetchedAt: '2026-07-23T05:30:00.000Z',
    strikes: [
      {
        strike: 1000,
        ce: side({ lastPrice: 40, averagePrice, volume: 1000, previousVolume: 1000, previousClosePrice: 5 }),
        pe: null,
      },
    ],
  });
  // Baseline of 12000 = the trended leg's true traded premium (12 x 1000).
  const trended = deriveOptionActivityEvidence(chainWith(12), '2026-07-30', 12_000);
  const flat = deriveOptionActivityEvidence(chainWith(40), '2026-07-30', 12_000);
  assert.equal(trended.premiumValue, 12_000, 'VWAP x volume, not LTP x volume');
  assert.equal(flat.premiumValue, 40_000);
  assert.ok(
    (flat.premiumTurnoverPace ?? 0) > (trended.premiumTurnoverPace ?? 0),
    'the genuinely heavier leg must read as the busier one',
  );
});

check('a missing session VWAP falls back to last price', () => {
  const noAverage: DetailedOptionChain = {
    underlyingLastPrice: 1000,
    fetchedAt: '2026-07-23T05:30:00.000Z',
    strikes: [{ strike: 1000, ce: side({ lastPrice: 10, averagePrice: 0, volume: 500 }), pe: null }],
  };
  assert.equal(deriveOptionActivityEvidence(noAverage, '2026-07-30').premiumValue, 5_000);
});

check('a chain with no OI build carries no direction evidence', () => {
  const flat: DetailedOptionChain = {
    underlyingLastPrice: 1000,
    fetchedAt: '2026-07-23T05:30:00.000Z',
    strikes: [
      {
        strike: 1000,
        // OI fell on both sides: no fresh build anywhere, so nothing to read.
        ce: side({ oi: 900, previousOi: 1000 }),
        pe: side({ oi: 800, previousOi: 1000, greeks: { delta: -0.5, gamma: 0.01, theta: -0.1, vega: 0.2 } }),
      },
    ],
  };
  const result = deriveOptionActivityEvidence(flat, '2026-07-30');
  assert.equal(result.directionEvidenceLegs, 0);
  assert.equal(result.directionScore, 0);
});

check('an uninformative chain does not drag direction toward neutral', () => {
  const silent = { ...bearishOption, directionScore: 0, directionConfidence: 0, directionEvidenceLegs: 0 };
  const noChain = computeRFactorV2(baseInput('A'));
  const withSilentChain = computeRFactorV2(baseInput('A', { option: silent }));
  assert.equal(
    withSilentChain.directionScore,
    noChain.directionScore,
    'merely fetching a chain must not change the direction read',
  );
});

check('balanced opposing evidence still votes — it is real information', () => {
  // directionScore 0 with legs > 0 means bulls and bears genuinely cancelled.
  // That must count, which is why availability is tested by leg COUNT and not
  // by directionScore or directionConfidence being zero.
  const balanced = { ...bearishOption, directionScore: 0, directionConfidence: 0, directionEvidenceLegs: 6 };
  const noChain = computeRFactorV2(baseInput('B'));
  const withBalanced = computeRFactorV2(baseInput('B', { option: balanced }));
  assert.notEqual(withBalanced.directionScore, noChain.directionScore);
  assert.ok(Math.abs(withBalanced.directionScore) < Math.abs(noChain.directionScore));
});

check('a single valid directional leg is enough to vote', () => {
  const oneLeg: DetailedOptionChain = {
    underlyingLastPrice: 1000,
    fetchedAt: '2026-07-23T05:30:00.000Z',
    strikes: [
      {
        strike: 1000,
        ce: side({ oi: 1400, previousOi: 1000, lastPrice: 9, previousClosePrice: 6 }),
        pe: side({ oi: 800, previousOi: 1000, greeks: { delta: -0.5, gamma: 0.01, theta: -0.1, vega: 0.2 } }),
      },
    ],
  };
  const result = deriveOptionActivityEvidence(oneLeg, '2026-07-30');
  assert.equal(result.directionEvidenceLegs, 1);
  assert.equal(result.direction, 'bullish', 'call buying on a fresh OI build reads bullish');
});

check('gamma evidence is recorded but never scored', () => {
  const withGamma = deriveOptionActivityEvidence(chain, '2026-07-30', null, 250);
  assert.ok(withGamma.grossGamma > 0, 'gamma evidence should be present');
  assert.notEqual(withGamma.gammaConcentrationStrike, null);
  // Scoring must be identical with and without a lot multiplier: gamma is
  // retained for later study, and must not leak into the activity score.
  const noLot = deriveOptionActivityEvidence(chain, '2026-07-30', null, 1);
  assert.equal(withGamma.activityScore, noLot.activityScore);
  assert.equal(withGamma.directionScore, noLot.directionScore);
});

// ── A hung shadow request must not stall the shared quote queue ─────────────
// The measurement-only option request shares the serial Dhan Quote-API queue
// with live quotes, so an unbounded request would make a money-path quote wait
// behind it forever. Node's fetch has NO default timeout, so this is real.
// Proven against a local server that accepts the socket and never replies.
async function verifyShadowRequestTimeout(): Promise<void> {
  const { createServer } = await import('node:http');
  const { fetchWithTimeout, isAbortError } = await import('@/lib/dhan/fetch-timeout');

  const hung = createServer(() => {
    /* accept the connection, never send headers */
  });
  await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
  const port = (hung.address() as { port: number }).port;

  const startedAt = Date.now();
  let aborted = false;
  try {
    await fetchWithTimeout(`http://127.0.0.1:${port}/`, { method: 'GET' }, 400);
  } catch (error) {
    aborted = isAbortError(error);
  }
  const elapsed = Date.now() - startedAt;
  hung.close();

  check('a never-answering request aborts instead of hanging', () => {
    assert.ok(aborted, 'expected an abort, got a different outcome');
    assert.ok(elapsed < 3_000, `expected release well under 3s, took ${elapsed}ms`);
  });
}

await verifyShadowRequestTimeout();

// ── A stalled BODY must abort too, not just stalled headers ─────────────────
// fetchWithTimeout clears its timer the moment a Response exists, so a server
// that completes the header exchange and then never finishes the JSON leaves
// `response.json()` pending forever. That would hang fetchDetailedOptionChain-
// Shadow and leave the option-shadow worker `running` for the life of the
// process, silently ending all future option evidence.
async function verifyStalledBodyTimeout(): Promise<void> {
  const { createServer } = await import('node:http');
  const { fetchJsonWithTimeout, isAbortError } = await import('@/lib/dhan/fetch-timeout');

  const partial = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
    res.write('{"status":"suc'); // valid headers, deliberately truncated body
    // never res.end()
  });
  await new Promise<void>((resolve) => partial.listen(0, '127.0.0.1', resolve));
  const port = (partial.address() as { port: number }).port;

  const startedAt = Date.now();
  let aborted = false;
  try {
    await fetchJsonWithTimeout(`http://127.0.0.1:${port}/`, { method: 'GET' }, 400);
  } catch (error) {
    aborted = isAbortError(error);
  }
  const elapsed = Date.now() - startedAt;
  partial.close();

  check('a stalled response BODY aborts instead of hanging', () => {
    assert.ok(aborted, 'expected an abort while reading the body, got a different outcome');
    assert.ok(elapsed < 3_000, `expected release well under 3s, took ${elapsed}ms`);
  });
}

await verifyStalledBodyTimeout();

// ── The shadow gate must never break Dhan request serialisation ─────────────
// The gate previously handed `gate.tail` a race between the real task and a
// fixed sleep started at QUEUE time. Because the task also waits out a 429
// cooldown, the tail could resolve while the task was still parked — letting a
// foreground quote dispatch concurrently and re-trigger the 429.
async function verifyQuoteGateSerialisation(): Promise<void> {
  const gate = await import('@/lib/dhan/quote-gate');

  // 1. Low-priority work yields while a cooldown is running.
  check('shadow work yields during a 429 cooldown', () => {
    const now = 1_000_000_000;
    assert.equal(
      gate.shouldLowPriorityYield({
        foregroundPending: 0,
        lastDispatchAt: now - 60_000,
        cooldownUntil: now + 20_000,
        nowMs: now,
      }),
      true,
      'a shadow request must not reserve the first slot after a cooldown',
    );
    assert.equal(
      gate.shouldLowPriorityYield({
        foregroundPending: 0,
        lastDispatchAt: now - 60_000,
        cooldownUntil: 0,
        nowMs: now,
      }),
      false,
      'an idle, uncooled gate must let shadow work through',
    );
  });

  // 2. Concurrency stays at one across a shadow + foreground overlap, with the
  //    shadow task deliberately outlasting the old race window.
  gate.__resetQuoteGateForTest({ lastDispatchAt: Date.now() - 10_000 });
  let inFlight = 0;
  let maxInFlight = 0;
  const order: string[] = [];
  const task = (label: string, ms: number) => async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    order.push(label);
    await new Promise((resolve) => setTimeout(resolve, ms));
    inFlight -= 1;
    return label;
  };

  const shadow = gate.throughQuoteGateLowPriority(task('shadow', 900));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const foreground = gate.throughQuoteGate(task('foreground', 50));
  await Promise.all([shadow, foreground]);

  check('a shadow request never runs concurrently with a live quote', () => {
    assert.equal(maxInFlight, 1, `max concurrent Dhan dispatches was ${maxInFlight}, must be 1`);
    assert.deepEqual(order, ['shadow', 'foreground'], 'queue order must be preserved');
  });

  // 3. A shadow request gives up rather than queueing behind a long cooldown.
  gate.__resetQuoteGateForTest({ cooldownUntil: Date.now() + 30_000 });
  const startedAt = Date.now();
  const gaveUp = await Promise.race([
    gate.throughQuoteGateLowPriority(async () => 'dispatched'),
    new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 1_500)),
  ]);
  gate.__resetQuoteGateForTest();

  check('a shadow request waits (not dispatches) through a live cooldown', () => {
    assert.equal(gaveUp, 'still-waiting', 'the shadow request must not dispatch during a cooldown');
    assert.ok(Date.now() - startedAt < 3_000);
  });
}

await verifyQuoteGateSerialisation();

console.log(`R-Factor V2 verification passed: ${checks} checks`);
