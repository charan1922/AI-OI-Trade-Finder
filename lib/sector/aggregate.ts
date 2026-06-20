/**
 * Sector aggregation for the F&O heatmap.
 *
 * The heatmap colors individual stock tiles; this rolls them up into a per-sector
 * number so the treemap can label each sector band with a real move and breadth —
 * the way NSE/Trendlyne sector heatmaps headline each sector.
 *
 * The canonical NSE "sector change" is the official sectoral INDEX (free-float
 * market-cap weighted, capped). We don't have free-float weights here, so we
 * report a TURNOVER-weighted mean of constituent % changes — the closest proxy
 * from data we already have (money actually traded), and we cross-check it against
 * the official index in /api/heatmap/cross-check. Turnover-weighting is honest
 * about its basis and avoids a thin small-cap dominating a simple average.
 */

/** Minimal tile shape needed for aggregation (subset of the heatmap's HeatTile). */
export interface SectorTile {
  sector: string;
  pct: number;
  turnover: number;
}

export interface SectorAggregate {
  sector: string;
  stocks: number;
  totalTurnover: number;
  /** Turnover-weighted mean of constituent % changes — the sector's headline move. */
  weightedPct: number;
  /** Plain (unweighted) mean — shown alongside so a 1-stock-driven sector is visible. */
  simplePct: number;
  advancers: number;
  decliners: number;
  unchanged: number;
  /** advancers ÷ (advancers + decliners) in [0,1], or null if nothing moved. */
  advanceRatio: number | null;
}

/** Below this |%| a stock counts as unchanged (avoids labeling noise as a move). */
const DEAD_BAND_PCT = 0.05;

/**
 * Roll tiles up by sector. Pure + deterministic. Sectors are returned sorted by
 * total turnover (biggest participation first) to match the treemap's sizing.
 */
export function aggregateSectors(tiles: SectorTile[]): SectorAggregate[] {
  const bySector = new Map<string, SectorTile[]>();
  for (const t of tiles) {
    const g = bySector.get(t.sector);
    if (g) g.push(t);
    else bySector.set(t.sector, [t]);
  }

  const out: SectorAggregate[] = [];
  for (const [sector, group] of bySector) {
    let wSum = 0;
    let wPctSum = 0;
    let pctSum = 0;
    let advancers = 0;
    let decliners = 0;
    let unchanged = 0;
    for (const t of group) {
      const w = t.turnover > 0 ? t.turnover : 0;
      wSum += w;
      wPctSum += w * t.pct;
      pctSum += t.pct;
      if (t.pct > DEAD_BAND_PCT) advancers++;
      else if (t.pct < -DEAD_BAND_PCT) decliners++;
      else unchanged++;
    }
    const moved = advancers + decliners;
    out.push({
      sector,
      stocks: group.length,
      totalTurnover: wSum,
      weightedPct: wSum > 0 ? wPctSum / wSum : pctSum / group.length,
      simplePct: group.length > 0 ? pctSum / group.length : 0,
      advancers,
      decliners,
      unchanged,
      advanceRatio: moved > 0 ? advancers / moved : null,
    });
  }

  return out.sort((a, b) => b.totalTurnover - a.totalTurnover);
}
