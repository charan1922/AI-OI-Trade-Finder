import type {
  RFactorV2Direction,
  RFactorV2Factor,
  RFactorV2Input,
  RFactorV2Result,
} from './types';

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const clampSigned = (value: number): number => Math.max(-1, Math.min(1, value));
const round = (value: number, digits = 3): number => {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
};

/**
 * Activity weights. `option` is the only factor a name cannot supply on its own
 * — option chains are fetched for a shortlist — so it is deliberately last and
 * excluded from the comparable score used for ranking.
 */
const ACTIVITY_WEIGHTS = {
  range: 0.2,
  turnover: 0.18,
  futuresOiChange: 0.12,
  oiLevel: 0.07,
  oiVelocity: 0.06,
  nseCombinedOi: 0.09,
  nsePremium: 0.05,
  sectorRelative: 0.08,
  option: 0.15,
} as const;

const TOTAL_ACTIVITY_WEIGHT = Object.values(ACTIVITY_WEIGHTS).reduce((sum, value) => sum + value, 0);
const COMPARABLE_WEIGHT = TOTAL_ACTIVITY_WEIGHT - ACTIVITY_WEIGHTS.option;
/** Weight of the factors present before sector context is known (pass one). */
const CORE_WEIGHT = COMPARABLE_WEIGHT - ACTIVITY_WEIGHTS.sectorRelative;

const DIRECTION_WEIGHTS = {
  price: 0.22,
  priceOiQuadrant: 0.2,
  oiSlope: 0.08,
  imbalance: 0.1,
  sector: 0.1,
  option: 0.3,
} as const;
const TOTAL_DIRECTION_WEIGHT = Object.values(DIRECTION_WEIGHTS).reduce((sum, value) => sum + value, 0);

/** A sector's peers, measured this same poll. Never includes the stock itself. */
export interface RFactorV2SectorContext {
  peerMeanCoreActivity: number | null;
  peerDirectionBias: number | null;
  peers: number;
}

/** Minimum measured peers before a sector-relative comparison means anything. */
const MIN_SECTOR_PEERS = 3;
/** Coverage a name needs before it may contribute to its sector's mean. */
const MIN_CORE_COVERAGE_FOR_SECTOR = 0.5;
/** Comparable coverage required before a name is ranked at all. */
const MIN_RANK_COVERAGE = 0.55;

function factor(
  key: string,
  label: string,
  weight: number,
  value: number | null,
  score: (value: number) => number,
  detail: (value: number) => string,
): RFactorV2Factor {
  return value == null || !Number.isFinite(value)
    ? { key, label, weight, score: 0, available: false, detail: 'not captured' }
    : { key, label, weight, score: clamp01(score(value)), available: true, detail: detail(value) };
}

function percentile(values: number[], value: number): number {
  if (values.length <= 1) return 1;
  const below = values.filter((candidate) => candidate < value).length;
  const equal = values.filter((candidate) => candidate === value).length;
  return clamp01((below + Math.max(0, equal - 1) / 2) / (values.length - 1));
}

const weightedOf = (factors: RFactorV2Factor[]): number =>
  factors.reduce((sum, item) => sum + item.weight * item.score, 0);
const availableWeightOf = (factors: RFactorV2Factor[]): number =>
  factors.reduce((sum, item) => sum + (item.available ? item.weight : 0), 0);

/**
 * The seven factors every F&O name can supply from the live poll alone. These
 * are what ranking and the sector comparison are built on, so that a name is
 * never out-ranked purely because it was not chosen for option enrichment.
 */
function buildCoreFactors(input: RFactorV2Input): RFactorV2Factor[] {
  return [
    factor(
      'range',
      'Range expansion vs 20 sessions',
      ACTIVITY_WEIGHTS.range,
      input.rangeRatio,
      (value) => (value - 0.8) / 1.7,
      (value) => `${round(value, 2)}x normal range`,
    ),
    // Prefer the per-stock robust z when this name has enough of its own
    // history: 2x turnover in a habitually quiet name is a far bigger event
    // than 2x in one that swings every day, and a shared ratio curve cannot
    // tell them apart.
    input.turnoverZ != null
      ? factor(
          'turnover',
          'Futures turnover pace (per-stock z)',
          ACTIVITY_WEIGHTS.turnover,
          input.turnoverZ,
          (value) => value / 4,
          (value) =>
            `${round(value, 2)} robust z vs own same-clock history` +
            (input.turnoverPace != null ? ` (${round(input.turnoverPace, 2)}x median)` : ''),
        )
      : factor(
          'turnover',
          'Futures turnover pace',
          ACTIVITY_WEIGHTS.turnover,
          input.turnoverPace,
          (value) => (value - 0.75) / 2.25,
          (value) => `${round(value, 2)}x ${input.turnoverBaselineKind} baseline`,
        ),
    factor(
      'futuresOiChange',
      'Absolute futures OI change',
      ACTIVITY_WEIGHTS.futuresOiChange,
      input.futuresOiChangePct,
      (value) => Math.abs(value) / 10,
      (value) => `${round(value, 2)}% vs previous session (unsigned activity)`,
    ),
    factor(
      'oiLevel',
      'Futures OI level',
      ACTIVITY_WEIGHTS.oiLevel,
      input.oiLevel,
      (value) => (value - 0.9) / 0.6,
      (value) => `${round(value, 2)}x 20-session average`,
    ),
    factor(
      'oiVelocity',
      'Intraday OI velocity',
      ACTIVITY_WEIGHTS.oiVelocity,
      input.oiVelocity,
      (value) => Math.abs(value) / 2,
      (value) => `${round(value, 2)} per-mille of opening OI per minute`,
    ),
    factor(
      'nseCombinedOi',
      'NSE combined OI change',
      ACTIVITY_WEIGHTS.nseCombinedOi,
      input.nseCombinedOiChangePct,
      (value) => Math.abs(value) / 15,
      (value) => `${round(value, 2)}% futures plus options OI`,
    ),
    factor(
      'nsePremium',
      'Options premium participation',
      ACTIVITY_WEIGHTS.nsePremium,
      input.nsePremiumPace,
      (value) => (value - 0.75) / 2.25,
      (value) => `${round(value, 2)}x prior-session same-clock premium value`,
    ),
  ];
}

/** Pass-one activity over the always-available factors, plus its own coverage. */
export function computeCoreActivity(input: RFactorV2Input): { raw: number; coverage: number } {
  const core = buildCoreFactors(input);
  return { raw: weightedOf(core) / CORE_WEIGHT, coverage: availableWeightOf(core) / CORE_WEIGHT };
}

type UnrankedResult = Omit<RFactorV2Result, 'activityPercentile' | 'activityRank' | 'universeSize'>;

/**
 * Activity is deliberately unsigned. Missing factors contribute zero against a
 * fixed denominator and lower `coverage`; they are never silently reweighted.
 * Direction is calculated separately so a violent sell-off can have high
 * activity without becoming a bullish signal.
 */
export function computeRFactorV2(input: RFactorV2Input, sector?: RFactorV2SectorContext): UnrankedResult {
  const core = buildCoreFactors(input);
  const coreRaw = weightedOf(core) / CORE_WEIGHT;
  const sectorUsable =
    sector != null && sector.peers >= MIN_SECTOR_PEERS && sector.peerMeanCoreActivity != null
      ? sector
      : null;

  const factors: RFactorV2Factor[] = [
    ...core,
    factor(
      'sectorRelative',
      'Activity vs sector peers',
      ACTIVITY_WEIGHTS.sectorRelative,
      sectorUsable != null && (sectorUsable.peerMeanCoreActivity ?? 0) > 0
        ? coreRaw / (sectorUsable.peerMeanCoreActivity as number)
        : null,
      (value) => (value - 0.8) / 0.8,
      (value) => `${round(value, 2)}x the mean of ${sectorUsable?.peers ?? 0} measured sector peers`,
    ),
    factor(
      'option',
      'Strike-aware option activity',
      ACTIVITY_WEIGHTS.option,
      input.option?.activityScore ?? null,
      (value) => value,
      () => `${input.option?.strikesUsed ?? 0} liquid near-money option legs`,
    ),
  ];

  const comparable = factors.filter((item) => item.key !== 'option');
  const rawActivity = weightedOf(factors) / TOTAL_ACTIVITY_WEIGHT;
  const activityScore = 1 + 7 * rawActivity;

  // Independent directional votes. OI magnitude never chooses a side by itself.
  let directionalWeight = 0;
  let directionalSum = 0;
  const vote = (value: number | null, weight: number, transform: (value: number) => number) => {
    if (value == null || !Number.isFinite(value)) return;
    directionalWeight += weight;
    directionalSum += weight * clampSigned(transform(value));
  };
  const priceSide = input.priceChangePct == null ? null : Math.sign(input.priceChangePct);

  vote(input.priceChangePct, DIRECTION_WEIGHTS.price, (value) => value / 2);
  if (priceSide != null && input.futuresOiChangePct != null) {
    // Price up + OI building = fresh longs; price up on falling OI = covering.
    // The quadrant, not the OI magnitude, is what carries the sign.
    const oiBuilding = input.futuresOiChangePct > 0.1;
    vote(priceSide * (oiBuilding ? 1 : 0.45), DIRECTION_WEIGHTS.priceOiQuadrant, (value) => value);
  }
  // NSE OI slope can only confirm a side the price already implies, so it is
  // skipped outright when the price move is unknown. Casting it as a zero vote
  // would quietly drag every unpriced name toward neutral.
  if (priceSide != null && priceSide !== 0) {
    vote(input.nseOiSlope30m, DIRECTION_WEIGHTS.oiSlope, (value) => (priceSide * Math.abs(value)) / 2);
  }
  vote(input.imbalance, DIRECTION_WEIGHTS.imbalance, (value) => (value - 0.5) / 0.2);
  // Peer direction is genuinely independent evidence: it is other stocks' moves,
  // not a second reading of this one.
  if (sectorUsable != null) vote(sectorUsable.peerDirectionBias, DIRECTION_WEIGHTS.sector, (value) => value);
  if (input.option != null) vote(input.option.directionScore, DIRECTION_WEIGHTS.option, (value) => value);

  const directionScore = directionalWeight > 0 ? directionalSum / directionalWeight : 0;
  const direction: RFactorV2Direction =
    directionScore >= 0.15 ? 'bullish' : directionScore <= -0.15 ? 'bearish' : 'neutral';

  return {
    activityScore: round(activityScore, 2),
    rawActivity: round(rawActivity, 4),
    comparableActivity: round(weightedOf(comparable) / COMPARABLE_WEIGHT, 4),
    direction,
    directionScore: round(directionScore, 3),
    // Confidence falls when the evidence behind the side is thin, not only when
    // the votes disagree.
    directionConfidence: round(
      Math.abs(directionScore) * (directionalWeight / TOTAL_DIRECTION_WEIGHT),
      3,
    ),
    coverage: round(availableWeightOf(factors) / TOTAL_ACTIVITY_WEIGHT, 3),
    comparableCoverage: round(availableWeightOf(comparable) / COMPARABLE_WEIGHT, 3),
    optionStatus: input.option == null ? 'pending' : 'available',
    factors,
  };
}

/**
 * Two passes. The first measures every name on the factors all of them have,
 * which is what the sector comparison needs. The second scores each name with
 * its sector context and ranks on `comparableActivity`.
 *
 * Ranking deliberately ignores option evidence. Chains are fetched only for the
 * names already leading, so ranking on a score only they can earn would let
 * today's leaders keep re-selecting themselves while a newly active name stayed
 * structurally capped below them.
 */
export function computeRFactorV2Batch(inputs: RFactorV2Input[]): Map<string, RFactorV2Result> {
  const cores = new Map(inputs.map((input) => [input.symbol, computeCoreActivity(input)]));

  const sectorTotals = new Map<string, { activity: number; measured: number; bias: number; priced: number }>();
  for (const input of inputs) {
    if (input.sector == null) continue;
    const core = cores.get(input.symbol);
    const entry = sectorTotals.get(input.sector) ?? { activity: 0, measured: 0, bias: 0, priced: 0 };
    if (core != null && core.coverage >= MIN_CORE_COVERAGE_FOR_SECTOR) {
      entry.activity += core.raw;
      entry.measured += 1;
    }
    if (input.priceChangePct != null && Number.isFinite(input.priceChangePct)) {
      entry.bias += clampSigned(input.priceChangePct / 2);
      entry.priced += 1;
    }
    sectorTotals.set(input.sector, entry);
  }

  // Peer context excludes the stock itself so a name can never justify its own
  // sector-relative score or vote for its own direction twice.
  const contextFor = (input: RFactorV2Input): RFactorV2SectorContext | undefined => {
    if (input.sector == null) return undefined;
    const totals = sectorTotals.get(input.sector);
    if (totals == null) return undefined;
    const core = cores.get(input.symbol);
    const selfMeasured = core != null && core.coverage >= MIN_CORE_COVERAGE_FOR_SECTOR;
    const peerCount = totals.measured - (selfMeasured ? 1 : 0);
    const peerActivity = totals.activity - (selfMeasured ? (core?.raw ?? 0) : 0);
    const selfPriced = input.priceChangePct != null && Number.isFinite(input.priceChangePct);
    const pricedPeers = totals.priced - (selfPriced ? 1 : 0);
    const peerBias = totals.bias - (selfPriced ? clampSigned((input.priceChangePct as number) / 2) : 0);
    return {
      peerMeanCoreActivity: peerCount > 0 ? peerActivity / peerCount : null,
      peerDirectionBias: pricedPeers >= MIN_SECTOR_PEERS ? peerBias / pricedPeers : null,
      peers: peerCount,
    };
  };

  const base = inputs.map((input) => ({ input, result: computeRFactorV2(input, contextFor(input)) }));
  const rankable = base.filter(({ result }) => result.comparableCoverage >= MIN_RANK_COVERAGE);
  const values = rankable.map(({ result }) => result.comparableActivity);
  const ordered = [...rankable].sort((a, b) => b.result.comparableActivity - a.result.comparableActivity);
  const ranks = new Map(ordered.map((item, index) => [item.input.symbol, index + 1]));
  const output = new Map<string, RFactorV2Result>();
  for (const item of base) {
    const isRankable = item.result.comparableCoverage >= MIN_RANK_COVERAGE;
    output.set(item.input.symbol, {
      ...item.result,
      activityPercentile: isRankable ? round(percentile(values, item.result.comparableActivity), 3) : 0,
      activityRank: ranks.get(item.input.symbol) ?? 0,
      universeSize: rankable.length,
    });
  }
  return output;
}
