import sectorMapJson from '@/lib/data/fno_sectors.json';
import { prisma } from '@/lib/db';

/**
 * Sector classification for the F&O universe — the single source of truth for
 * every sector-aware page (heatmap, sector-leaders, cross-check).
 *
 * Source of truth is the `fno_stocks` DB table, seeded from
 * lib/data/fno_sectors.json by scripts/seed-fno-stocks.mjs. We read the table so
 * what the heatmap renders is exactly what's stored; the bundled JSON is only a
 * fallback for a not-yet-seeded DB, so a fresh clone never hard-fails. Index
 * rows (isIndex) are excluded — the heatmap/sector pages are stock-only.
 *
 * If you edit fno_sectors.json, re-run `node scripts/seed-fno-stocks.mjs` to
 * push the change into the DB; /api/heatmap/cross-check's composition check
 * reports any JSON↔DB drift so a forgotten re-seed can't go unnoticed.
 */
export async function loadSectorMap(): Promise<Record<string, string>> {
  try {
    const rows = await prisma.fnoStock.findMany({
      where: { isIndex: false },
      select: { symbol: true, sector: true },
    });
    if (rows.length > 0) {
      const map: Record<string, string> = {};
      for (const r of rows) map[r.symbol] = r.sector;
      return map;
    }
  } catch {
    // fno_stocks table missing or DB unavailable — fall back to the seed file.
  }
  return sectorMapJson as Record<string, string>;
}
