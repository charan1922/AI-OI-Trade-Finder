/**
 * Re-anchor-at-placement SHADOW (strategy doc §7/§14) — PURE and replayable.
 *
 * Given the scanner-time plan a trade is about to be sent with, the freshest
 * spot at the placement moment, and the day's 5-min bars, this recomputes:
 *   - the FORWARD reward:risk to the STORED target/stop at the fresh entry
 *     (the doc's headline late-entry number — see §7's 1000/990/1020 worked
 *     example), and
 *   - the stop/target a full rebuild at placement WOULD produce.
 *
 * MEASUREMENT ONLY — the caller records the result; it never changes the order.
 * No I/O and no clocks (the caller passes bars + nowBucketTs), so it runs
 * identically live and in replay — the same discipline as trade-suggest/scoring.
 */
import type { StoredFyersBar } from '@/lib/fyers/candle-store';
import { atr } from '@/lib/signals/indicators';
import { deriveSessionContext } from '@/lib/signals/session-context';
import { MIN_RISK_PCT, SL_ATR_MULT, TARGET_RR } from '@/lib/trade-suggest/config';
import { buildSpotPlan } from '@/lib/trade-suggest/scoring';

export interface ReanchorInput {
  side: 'CE' | 'PE';
  direction: 'bullish' | 'bearish';
  /** The plan the trade is being sent with (scanner-time). */
  plannedSlSpot: number | null;
  plannedTargetSpot: number | null;
  /** Freshest underlying spot at the placement moment. */
  freshSpot: number;
  /** The day's 5-min bars for the underlying (for the rebuilt stop + OR + ATR). */
  bars: StoredFyersBar[];
  /** Current 5-min bucket start (bars at/after it are still forming — excluded). */
  nowBucketTs: number;
}

export interface ReanchorShadow {
  /** Forward reward:risk to the STORED target/stop at the fresh entry (doc §7).
   *  ≈ TARGET_RR when the plan was just re-anchored to this spot; well below 1
   *  means the real entry now risks more than it stands to make against the
   *  stored plan (a late chase). null when the fresh spot is already at/through
   *  the stored stop. */
  forwardRR: number | null;
  /** The stop/target a rebuild at placement WOULD produce from fresh bars —
   *  compare against the stored plan to see if the structural stop has drifted
   *  (e.g. a newer completed candle moved the last-candle low/high). */
  freshSlSpot: number | null;
  freshTargetSpot: number | null;
  freshSlBasis: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeReanchor(input: ReanchorInput): ReanchorShadow {
  const { side, direction, plannedSlSpot, plannedTargetSpot, freshSpot, bars, nowBucketTs } = input;
  const dirSign = direction === 'bullish' ? 1 : -1;

  let forwardRR: number | null = null;
  if (plannedSlSpot != null && plannedTargetSpot != null) {
    const fwdRisk = dirSign * (freshSpot - plannedSlSpot); // fresh entry → stored stop
    const fwdReward = dirSign * (plannedTargetSpot - freshSpot); // fresh entry → stored target
    forwardRR = fwdRisk > 0 ? round2(fwdReward / fwdRisk) : null;
  }

  // No-lookahead: exclude bars at/after the current bucket (still forming live,
  // or the future in replay) from the OR and the ATR just as buildSpotPlan does
  // for the structural stop. Without this the ATR floor (when SL_ATR_MULT > 0)
  // would be computed from a partial/future candle.
  const completedBars = bars.filter((b) => b.bucketTs < nowBucketTs);
  const or = deriveSessionContext(completedBars);
  const a14 = atr(completedBars);
  const fresh = buildSpotPlan(side, freshSpot, completedBars, or, nowBucketTs, {
    atr: a14,
    atrMult: SL_ATR_MULT,
    minRiskPct: MIN_RISK_PCT,
    targetRR: TARGET_RR,
  });

  return {
    forwardRR,
    freshSlSpot: fresh.slSpot,
    freshTargetSpot: fresh.targetSpot,
    freshSlBasis: fresh.slBasis,
  };
}

/**
 * True max favorable / adverse excursion in R over a hold, from candle
 * highs/lows — NOT close samples — measured against an IMMUTABLE initial risk.
 *
 * Both fixes the review raised (AT-review 2026-07-20):
 *  - the denominator is the risk AT ENTRY (entrySpot − initial stop), passed in
 *    by the caller and never the live trailing stop, so tightening the stop can
 *    never retroactively inflate a past R; and
 *  - favourable/adverse use the period high/low (the price genuinely traded
 *    there), so a close-sampled series can't understate the real excursion.
 *
 * Pure: the caller supplies the bars already scoped to "since entry".
 */
export interface ExcursionR {
  mfeR: number | null;
  maeR: number | null;
}

/**
 * Bars STRICTLY AFTER the entry 5-min bucket (AT-review 2026-07-20, finding 3).
 * The entry candle itself is excluded: with only 5-min OHLC the intra-candle
 * timing is unknowable, so that candle's high/low may have printed BEFORE the
 * fill (a stock that spiked pre-entry and pulled back afterward would otherwise
 * record a fake post-entry MFE). Conservative on purpose — it undercounts the
 * tail of the entry candle but never fabricates pre-entry excursion. Pure.
 */
export function barsAfterEntryBucket<T extends { bucketTs: number }>(bars: T[], entryBucketTs: number): T[] {
  return bars.filter((b) => b.bucketTs > entryBucketTs);
}

export function excursionR(
  direction: 'bullish' | 'bearish',
  entrySpot: number,
  initialRiskPoints: number,
  bars: Pick<StoredFyersBar, 'high' | 'low'>[]
): ExcursionR {
  if (!(initialRiskPoints > 0)) return { mfeR: null, maeR: null };
  const valid = bars.filter((b) => b.high > 0 && b.low > 0);
  if (valid.length === 0) return { mfeR: null, maeR: null };
  const maxHigh = Math.max(...valid.map((b) => b.high));
  const minLow = Math.min(...valid.map((b) => b.low));
  const bull = direction === 'bullish';
  const favSpot = bull ? maxHigh : minLow; // best price the trade saw
  const advSpot = bull ? minLow : maxHigh; // worst price the trade saw
  const dirSign = bull ? 1 : -1;
  return {
    mfeR: round2((dirSign * (favSpot - entrySpot)) / initialRiskPoints),
    maeR: round2((dirSign * (advSpot - entrySpot)) / initialRiskPoints),
  };
}
