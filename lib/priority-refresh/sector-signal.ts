/**
 * Pure sector qualification + promotion logic (see plan §7–§11). No I/O.
 *
 * The background producer (a later PR) turns the existing sector aggregation
 * (lib/sector/aggregate.ts) into ActiveSectorSignal snapshots and stores them.
 * These pure functions then (a) pick the top active sectors per side by
 * turnover and (b) promote feed candidates that AGREE with a selected sector —
 * never adding a stock that isn't already in one of the five feeds.
 */
import type { ActiveSectorSignal } from './types';

/** A feed candidate considered for sector promotion — carries only the PRICE
 *  direction (never OI change), so nse-oi-only names arrive with null and are
 *  not promotable on direction. */
export interface SectorPromotionCandidate {
  symbol: string;
  sector: string;
  priceDirectionPct: number | null;
}

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
  // Unknown breadth fails CLOSED (PR#9 review): missing sector evidence must
  // fall back to ordinary round-robin, never qualify on the % move alone.
  if (ar === null) return null;
  if (s.weightedPct >= bullPct && ar >= bullAdvance) return 'bullish';
  if (s.weightedPct <= bearPct && ar <= bearAdvance) return 'bearish';
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
  // Age must be finite, NON-NEGATIVE (a future timestamp from a bad clock is not
  // "fresh"), and within maxAgeSec — fail-closed on anything else (PR#11 re-review B3).
  const fresh = snapshots.filter((s) => {
    const ageSec = (nowMs - s.asOfMs) / 1000;
    return Number.isFinite(ageSec) && ageSec >= 0 && ageSec <= maxAgeSec;
  });
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
 * PRICE direction (priceDirectionPct null — e.g. present only on nse-oi) is
 * skipped; it can still arrive via ordinary round-robin.
 */
export function selectSectorPromotions(input: {
  remainingFeedCandidates: SectorPromotionCandidate[];
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
    const move = pick.priceDirectionPct;
    if (move === null) continue; // unknown price direction → never sector-promote
    if ((dir === 'bullish' && move > 0) || (dir === 'bearish' && move < 0)) {
      seen.add(pick.symbol);
      out.push(pick.symbol);
    }
  }
  return out;
}
