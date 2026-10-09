/**
 * Pure scoring + spot-plan math for /trade-suggest — extracted from engine.ts
 * so the live engine and the offline replay harness (scripts/replay-window.ts)
 * run the SAME code. No I/O, no clocks: callers pass every input, which is
 * what makes point-in-time backtesting honest (no lookahead can sneak in).
 */

import type { StoredFyersBar } from '@/lib/fyers/candle-store';
import { EXTENDED_SCORE_MULT, MIN_RISK_PCT, TARGET_RR, WEIGHTS } from '@/lib/trade-suggest/config';
import type { SpotPlan } from '@/lib/trade-suggest/types';

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export type ScoreWeights = Record<keyof typeof WEIGHTS, number>;

/** Everything the composite score reads — assembled live or replayed as-of a tick. */
export interface ScoreComponents {
  rFactor: number | null; // 1–10
  confidence: number | null; // [0,1]
  oiUrgency: number | null; // 0–10
  oiLevel: number | null; // ratio vs 20d avg
  orBreakout: boolean;
  imbalance: number | null; // bid share [0,1]
  direction: 'bullish' | 'bearish';
  /** Same-sector, same-direction survivors (including this one). */
  sectorPeers: number;
  setupLevel: string;
  extended: boolean;
}

/** The engine's composite score (see config.WEIGHTS for the rationale). */
export function computeCompositeScore(
  c: ScoreComponents,
  weights: ScoreWeights = WEIGHTS,
  extendedMult: number = EXTENDED_SCORE_MULT,
): number {
  const imb = c.imbalance ?? 0.5;
  let score =
    weights.rFactor * clamp01(((c.rFactor ?? 1) - 1) / 7) +
    weights.confidence * clamp01(c.confidence ?? 0) +
    weights.oiUrgency * clamp01((c.oiUrgency ?? 0) / 10) +
    weights.oiLevel * clamp01(((c.oiLevel ?? 1) - 1) / 0.5) +
    weights.orBreakout * (c.orBreakout ? 1 : 0) +
    weights.imbalanceAlign * clamp01(c.direction === 'bullish' ? imb : 1 - imb) +
    weights.sectorBreadth * clamp01((c.sectorPeers - 1) / 2) +
    weights.setupStrong * (c.setupLevel === 'strong' ? 1 : 0.5);
  if (c.extended) score *= extendedMult;
  return score;
}

export interface SpotPlanOptions {
  /** Minimum stop distance as % of entry (structural-SL noise floor). */
  minRiskPct?: number;
  /** Latest ATR of the 5-min series; used when atrMult > 0. */
  atr?: number | null;
  /** Risk floor becomes max(minRiskPct%, atrMult × ATR). 0 = % floor only. */
  atrMult?: number;
  targetRR?: number;
}

/**
 * Spot-level plan: entry at LTP; SL at the last COMPLETED 5-min candle's
 * low (CE) / high (PE). When price has already moved past that candle, the SL
 * is the NEAREST SWING: the most recent completed candle whose low (CE) / high
 * (PE) is still beyond the entry ('swing'). Only when no candle qualifies does
 * it fall back to the opening-range boundary. The risk is floored (slBasis
 * 'floor') when the structural level sits inside normal 5-min noise; target at
 * TARGET_RR × risk.
 *
 * Why the swing step (2026-10-09): ADANIENT 2650 PE on 2026-10-08 11:10 sat
 * above its last candle's high, so the stop fell straight to the opening-range
 * HIGH 2743 — 4% away, ₹12,842 of risk on one lot. The nearest swing was the
 * 10:15 high 2647, floored to 1% → 2664.68 (₹3,888). Over 20 sessions of real
 * candles, on the 326 such entries whose OR stop was > 1.5% away, the swing stop
 * kept the same average move (+0.20% vs +0.19%) at about half the distance
 * (1.00% vs 1.89% median) and cut the worst trade from −3.13% to −1.47%.
 *
 * `nowBucketTs` is the CURRENT bucket's start — bars at/after it are still
 * forming and are excluded (in replay this is the scan tick's bucket, which
 * keeps the plan strictly point-in-time).
 */
export function buildSpotPlan(
  side: 'CE' | 'PE',
  entry: number,
  bars: Pick<StoredFyersBar, 'bucketTs' | 'high' | 'low'>[],
  or: { openRangeHigh: number | null; openRangeLow: number | null },
  nowBucketTs: number,
  opts: SpotPlanOptions = {},
): SpotPlan {
  const completed = bars.filter((b) => b.bucketTs < nowBucketTs && b.high > 0);
  const lastBar = completed.length > 0 ? completed[completed.length - 1] : null;

  let sl: number | null = null;
  let slBasis: SpotPlan['slBasis'] = 'none';
  // Nearest completed candle (newest first) whose protective extreme is beyond
  // the entry — the last candle itself when it qualifies.
  const swing = [...completed].reverse().find((b) => (side === 'CE' ? b.low < entry : b.high > entry)) ?? null;
  if (side === 'CE') {
    if (swing) {
      sl = swing.low;
      slBasis = swing === lastBar ? 'last-candle' : 'swing';
    } else if (or.openRangeLow != null && or.openRangeLow < entry) {
      sl = or.openRangeLow;
      slBasis = 'opening-range';
    }
  } else {
    if (swing) {
      sl = swing.high;
      slBasis = swing === lastBar ? 'last-candle' : 'swing';
    } else if (or.openRangeHigh != null && or.openRangeHigh > entry) {
      sl = or.openRangeHigh;
      slBasis = 'opening-range';
    }
  }

  // Floor the risk: a structural SL inside normal 5-min noise is a guaranteed
  // stop-out. The floor is the max of the % floor and (optionally) a volatility
  // floor in ATR units — the A/B-tested variant lives behind atrMult.
  if (sl != null) {
    const pctFloor = (entry * (opts.minRiskPct ?? MIN_RISK_PCT)) / 100;
    const atrFloor = opts.atr != null && (opts.atrMult ?? 0) > 0 ? (opts.atrMult ?? 0) * opts.atr : 0;
    const minRisk = Math.max(pctFloor, atrFloor);
    if (Math.abs(entry - sl) < minRisk) {
      sl = side === 'CE' ? entry - minRisk : entry + minRisk;
      slBasis = 'floor';
    }
  }

  const rr = opts.targetRR ?? TARGET_RR;
  const target = sl == null ? null : side === 'CE' ? entry + rr * (entry - sl) : entry - rr * (sl - entry);
  const round = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);
  return { entrySpot: entry, slSpot: round(sl), targetSpot: round(target), slBasis };
}
