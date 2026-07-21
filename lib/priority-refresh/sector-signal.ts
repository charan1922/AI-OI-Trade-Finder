/**
 * Pure sector qualification + promotion logic (see plan §7–§11). No I/O.
 *
 * The background producer (a later PR) turns the existing sector aggregation
 * (lib/sector/aggregate.ts) into ActiveSectorSignal snapshots and stores them.
 * These pure functions then (a) pick the top active sectors per side by
 * turnover and (b) promote feed candidates that AGREE with a selected sector —
 * never adding a stock that isn't already in one of the five feeds.
 */
import type { ActiveSectorSignal, RankedFeedPick } from './types';

/**
 * Qualify a sector's direction from its aggregate stats (plan §10). Returns
 * null when it is neither convincingly bullish nor bearish — the producer then
 * simply omits it. Pure so the thresholds are unit-tested.
 */
export function qualifySectorDirection(
  s: { weightedPct: number; advanceRatio: number | null },
  opts: { bullPct?: number; bullAdvance?: number; bearPct?: number; bearAdvance?: number } = {}
): 'bullish' | 'bearish' | null {
  const bullPct = opts.bullPct ?? 0.5;
  const bullAdvance = opts.bullAdvance ?? 0.6;
  const bearPct = opts.bearPct ?? -0.5;
  const bearAdvance = opts.bearAdvance ?? 0.4;
  const ar = s.advanceRatio;
  if (s.weightedPct >= bullPct && (ar === null || ar >= bullAdvance)) return 'bullish';
  if (s.weightedPct <= bearPct && (ar === null || ar <= bearAdvance)) return 'bearish';
  return null;
}

/**
 * Select up to `topPerSide` bullish + `topPerSide` bearish sectors from stored
 * snapshots, dropping any older than `maxAgeSec`. Ranked by turnover (rank 1 =
 * highest). Stale/empty input yields empty selections → callers fall back to
 * ordinary round-robin (sector data must never block a cycle).
 */
export function selectActiveSectors(input: {
  snapshots: ActiveSectorSignal[];
  topPerSide: number;
  nowMs: number;
  maxAgeSec: number;
}): { bullish: ActiveSectorSignal[]; bearish: ActiveSectorSignal[] } {
  const { snapshots, topPerSide, nowMs, maxAgeSec } = input;
  if (topPerSide <= 0) return { bullish: [], bearish: [] };
  const fresh = snapshots.filter((s) => (nowMs - s.asOfMs) / 1000 <= maxAgeSec);
  const byTurnover = (a: ActiveSectorSignal, b: ActiveSectorSignal) => a.turnoverRank - b.turnoverRank;
  return {
    bullish: fresh
      .filter((s) => s.direction === 'bullish')
      .sort(byTurnover)
      .slice(0, topPerSide),
    bearish: fresh
      .filter((s) => s.direction === 'bearish')
      .sort(byTurnover)
      .slice(0, topPerSide),
  };
}

/**
 * Promote up to `maxPromotions` feed candidates that agree with a selected
 * active sector (plan §11): the stock is already in a feed, belongs to one of
 * the active sectors, and its own move agrees with the sector's direction.
 * `existingSymbols` (Tier 0 + base Tier 1) are never re-added. Candidates are
 * consumed in the caller's order (best feed rank first). A stock with unknown
 * direction (retPct null) is skipped — it can still arrive via round-robin.
 */
export function selectSectorPromotions(input: {
  remainingFeedCandidates: RankedFeedPick[];
  activeSectors: ActiveSectorSignal[];
  existingSymbols: ReadonlySet<string>;
  maxPromotions: number;
}): string[] {
  const { remainingFeedCandidates, activeSectors, existingSymbols, maxPromotions } = input;
  if (maxPromotions <= 0 || activeSectors.length === 0) return [];
  const dirBySector = new Map(activeSectors.map((s) => [s.sector, s.direction]));
  const out: string[] = [];
  const seen = new Set<string>(existingSymbols);

  for (const pick of remainingFeedCandidates) {
    if (out.length >= maxPromotions) break;
    if (!pick.symbol || seen.has(pick.symbol)) continue;
    const dir = dirBySector.get(pick.sector);
    if (!dir) continue;
    const ret = pick.retPct;
    if (ret === null) continue;
    if ((dir === 'bullish' && ret > 0) || (dir === 'bearish' && ret < 0)) {
      seen.add(pick.symbol);
      out.push(pick.symbol);
    }
  }
  return out;
}
