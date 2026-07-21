/**
 * Turns the scanner's existing sector aggregation (lib/sector/aggregate.ts —
 * turnover-weighted move + advance/decline breadth, computed from quotes the
 * scan already had) into qualified ActiveSectorSignal snapshots. NO new Dhan
 * calls, NO critical-path work: the poller stores this after the scan/AI have
 * already been released, and the NEXT cycle's shadow plan reads it (plan §12-13).
 *
 * `buildActiveSectorSignals` is pure — unit-tested in scripts/priority-refresh-checks.ts.
 *
 * SCOPE CAVEAT (PR#11 review B9): the aggregates come from the SCAN's candidate
 * pool (the mover feeds), NOT the full F&O heatmap. So this is "candidate-pool
 * sector activity" — a first-cut shadow signal with selection bias (sectors with
 * more mover-list representation look more active, and the same feeds pick both
 * the stocks and the sectors). A full-universe sector snapshot is deferred to the
 * sector-live PR; until then treat these as directional-only evidence.
 */
import type { SectorAggregate } from '@/lib/sector/aggregate';
import { fyersBucketFor } from '@/lib/fyers/bucket';
import { PRIORITY_HIGH_TURNOVER_SECTORS } from './config';
import { qualifySectorDirection } from './sector-signal';
import type { ActiveSectorSignal } from './types';

/**
 * PURE. Rank sectors by total turnover (rank 1 = highest), keep only the
 * high-turnover group, and among those emit a signal for each that qualifies as
 * convincingly bullish or bearish (qualifySectorDirection). Sectors that don't
 * qualify are simply omitted — the selector later picks top-per-side by turnover.
 */
export function buildActiveSectorSignals(
  aggregates: SectorAggregate[],
  nowMs: number,
  opts: { topTurnover?: number } = {}
): ActiveSectorSignal[] {
  const topTurnover = opts.topTurnover ?? PRIORITY_HIGH_TURNOVER_SECTORS;
  const ranked = [...aggregates].sort((a, b) => b.totalTurnover - a.totalTurnover);
  const signals: ActiveSectorSignal[] = [];
  ranked.forEach((agg, i) => {
    const turnoverRank = i + 1;
    if (turnoverRank > topTurnover) return;
    const direction = qualifySectorDirection(agg);
    if (!direction) return;
    signals.push({
      sector: agg.sector,
      direction,
      weightedPct: agg.weightedPct,
      totalTurnover: agg.totalTurnover,
      turnoverRank,
      advanceRatio: agg.advanceRatio,
      stocks: agg.stocks,
      officialNsePct: null,
      asOfMs: nowMs,
    });
  });
  return signals;
}

export interface PreparedSectorSnapshotWrite {
  bucketTs: number;
  asOfMs: number;
  signals: ActiveSectorSignal[];
}

/**
 * Convert scanner output into one store write without inventing freshness.
 * A missing, invalid, or future observation time produces a zero-signal marker
 * for the current cycle. `asOfMs = 0` is an explicit invalid sentinel, not a
 * substitute scan-completion or persistence timestamp.
 */
export function prepareSectorSnapshotWrite(input: {
  aggregates: SectorAggregate[];
  marketDataAsOfMs: number | undefined;
  currentCycleBucketTs: number;
  nowMs: number;
}): PreparedSectorSnapshotWrite {
  const observedAtMs = input.marketDataAsOfMs;
  const validObservation =
    Number.isFinite(observedAtMs) && (observedAtMs as number) > 0 && (observedAtMs as number) <= input.nowMs;

  if (!validObservation) {
    return { bucketTs: input.currentCycleBucketTs, asOfMs: 0, signals: [] };
  }

  return {
    bucketTs: fyersBucketFor(observedAtMs as number),
    asOfMs: observedAtMs as number,
    signals: buildActiveSectorSignals(input.aggregates, observedAtMs as number),
  };
}
