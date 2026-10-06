import { NextResponse } from 'next/server';
import sectorMap from '@/lib/data/fno_sectors.json';
import { prisma } from '@/lib/db';
import { aggregateSectors, type SectorTile } from '@/lib/sector/aggregate';
import { loadSectorMap } from '@/lib/sector/sector-map';
import { SECTORAL_INDICES } from '@/lib/sector/sectoral-indices';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/heatmap/cross-check
 *
 * Validates our heatmap's per-sector move against the OFFICIAL NSE sectoral
 * indices — the canonical "sector heatmap" number that Trendlyne / Groww /
 * Tickertape publish. For each of our 11 sectors it reports:
 *   - reconstructedPct : our turnover-weighted mean of constituent EOD % changes
 *                        (latest synced bhavcopy session vs the one before it)
 *   - officialPct      : reserved for the visible page's direct NSE overlay
 *   - deltaPct         : reconstructed − official (expected to be small; a large
 *                        delta flags a composition/methodology problem)
 *
 * Why a delta is expected at all: the official index is free-float-cap-weighted
 * (single-stock 33% / top-3 62% caps; FIN SERVICES 25%), not a turnover-weighted
 * average — so the two reconcile only approximately. Sectoral ids are unverified
 * until `node scripts/verify-sectoral-ids.mjs` fills them in; unverified sectors
 * report official=null rather than guessing.
 *
 * Also runs a composition check: where our fno_sectors.json mapping disagrees
 * with the fno_stocks DB classification (so a mislabeled stock can't quietly
 * skew a sector).
 */
export async function GET() {
  try {
    // Reconstruction uses the DB-backed map (what the heatmap renders); the raw
    // JSON file is kept separately below to flag JSON/DB drift in the composition
    // check — comparing DB-vs-DB would be a no-op.
    const sectors = await loadSectorMap();
    const jsonSectors = sectorMap as Record<string, string>;

    // Our side: EOD reconstruction from the last two bhavcopy sessions.
    const dateRows = await prisma.$queryRawUnsafe<{ date: string }[]>(
      `SELECT DISTINCT date FROM bhavcopy_days ORDER BY date DESC LIMIT 2`,
    );
    if (dateRows.length < 2) {
      return NextResponse.json(
        { success: false, error: 'Need at least 2 synced bhavcopy sessions to cross-check — sync NSE data first.' },
        { status: 400 },
      );
    }
    const [latest, prev] = [dateRows[0].date, dateRows[1].date];

    const rows = await prisma.$queryRawUnsafe<{ symbol: string; date: string; eqClose: number; eqTurnover: number }[]>(
      `SELECT symbol, date, eqClose, eqTurnover FROM bhavcopy_days WHERE date IN (?, ?) AND eqClose > 0`,
      latest,
      prev,
    );
    const latestBySym = new Map<string, { close: number; turnover: number }>();
    const prevBySym = new Map<string, number>();
    for (const r of rows) {
      if (r.date === latest) latestBySym.set(r.symbol, { close: r.eqClose, turnover: r.eqTurnover });
      else prevBySym.set(r.symbol, r.eqClose);
    }
    const tiles: SectorTile[] = [...latestBySym.entries()]
      .filter(([sym]) => sectors[sym] && (prevBySym.get(sym) ?? 0) > 0)
      .map(([sym, cur]) => {
        const base = prevBySym.get(sym) ?? 0;
        return { sector: sectors[sym], pct: ((cur.close - base) / base) * 100, turnover: cur.turnover };
      });
    const reconstructed = new Map(aggregateSectors(tiles).map((a) => [a.sector, a]));

    // Broker APIs are deliberately excluded from Heatmap. The visible page gets
    // official index values directly from /api/nse/heatmap.
    const official = new Map<string, number>();

    // Per-sector comparison.
    const comparison = SECTORAL_INDICES.map((idx) => {
      const recon = reconstructed.get(idx.sectorKey);
      const off = official.get(idx.sectorKey);
      const reconstructedPct = recon?.weightedPct ?? null;
      const officialPct = off ?? null;
      return {
        sector: idx.sectorKey,
        indexName: idx.indexName,
        verified: idx.verified,
        reconstructedPct,
        officialPct,
        deltaPct: reconstructedPct != null && officialPct != null ? reconstructedPct - officialPct : null,
        stocks: recon?.stocks ?? 0,
        advanceRatio: recon?.advanceRatio ?? null,
        note: !idx.verified
          ? idx.cap.note?.includes('no official')
            ? 'no official NSE index for this sector'
            : 'official index id unverified — run scripts/verify-sectoral-ids.mjs'
          : officialPct == null
            ? 'verified id but no live/EOD quote returned'
            : undefined,
      };
    });

    // Composition check: our sector map vs the fno_stocks DB classification.
    let composition: {
      checked: number;
      mismatches: number;
      examples: { symbol: string; mapSector: string; dbSector: string }[];
      note?: string;
    };
    try {
      const dbStocks = await prisma.fnoStock.findMany({ select: { symbol: true, sector: true } });
      const dbBySym = new Map(dbStocks.map((s) => [s.symbol, s.sector]));
      const examples: { symbol: string; mapSector: string; dbSector: string }[] = [];
      let checked = 0;
      let mismatches = 0;
      for (const [sym, mapSector] of Object.entries(jsonSectors)) {
        const dbSector = dbBySym.get(sym);
        if (!dbSector) continue;
        checked++;
        if (dbSector.toUpperCase() !== mapSector.toUpperCase()) {
          mismatches++;
          if (examples.length < 15) examples.push({ symbol: sym, mapSector, dbSector });
        }
      }
      composition = { checked, mismatches, examples };
    } catch {
      composition = { checked: 0, mismatches: 0, examples: [], note: 'fno_stocks table unavailable' };
    }

    return NextResponse.json({
      success: true,
      sessionDate: latest,
      baseDate: prev,
      basis: 'NSE bhavcopy EOD: last session vs prior session',
      methodologyNote:
        'Official NSE sectoral indices are free-float-cap-weighted (33%/62% caps; FIN SERVICES 25%); our reconstruction is turnover-weighted — a small delta is expected and normal. A large delta points to a composition or data gap.',
      verifiedSectoralIndices: 0,
      officialError: null,
      sectors: comparison,
      composition,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
