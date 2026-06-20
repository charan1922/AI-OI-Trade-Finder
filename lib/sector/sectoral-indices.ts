/**
 * Official NSE sectoral-index reference — the canonical "sector change" that
 * Trendlyne / Groww / Tickertape headline, used to CROSS-CHECK our turnover-
 * weighted heatmap aggregate (see /api/heatmap/cross-check).
 *
 * The published NIFTY <SECTOR> change is the index LEVEL vs its own previous
 * close — a free-float-cap-weighted average (single-stock 33% / top-3 62% caps;
 * NIFTY PRIVATE BANK & co. follow the generic rule, NIFTY FINANCIAL SERVICES uses
 * a 25% cap). It is NOT a simple average of constituent % changes, so our
 * reconstruction is expected to differ by a small, explainable delta.
 *
 * Dhan exposes index quotes on the IDX_I segment. Only NIFTY 50 (securityId 13)
 * is VERIFIED in this codebase; every sectoral id below is a PLACEHOLDER (null +
 * verified:false) until confirmed against the Dhan master CSV — run
 * `node scripts/verify-sectoral-ids.mjs` to enumerate the real ids and fill them
 * in. Unverified ids are never used as canonical; the cross-check reports them as
 * "unverified" rather than guessing.
 */

/** Dhan IDX_I security id for the NIFTY 50 benchmark (the one known-good id). */
export const NIFTY50_SEC_ID = 13;

export interface SectoralIndex {
  /** Matches the sector string used in lib/data/fno_sectors.json. */
  sectorKey: string;
  /** Official NSE index display name. */
  indexName: string;
  /** Dhan IDX_I security id — null until verified against the master CSV. */
  dhanSecId: number | null;
  /** True only once the id has been confirmed; gates use as canonical. */
  verified: boolean;
  /** Index capping rule (documentation + future weight reconstruction). */
  cap: { singleStockPct: number; top3Pct?: number; note?: string };
}

/**
 * Map of our 11 heatmap sectors → their official NSE sectoral index. CEMENT has
 * no pure NSE sectoral index (closest is a broad materials/infra basket), so it
 * has no official counterpart and is reported as such.
 */
// dhanSecId values below were enumerated from Dhan's master CSV via
// scripts/verify-sectoral-ids.mjs (NSE IDX_I segment) and confirmed by index
// name, so they are marked verified. CEMENT has no official NSE sectoral index.
export const SECTORAL_INDICES: SectoralIndex[] = [
  { sectorKey: 'IT', indexName: 'NIFTY IT', dhanSecId: 29, verified: true, cap: { singleStockPct: 33, top3Pct: 62 } },
  { sectorKey: 'AUTO', indexName: 'NIFTY AUTO', dhanSecId: 14, verified: true, cap: { singleStockPct: 33, top3Pct: 62 } },
  { sectorKey: 'PHARMA', indexName: 'NIFTY PHARMA', dhanSecId: 32, verified: true, cap: { singleStockPct: 33, top3Pct: 62 } },
  { sectorKey: 'FMCG', indexName: 'NIFTY FMCG', dhanSecId: 28, verified: true, cap: { singleStockPct: 33, top3Pct: 62 } },
  { sectorKey: 'METAL', indexName: 'NIFTY METAL', dhanSecId: 31, verified: true, cap: { singleStockPct: 33, top3Pct: 62 } },
  { sectorKey: 'ENERGY', indexName: 'NIFTY ENERGY', dhanSecId: 42, verified: true, cap: { singleStockPct: 33, top3Pct: 62 } },
  { sectorKey: 'REALTY', indexName: 'NIFTY REALTY', dhanSecId: 34, verified: true, cap: { singleStockPct: 33, top3Pct: 62 } },
  { sectorKey: 'PVT BANK', indexName: 'NIFTY PVT BANK', dhanSecId: 15, verified: true, cap: { singleStockPct: 33, top3Pct: 62 } },
  { sectorKey: 'PSU BANK', indexName: 'NIFTY PSU BANK', dhanSecId: 33, verified: true, cap: { singleStockPct: 33, top3Pct: 62 } },
  {
    // FINNIFTY (securityId 27) IS the Nifty Financial Services index.
    sectorKey: 'FIN SERVICE',
    indexName: 'NIFTY FINANCIAL SERVICES',
    dhanSecId: 27,
    verified: true,
    cap: { singleStockPct: 25, note: 'plus non-F&O 4.5%/10% caps' },
  },
  {
    sectorKey: 'CEMENT',
    indexName: '(no pure NSE cement index)',
    dhanSecId: null,
    verified: false,
    cap: { singleStockPct: 33, top3Pct: 62, note: 'no official counterpart — cross-check unavailable' },
  },
];

/** Sectors whose official index id is confirmed (usable as canonical). */
export function verifiedSectoralIndices(): SectoralIndex[] {
  return SECTORAL_INDICES.filter((s) => s.verified && s.dhanSecId != null);
}

/** Lookup by our sector string. */
export function sectoralIndexFor(sectorKey: string): SectoralIndex | undefined {
  return SECTORAL_INDICES.find((s) => s.sectorKey === sectorKey);
}
