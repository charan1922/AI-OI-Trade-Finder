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

  const or = deriveSessionContext(bars);
  const a14 = atr(bars);
  const fresh = buildSpotPlan(side, freshSpot, bars, or, nowBucketTs, {
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
