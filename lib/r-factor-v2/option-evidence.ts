import type { DetailedOptionChain, DetailedOptionSide } from '@/lib/dhan/market-feed';
import { computeGex, type OptionChainStrike } from '@/lib/signals/gex';
import type {
  OptionActivityEvidence,
  OptionStrikeEvidence,
  PaceBaselineKind,
  RFactorV2Direction,
} from './types';

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const ratioOrNull = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;
const pctOrNull = (current: number, previous: number): number | null =>
  previous > 0 ? ((current - previous) / previous) * 100 : null;

/**
 * Fraction of the session elapsed. Used ONLY by the fallback pace, and it is a
 * known-imperfect assumption: real intraday volume is U-shaped, heaviest at the
 * open and close, so scaling a prior FULL day linearly overstates the expected
 * pace late morning and understates it near the bell. Anything derived from it
 * is labelled 'prior-session-linear' so no reader mistakes it for measurement.
 */
function sessionFraction(iso: string): number {
  const timestamp = Date.parse(iso);
  const istSeconds = timestamp / 1000 + 5.5 * 3600;
  const minute = Math.floor((((istSeconds % 86400) + 86400) % 86400) / 60);
  return Math.max(0.05, Math.min(1, (minute - (9 * 60 + 15)) / 375));
}

function evidenceRow(strike: number, side: 'CE' | 'PE', value: DetailedOptionSide): OptionStrikeEvidence {
  return {
    strike,
    side,
    delta: value.greeks?.delta ?? null,
    oi: value.oi,
    previousOi: value.previousOi,
    volume: value.volume,
    previousVolume: value.previousVolume,
    ltp: value.lastPrice,
    previousClose: value.previousClosePrice,
    iv: value.impliedVolatility,
    bid: value.topBidPrice,
    ask: value.topAskPrice,
  };
}

/**
 * Converts the full chain into auditable near-money evidence. We retain every
 * qualifying leg used by the calculation, not only the final aggregate.
 *
 * `sameClockPremiumBaseline` is this underlying's median traded premium value at
 * this clock time on prior sessions, from retained evidence. When it exists the
 * pace is a measurement; when it does not, the linear prior-session estimate is
 * used, is labelled as such, and is deliberately given less weight.
 */
export function deriveOptionActivityEvidence(
  chain: DetailedOptionChain,
  expiry: string,
  sameClockPremiumBaseline: number | null = null,
  lotSize = 1,
): OptionActivityEvidence {
  const rows: OptionStrikeEvidence[] = [];
  for (const strike of chain.strikes) {
    for (const [side, value] of [
      ['CE', strike.ce],
      ['PE', strike.pe],
    ] as const) {
      if (value == null) continue;
      const delta = Math.abs(value.greeks?.delta ?? 0);
      const nearByDelta = delta >= 0.1 && delta <= 0.9;
      const nearByPrice = Math.abs(strike.strike / chain.underlyingLastPrice - 1) <= 0.08;
      if (!nearByDelta && !nearByPrice) continue;
      if (!(value.oi > 0 || value.volume > 0)) continue;
      rows.push(evidenceRow(strike.strike, side, value));
    }
  }

  const sum = (side: 'CE' | 'PE', field: keyof OptionStrikeEvidence): number =>
    rows.filter((row) => row.side === side).reduce((total, row) => total + Number(row[field] ?? 0), 0);
  const callOi = sum('CE', 'oi');
  const putOi = sum('PE', 'oi');
  const previousCallOi = sum('CE', 'previousOi');
  const previousPutOi = sum('PE', 'previousOi');
  const callVolume = sum('CE', 'volume');
  const putVolume = sum('PE', 'volume');

  // Delta-weighted OI: a 0.12-delta wing is mostly a cheap lottery ticket and
  // must not count like an at-the-money strike. Legs with no delta fall back to
  // a neutral 0.5 rather than being dropped.
  const deltaWeightedOi = (side: 'CE' | 'PE'): number =>
    rows
      .filter((row) => row.side === side)
      .reduce((total, row) => total + row.oi * (row.delta == null ? 0.5 : Math.abs(row.delta)), 0);

  const callPremiumValue = rows
    .filter((row) => row.side === 'CE')
    .reduce((total, row) => total + row.ltp * row.volume, 0);
  const putPremiumValue = rows
    .filter((row) => row.side === 'PE')
    .reduce((total, row) => total + row.ltp * row.volume, 0);
  const previousPremiumValue = rows.reduce(
    (total, row) => total + row.previousClose * row.previousVolume,
    0,
  );
  const currentPremiumValue = callPremiumValue + putPremiumValue;
  const optionVolume = callVolume + putVolume;

  const usingSameClock = sameClockPremiumBaseline != null && sameClockPremiumBaseline > 0;
  const pace = usingSameClock
    ? ratioOrNull(currentPremiumValue, sameClockPremiumBaseline)
    : ratioOrNull(currentPremiumValue, previousPremiumValue * sessionFraction(chain.fetchedAt));
  const paceBaselineKind: PaceBaselineKind =
    pace == null ? 'missing' : usingSameClock ? 'same-time' : 'prior-session-linear';

  const callOiChangePct = pctOrNull(callOi, previousCallOi);
  const putOiChangePct = pctOrNull(putOi, previousPutOi);
  const previousTotalOi = previousCallOi + previousPutOi;
  // A level-vs-level comparison. Unlike a pace it needs no assumption about how
  // activity is distributed through the day, which is why it carries more of the
  // score whenever the pace is only a linear estimate.
  const oiChangeIntensity =
    previousTotalOi > 0 ? (Math.abs(callOi - previousCallOi) + Math.abs(putOi - previousPutOi)) / previousTotalOi : 0;
  const priorVolume = rows.reduce((total, row) => total + row.previousVolume, 0);
  const volumePace = ratioOrNull(optionVolume, priorVolume * sessionFraction(chain.fetchedAt));

  const weights = usingSameClock
    ? { pace: 0.5, oi: 0.35, volume: 0.15 }
    : { pace: 0.3, oi: 0.55, volume: 0.15 };
  const activityScore = clamp01(
    weights.pace * clamp01((pace ?? 0) / 3) +
      weights.oi * clamp01(oiChangeIntensity / 0.2) +
      weights.volume * clamp01((volumePace ?? 0) / 3),
  );

  let directionNumerator = 0;
  let directionDenominator = 0;
  for (const row of rows) {
    const oiChange = row.oi - row.previousOi;
    if (!(oiChange > 0) || !(row.previousClose > 0) || !(row.ltp > 0)) continue;
    const premiumDirection = Math.sign(row.ltp - row.previousClose);
    if (premiumDirection === 0) continue;
    // Call buying / put writing are bullish; put buying / call writing bearish.
    const sideDirection = row.side === 'CE' ? premiumDirection : -premiumDirection;
    const moneyness = row.delta == null ? 0.5 : Math.abs(row.delta);
    const economicWeight =
      Math.sqrt(Math.max(1, row.ltp * row.volume)) *
      clamp01(oiChange / Math.max(row.previousOi, 1)) *
      moneyness;
    directionNumerator += sideDirection * economicWeight;
    directionDenominator += economicWeight;
  }
  const directionScore = directionDenominator > 0 ? directionNumerator / directionDenominator : 0;
  const direction: RFactorV2Direction =
    directionScore >= 0.15 ? 'bullish' : directionScore <= -0.15 ? 'bearish' : 'neutral';

  // Gamma evidence, recorded only. Reuses the existing NIFTY proxy so there is
  // one gamma convention in the codebase, and inherits its explicit disclaimer:
  // the call-minus-put sign is an analytical convention, NOT dealer inventory.
  const gexRows: OptionChainStrike[] = [];
  for (const strike of chain.strikes) {
    const ce = strike.ce;
    const pe = strike.pe;
    if (ce?.greeks == null && pe?.greeks == null) continue;
    if (Math.abs(strike.strike / chain.underlyingLastPrice - 1) > 0.08) continue;
    gexRows.push({
      strike: strike.strike,
      callGamma: Math.max(0, ce?.greeks?.gamma ?? 0),
      callOi: Math.max(0, ce?.oi ?? 0),
      putGamma: Math.max(0, pe?.greeks?.gamma ?? 0),
      putOi: Math.max(0, pe?.oi ?? 0),
    });
  }
  const gex = gexRows.length > 0 ? computeGex(gexRows, chain.underlyingLastPrice, lotSize) : null;
  const grossGamma = gex == null ? 0 : gex.callWeight + gex.putWeight;

  return {
    capturedAt: chain.fetchedAt,
    expiry,
    underlyingLtp: chain.underlyingLastPrice,
    strikesUsed: rows.length,
    totalStrikes: chain.strikes.length,
    activityScore: Math.round(activityScore * 1000) / 1000,
    directionScore: Math.round(directionScore * 1000) / 1000,
    direction,
    directionConfidence: Math.round(Math.abs(directionScore) * 1000) / 1000,
    oiPcr: ratioOrNull(putOi, callOi),
    volumePcr: ratioOrNull(putVolume, callVolume),
    premiumValuePcr: ratioOrNull(putPremiumValue, callPremiumValue),
    moneynessWeightedOiPcr: ratioOrNull(deltaWeightedOi('PE'), deltaWeightedOi('CE')),
    premiumTurnoverPace: pace,
    paceBaselineKind,
    premiumValue: currentPremiumValue,
    optionVolume,
    callOiChangePct,
    putOiChangePct,
    gammaNetSharePct: gex == null || grossGamma <= 0 ? null : Math.round(gex.netSharePct * 100) / 100,
    gammaConcentrationStrike: gex?.concentrationStrike ?? null,
    gammaConcentrationDistancePct:
      gex?.concentrationStrike != null && chain.underlyingLastPrice > 0
        ? Math.round(((gex.concentrationStrike / chain.underlyingLastPrice - 1) * 100) * 100) / 100
        : null,
    grossGamma,
    rows,
  };
}
