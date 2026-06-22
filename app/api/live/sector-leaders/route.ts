import { NextResponse } from 'next/server';
import type { SectorBasis, SectorPick } from '@/app/live/_lib/types';
import sectorMap from '@/lib/data/fno_sectors.json';
import { prisma } from '@/lib/db';
import { loadFnoUniverse } from '../_lib/fno-universe';

export const dynamic = 'force-dynamic';

/**
 * GET /api/live/sector-leaders?basis=gainers|losers|movers&perSector=2
 *
 * Builds a DYNAMIC watchlist for the Live Urgency page: the top-performing
 * stocks of each sector, computed from the synced NSE bhavcopy (no external
 * calls). "Performance" = % change in close over the last 5 sessions.
 *
 * Quality gates before ranking:
 *  - avg futures turnover over the last 20 sessions ≥ ₹100 Cr/day (the spread /
 *    imbalance signals are meaningless on illiquid names), and
 *  - a live (non-expired) stock future exists in master_contracts, so the
 *    OI-level column on the live page can actually resolve.
 *
 * Total is capped at 25 — the live quote API's watchlist limit.
 */

const RETURN_SESSIONS = 5;
const TURNOVER_SESSIONS = 20;
const MIN_FUT_TURNOVER = 100e7; // ₹100 Cr/day
const MAX_SYMBOLS = 25;

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const basisRaw = url.searchParams.get('basis');
    const basis: SectorBasis = basisRaw === 'losers' || basisRaw === 'movers' ? basisRaw : 'gainers';
    const perSector = Math.min(4, Math.max(1, Number(url.searchParams.get('perSector')) || 2));

    // Last N+1 session dates (need a close BEFORE the window start for the return).
    const dateRows = await prisma.$queryRawUnsafe<{ date: string }[]>(
      `SELECT DISTINCT date FROM bhavcopy_days ORDER BY date DESC LIMIT ?`,
      Math.max(RETURN_SESSIONS + 1, TURNOVER_SESSIONS),
    );
    const dates = dateRows.map((r) => r.date).sort(); // oldest first
    if (dates.length < RETURN_SESSIONS + 1) {
      return NextResponse.json(
        { success: false, error: `Only ${dates.length} bhavcopy sessions synced — need at least ${RETURN_SESSIONS + 1}. Sync NSE data first.` },
        { status: 400 },
      );
    }
    const windowStart = dates[dates.length - 1 - RETURN_SESSIONS];
    const latest = dates[dates.length - 1];

    const rows = await prisma.$queryRawUnsafe<
      { symbol: string; date: string; eqClose: number; futTurnover: number }[]
    >(
      `SELECT symbol, date, eqClose, futTurnover FROM bhavcopy_days
       WHERE date >= ? AND eqClose > 0
       ORDER BY symbol, date`,
      dates[0],
    );

    // Live stock futures — symbols whose OI column can resolve on the live page.
    const futRows = await prisma.$queryRawUnsafe<{ underlying: string }[]>(
      `SELECT DISTINCT underlying FROM master_contracts
       WHERE instrument = 'FUTSTK' AND segment = 'NSE_FNO' AND expiryDate >= date('now')`,
    );
    const hasLiveFuture = new Set(futRows.map((r) => r.underlying));

    // Live Urgency never shows the 'avoid' lot-size band — drop those names here
    // so the auto-picked chips match what the live table will actually render.
    const fnoUniverse = await loadFnoUniverse();
    let excludedAvoid = 0;

    const bySymbol = new Map<string, { date: string; eqClose: number; futTurnover: number }[]>();
    for (const r of rows) {
      const list = bySymbol.get(r.symbol);
      if (list) list.push(r);
      else bySymbol.set(r.symbol, [r]);
    }

    const sectors = sectorMap as Record<string, string>;
    const candidates: SectorPick[] = [];
    for (const [symbol, days] of bySymbol) {
      if (!hasLiveFuture.has(symbol)) continue;
      if (fnoUniverse.get(symbol)?.tradeBand === 'avoid') {
        excludedAvoid++;
        continue; // 'avoid' band — low-premium options, wide spreads
      }
      const sector = sectors[symbol];
      if (!sector) continue; // not in the F&O sector map — skip rather than guess

      const start = days.find((d) => d.date === windowStart);
      const end = days[days.length - 1];
      if (!start || end.date !== latest || start.eqClose <= 0) continue; // gappy data — skip

      const turns = days.map((d) => d.futTurnover).filter((v) => v > 0);
      if (turns.length < 10) continue;
      const avgTurn = turns.reduce((a, b) => a + b, 0) / turns.length;
      if (avgTurn < MIN_FUT_TURNOVER) continue;

      candidates.push({
        symbol,
        sector,
        retPct: ((end.eqClose - start.eqClose) / start.eqClose) * 100,
        avgFutTurnoverCr: avgTurn / 1e7,
      });
    }

    // Rank within each sector by the chosen basis, take the top N of each.
    const score = (p: SectorPick) => (basis === 'gainers' ? p.retPct : basis === 'losers' ? -p.retPct : Math.abs(p.retPct));
    const bySector = new Map<string, SectorPick[]>();
    for (const c of candidates) {
      const g = bySector.get(c.sector);
      if (g) g.push(c);
      else bySector.set(c.sector, [c]);
    }
    let picks: SectorPick[] = [];
    for (const group of bySector.values()) {
      group.sort((a, b) => score(b) - score(a));
      picks.push(...group.slice(0, perSector));
    }
    // Cap at the live page's watchlist limit, keeping the strongest overall.
    picks.sort((a, b) => score(b) - score(a));
    picks = picks.slice(0, MAX_SYMBOLS);
    // Present grouped by sector, strongest sector-leader first within each.
    picks.sort((a, b) => (a.sector === b.sector ? score(b) - score(a) : a.sector.localeCompare(b.sector)));

    return NextResponse.json({
      success: true,
      picks,
      meta: {
        basis,
        perSector,
        returnWindow: { from: windowStart, to: latest, sessions: RETURN_SESSIONS },
        liquidityFloorCr: MIN_FUT_TURNOVER / 1e7,
        sectorsCovered: new Set(picks.map((p) => p.sector)).size,
        candidates: candidates.length,
        excludedAvoid,
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
