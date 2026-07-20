/**
 * Sector-activity ranking (SHADOW evidence) — one shared definition used by
 * both the scanner reason (engine.ts) and the auto-trade entry snapshot
 * (tools/execute.ts) so they can never diverge.
 *
 * Ranks by OI-spurt RATE (spurting names ÷ sector size), NOT the raw spurt
 * count: a 20-name sector otherwise out-ranks a 5-name sector purely because it
 * has more chances to produce a spurting name (AT-review 2026-07-20). Ties break
 * on the magnitude of the sector's turnover-weighted move. Pure — no I/O.
 */

export interface SectorFlowLike {
  sector: string;
  names: number;
  avgChgPct: number | null;
  oiSpurts: number;
}

export interface SectorActivityRank {
  rank: number; // 1 = most active
  total: number; // sectors ranked this scan
}

/** Map of sector → {rank, total}, ranked by OI-spurt rate then |move|. */
export function rankSectorsByActivity(flow: readonly SectorFlowLike[]): Map<string, SectorActivityRank> {
  const rate = (f: SectorFlowLike) => (f.names > 0 ? f.oiSpurts / f.names : 0);
  const ranked = [...flow].sort((a, b) => rate(b) - rate(a) || Math.abs(b.avgChgPct ?? 0) - Math.abs(a.avgChgPct ?? 0));
  const total = ranked.length;
  const out = new Map<string, SectorActivityRank>();
  ranked.forEach((f, i) => out.set(f.sector, { rank: i + 1, total }));
  return out;
}
