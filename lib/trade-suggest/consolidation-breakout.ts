/**
 * Consolidation breakout — the "coil then pop" read on the recorded 5-min bars.
 *
 * WHY THIS EXISTS
 * ---------------
 * The engine already knows about the OPENING-RANGE breakout (`orBreakout`, one
 * fixed 09:15–09:30 box) and TradeFinder's 3-check verdict (`tfBreakout`, which
 * scores named swing levels). Neither answers the question a discretionary
 * trader actually asks at 10:15: *did this stock go quiet, coil into a tight
 * range, and then leave it on real volume?* That pattern is the highest-quality
 * intraday entry available because it hands you three things at once:
 *
 *   1. a REASON the move started (supply/demand resolved out of a balance area),
 *   2. a natural, structural STOP (the far side of the coil — not a % guess),
 *   3. a measurable RISK, because a tight base is by definition a small stop.
 *
 * Contrast with a name that has trended all morning: there is no base, so the
 * stop has to be invented, which is exactly how the engine ended up placing
 * stops inside noise. A coil gives the plan a level the market itself drew.
 *
 * WHAT IT IS NOT
 * --------------
 * This is EVIDENCE, not an admission path and not a gate. It never lets a
 * candidate past a gate it would otherwise fail, and it never sizes or selects.
 * It is attached to a pick so the ranking, the reasons list, and the AI's
 * entry bar can all prefer a coil-and-pop over a chase. Nothing here fabricates
 * a level: with too few completed bars it returns null and says so.
 *
 * PURE (no imports beyond the bar type, no clock, no I/O) so the offline replay
 * harness and CI can drive it exactly as the live engine does.
 */

import type { IndicatorBar } from '@/lib/signals/indicators';

export type ConsolidationGrade = 'unconfirmed' | 'confirmed' | 'strong';

export interface ConsolidationBreakout {
  direction: 'bullish' | 'bearish';
  grade: ConsolidationGrade;
  /** Top/bottom of the coil the price broke out of. */
  baseHigh: number;
  baseLow: number;
  /** The edge that was broken — the structural stop reference. */
  pivot: number;
  /** Coil height as % of its own mid — the tightness measure. */
  baseRangePct: number;
  /** Bars in the coil (5-min each). */
  baseBars: number;
  /** Completed bars since the breakout bar closed (0 = it just broke). */
  barsSinceBreakout: number;
  /** Breakout-bar volume ÷ average coil-bar volume. Null when the coil printed
   *  no volume at all (a real possibility on thin names — never assumed to be 1). */
  volumeMult: number | null;
  /** How far the latest close sits beyond the pivot, as % of the pivot. Large
   *  values mean the easy part is over — the entry is a chase, not a breakout. */
  extensionPct: number;
  /** True when extensionPct exceeds maxExtensionPct: detected, but late. */
  extended: boolean;
  detail: string;
}

export interface ConsolidationConfig {
  /** Bars forming the coil (6 × 5-min = 30 min of balance). */
  baseBars: number;
  /** A coil must be no taller than this (% of its mid) to count at all. */
  maxBaseRangePct: number;
  /** Tighter than this counts as a genuinely coiled base (part of 'strong'). */
  tightBaseRangePct: number;
  /** The breakout close must clear the edge by at least this % — a one-tick
   *  poke over the high is not a breakout. */
  minBreakBufferPct: number;
  /** Breakout-bar volume ÷ coil average needed for 'strong'. */
  minVolumeMult: number;
  /** Only look this many completed bars back for the breakout bar. Older than
   *  that and the move is no longer "just left the base". */
  maxBarsSinceBreak: number;
  /** Beyond this extension the pick is flagged extended (a chase). */
  maxExtensionPct: number;
}

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  baseBars: 6,
  maxBaseRangePct: 1.2,
  tightBaseRangePct: 0.8,
  minBreakBufferPct: 0.1,
  minVolumeMult: 1.3,
  maxBarsSinceBreak: 4,
  maxExtensionPct: 1.5,
};

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Detect the most recent coil-and-pop in `direction` that is STILL INTACT.
 *
 * "Still intact" is the load-bearing part: every completed bar after the
 * breakout bar must have CLOSED beyond the broken edge. A break that closed
 * back inside the coil is a failed breakout, and this returns null for it
 * rather than reporting the original pop — reporting it would describe a
 * pattern the market has already rejected.
 *
 * `nowBucketTs` is the CURRENT (still forming) bucket's start; bars at or after
 * it are excluded so the read is strictly point-in-time and the replay harness
 * cannot see the future.
 */
export function detectConsolidationBreakout(
  bars: readonly IndicatorBar[],
  direction: 'bullish' | 'bearish',
  nowBucketTs: number,
  cfg: ConsolidationConfig = DEFAULT_CONSOLIDATION_CONFIG
): ConsolidationBreakout | null {
  const completed = bars
    .filter((b) => b.bucketTs < nowBucketTs && b.high > 0 && b.low > 0 && b.close > 0)
    .sort((a, b) => a.bucketTs - b.bucketTs);
  if (completed.length < cfg.baseBars + 1) return null;

  const lastClose = completed[completed.length - 1].close;

  // Walk the OLDEST allowed breakout bar first: when several candidate bars
  // qualify, the earliest one is where the move actually began, which makes
  // barsSinceBreakout an honest "how long has this held" rather than the
  // flattering "it broke out again just now".
  for (let k = cfg.maxBarsSinceBreak; k >= 0; k -= 1) {
    const breakIdx = completed.length - 1 - k;
    if (breakIdx < cfg.baseBars) continue;

    const base = completed.slice(breakIdx - cfg.baseBars, breakIdx);
    const baseHigh = Math.max(...base.map((b) => b.high));
    const baseLow = Math.min(...base.map((b) => b.low));
    const baseMid = (baseHigh + baseLow) / 2;
    if (!(baseMid > 0)) continue;

    // Rounded before every comparison so the number REPORTED is the number
    // GRADED. Unrounded, a coil that displays as "0.80% wide" can still be
    // 0.8000000000000114 and fail a `<= 0.8` tightness test, which reads as a
    // contradiction to anyone looking at the output.
    const baseRangePct = round2(((baseHigh - baseLow) / baseMid) * 100);
    if (baseRangePct > cfg.maxBaseRangePct) continue; // not a coil — just a range

    const pivot = direction === 'bullish' ? baseHigh : baseLow;
    const buffer = (pivot * cfg.minBreakBufferPct) / 100;
    const breakBar = completed[breakIdx];
    const brokeOut =
      direction === 'bullish' ? breakBar.close > pivot + buffer : breakBar.close < pivot - buffer;
    if (!brokeOut) continue;

    // Every later completed bar must still be closing on the breakout side.
    const held = completed
      .slice(breakIdx + 1)
      .every((b) => (direction === 'bullish' ? b.close > pivot : b.close < pivot));
    if (!held) continue;

    const baseVolume = base.reduce((sum, b) => sum + (b.volume > 0 ? b.volume : 0), 0);
    const volumeMult =
      baseVolume > 0 && breakBar.volume > 0
        ? round2(breakBar.volume / (baseVolume / cfg.baseBars))
        : null;

    const extensionPct = round2(
      direction === 'bullish' ? ((lastClose - pivot) / pivot) * 100 : ((pivot - lastClose) / pivot) * 100
    );
    const extended = extensionPct > cfg.maxExtensionPct;

    const tight = baseRangePct <= cfg.tightBaseRangePct;
    const volumeConfirmed = volumeMult != null && volumeMult >= cfg.minVolumeMult;
    const grade: ConsolidationGrade =
      k === 0 ? 'unconfirmed' : tight && volumeConfirmed ? 'strong' : 'confirmed';

    const volumeText =
      volumeMult == null
        ? 'coil volume unrecorded, so the expansion is unmeasured'
        : `breakout bar traded ${volumeMult.toFixed(1)}× the coil's average volume`;
    const holdText =
      k === 0
        ? 'it broke on the latest completed bar — no hold bar yet'
        : `it has held for ${k} completed bar${k === 1 ? '' : 's'} since`;

    return {
      direction,
      grade,
      baseHigh: round2(baseHigh),
      baseLow: round2(baseLow),
      pivot: round2(pivot),
      baseRangePct,
      baseBars: cfg.baseBars,
      barsSinceBreakout: k,
      volumeMult,
      extensionPct,
      extended,
      detail:
        `coiled ${baseRangePct.toFixed(2)}% wide over ${cfg.baseBars} bars ` +
        `(${round2(baseLow)}–${round2(baseHigh)}), then closed ${direction === 'bullish' ? 'above' : 'below'} ` +
        `${round2(pivot)}; ${volumeText}; ${holdText}` +
        (extended ? `; already ${extensionPct.toFixed(2)}% past the pivot — late` : ''),
    };
  }
  return null;
}
