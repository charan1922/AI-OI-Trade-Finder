/**
 * PURE quant-SHADOW checks — no DB, no clocks, no I/O. Extracted from
 * verify-auto-trade.ts so the SAME assertions run both in the money-touching
 * box bench AND in GitHub CI (scripts/verify-quant-shadow.ts), closing the
 * "CI doesn't exercise the shadow math" gap (AT-review 2026-07-20 finding 6).
 *
 * Every function under test is pure (lib/auto-trade/quant/*, trade-suggest
 * sector-rank), so these run identically anywhere the source compiles.
 */
import { barsAfterEntryBucket, computeReanchor, excursionR } from '../lib/auto-trade/quant/reanchor';
import { chgOpenBucket } from '../lib/auto-trade/quant/shadow-report';
import { rankSectorsByActivity } from '../lib/trade-suggest/sector-rank';
import type { StoredFyersBar } from '../lib/fyers/candle-store';

export type CheckFn = (name: string, ok: boolean, detail?: string) => void;

const bar = (bucketTs: number, high: number, low: number): StoredFyersBar => ({
  bucketTs,
  open: (high + low) / 2,
  high,
  low,
  close: (high + low) / 2,
  volume: 0,
  oi: 0,
});

/** All pure quant-shadow assertions. `check` is supplied by the caller so this
 *  works with both the bench harness and the standalone CI runner. */
export function runQuantShadowChecks(check: CheckFn): void {
  // ── Re-anchor at placement (doc §7/§14) ────────────────────────────────────
  // Synthetic completed bars; the last completed candle (bucketTs 900) drives
  // the rebuilt stop, and bucketTs 1000+ (NOW) is excluded as "still forming".
  const NOW = 1000;
  const upBars = [bar(700, 104, 96), bar(800, 106, 97), bar(900, 108, 95), bar(NOW, 90, 80)]; // last completed low 95
  const rFresh = computeReanchor({
    side: 'CE',
    direction: 'bullish',
    plannedSlSpot: 90,
    plannedTargetSpot: 120,
    freshSpot: 100,
    bars: upBars,
    nowBucketTs: NOW,
  });
  check('reanchor: bullish fresh entry ≈ 2R', Math.abs((rFresh.forwardRR ?? 0) - 2) < 1e-9, `forwardRR ${rFresh.forwardRR}`);
  check('reanchor: rebuilt stop uses last COMPLETED candle low, not the forming bar', rFresh.freshSlSpot === 95);
  const rLate = computeReanchor({ side: 'CE', direction: 'bullish', plannedSlSpot: 90, plannedTargetSpot: 120, freshSpot: 108, bars: upBars, nowBucketTs: NOW });
  check('reanchor: late bullish entry reduces forward R:R', (rLate.forwardRR ?? 9) < 1, `forwardRR ${rLate.forwardRR}`);
  const rPast = computeReanchor({ side: 'CE', direction: 'bullish', plannedSlSpot: 90, plannedTargetSpot: 120, freshSpot: 121, bars: upBars, nowBucketTs: NOW });
  check('reanchor: entry beyond target → forward R:R ≤ 0', (rPast.forwardRR ?? 9) <= 0, `forwardRR ${rPast.forwardRR}`);
  const rStop = computeReanchor({ side: 'CE', direction: 'bullish', plannedSlSpot: 90, plannedTargetSpot: 120, freshSpot: 89, bars: upBars, nowBucketTs: NOW });
  check('reanchor: entry through stop → forward R:R null', rStop.forwardRR === null);
  const downBars = [bar(700, 104, 96), bar(800, 103, 94), bar(900, 105, 92), bar(NOW, 120, 110)];
  const rBear = computeReanchor({ side: 'PE', direction: 'bearish', plannedSlSpot: 110, plannedTargetSpot: 80, freshSpot: 100, bars: downBars, nowBucketTs: NOW });
  check('reanchor: bearish fresh entry ≈ 2R', Math.abs((rBear.forwardRR ?? 0) - 2) < 1e-9, `forwardRR ${rBear.forwardRR}`);

  // ── excursionR: candle high/low against an IMMUTABLE risk passed by caller ──
  const exBull = excursionR('bullish', 100, 2, [bar(1, 105, 99), bar(2, 108, 101)]); // maxHigh 108, minLow 99
  check('excursion: bullish MFE from high, MAE from low', exBull.mfeR === 4 && exBull.maeR === -0.5, `mfe ${exBull.mfeR} mae ${exBull.maeR}`);
  const exWide = excursionR('bullish', 100, 4, [bar(1, 105, 99), bar(2, 108, 101)]);
  check('excursion: denominator is the passed initial risk, not a live stop', exWide.mfeR === 2 && exWide.maeR === -0.25);
  const exBear = excursionR('bearish', 100, 2, [bar(1, 101, 92), bar(2, 103, 95)]); // favorable = minLow 92
  check('excursion: bearish MFE from low, MAE from high', exBear.mfeR === 4 && exBear.maeR === -1.5, `mfe ${exBear.mfeR} mae ${exBear.maeR}`);
  check('excursion: zero risk → null (no divide-by-zero)', excursionR('bullish', 100, 0, [bar(1, 110, 90)]).mfeR === null);

  // ── Finding 2: MFE/MAE must measure from the OBSERVED fill, not scanner plan.
  // Reviewer's example — scanner entry 100 / stop 90 (plan risk 10); the fill
  // actually confirmed at spot 108; post-fill high 110. Scanner-baseline would
  // report a fake +1R; the observed baseline (risk |108−90|=18) reports ~0.11R.
  const postFill = [bar(1, 110, 107)]; // post-entry candle: high 110, low 107
  const buggyScanner = excursionR('bullish', 100, 10, postFill); // OLD (wrong) baseline
  const observed = excursionR('bullish', 108, Math.abs(108 - 90), postFill); // NEW (correct) baseline
  check('finding2: scanner-baseline over-reports post-entry MFE (the bug)', buggyScanner.mfeR === 1);
  check('finding2: observed-baseline MFE ≈ 0.11R, not 1R', observed.mfeR === 0.11, `mfe ${observed.mfeR}`);
  check('finding2: observed-baseline MAE from the post-entry low', observed.maeR === Math.round(((107 - 108) / 18) * 100) / 100, `mae ${observed.maeR}`);

  // ── Finding 3: the ENTRY 5-min candle is excluded (its extreme may predate
  // the fill). Entry bucket ts 0 spiked to 110 BEFORE the fill; the only real
  // post-entry candle (ts 300) topped at 106. Excluding the entry candle must
  // drop the fake 110 and cap MFE at 106.
  const entryBucketTs = 0;
  const withEntry = [bar(entryBucketTs, 110, 100), bar(300, 106, 103)];
  const kept = barsAfterEntryBucket(withEntry, entryBucketTs);
  check('finding3: entry candle excluded (only bars strictly after it remain)', kept.length === 1 && kept[0].bucketTs === 300);
  const contaminated = excursionR('bullish', 104, 2, withEntry); // includes the pre-fill 110
  const cleaned = excursionR('bullish', 104, 2, kept); // excludes it
  check('finding3: excluding the entry candle removes the pre-fill high', contaminated.mfeR === 3 && cleaned.mfeR === 1, `contam ${contaminated.mfeR} clean ${cleaned.mfeR}`);
  check('finding3: barsAfterEntryBucket on empty tail → no excursion', excursionR('bullish', 104, 2, barsAfterEntryBucket([bar(0, 110, 100)], 0)).mfeR === null);

  // ── Finding 6: null/invalid change-from-open is its OWN bucket, never "small".
  check("finding6: null chgOpen → 'missing' (not folded into <1.5%)", chgOpenBucket(null) === 'missing');
  check("finding6: NaN chgOpen → 'missing'", chgOpenBucket(Number.NaN) === 'missing');
  check("finding6: 0% → 'small'", chgOpenBucket(0) === 'small');
  check("finding6: 0.9% → 'small'", chgOpenBucket(0.9) === 'small');
  check("finding6: 2% → 'mid'", chgOpenBucket(2) === 'mid');
  check("finding6: −4% → 'extended' (magnitude, signed direction ignored)", chgOpenBucket(-4) === 'extended');

  // ── Sector rank: OI-spurt RATE, not raw count ──────────────────────────────
  const sr = rankSectorsByActivity([
    { sector: 'BIG', names: 20, avgChgPct: 0.1, oiSpurts: 3 }, // rate 0.15
    { sector: 'SMALL', names: 4, avgChgPct: 0.1, oiSpurts: 3 }, // rate 0.75
  ]);
  check('sector-rank: ranks by OI-spurt RATE, not raw count', sr.get('SMALL')?.rank === 1 && sr.get('BIG')?.rank === 2);
}
