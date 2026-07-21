/**
 * Turns the scanner's existing sector aggregation (lib/sector/aggregate.ts —
 * turnover-weighted move + advance/decline breadth, computed from quotes the
 * scan already had) into qualified ActiveSectorSignal snapshots. NO new Dhan
 * calls, NO critical-path work: the poller stores this after the scan/AI have
 * already been released, and the NEXT cycle's shadow plan reads it (plan §12-13).
 *
 * `buildActiveSectorSignals` is pure — unit-tested in scripts/priority-refresh-checks.ts.
 */
import type { SectorAggregate } from '@/lib/sector/aggregate';
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
