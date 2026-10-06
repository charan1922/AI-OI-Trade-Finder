import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { aggregateSectors } from '@/lib/sector/aggregate';
import { loadSectorMap } from '@/lib/sector/sector-map';

export const dynamic = 'force-dynamic';

/** NSE EOD heatmap. This endpoint intentionally makes no broker API calls. */
export interface HeatTile {
  symbol: string;
  sector: string;
  pct: number;
  intradayPct: number;
  turnover: number;
  price: number;
  previousClose: number;
}

export async function GET() {
  try {
    const sectors = await loadSectorMap();
    const dateRows = await prisma.$queryRawUnsafe<{ date: string }[]>(
      `SELECT DISTINCT date FROM bhavcopy_days ORDER BY date DESC LIMIT 2`,
    );
    if (dateRows.length < 2) {
      return NextResponse.json(
        { success: false, error: 'Need at least 2 synced NSE bhavcopy sessions — sync NSE data in Data Downloader first.' },
        { status: 400 },
      );
    }
    const [latest, previous] = [dateRows[0].date, dateRows[1].date];
    const rows = await prisma.$queryRawUnsafe<
      { symbol: string; date: string; eqOpen: number; eqClose: number; eqTurnover: number }[]
    >(
      `SELECT symbol, date, eqOpen, eqClose, eqTurnover FROM bhavcopy_days
       WHERE date IN (?, ?) AND eqClose > 0`,
      latest,
      previous,
    );
    const latestBySymbol = new Map<string, { open: number; close: number; turnover: number }>();
    const previousBySymbol = new Map<string, number>();
    for (const row of rows) {
      if (row.date === latest) latestBySymbol.set(row.symbol, { open: row.eqOpen, close: row.eqClose, turnover: row.eqTurnover });
      else previousBySymbol.set(row.symbol, row.eqClose);
    }
    const tiles: HeatTile[] = [...latestBySymbol.entries()]
      .filter(([symbol]) => sectors[symbol] && (previousBySymbol.get(symbol) ?? 0) > 0)
      .map(([symbol, current]) => {
        const previousClose = previousBySymbol.get(symbol)!;
        const pct = ((current.close - previousClose) / previousClose) * 100;
        return {
          symbol,
          sector: sectors[symbol],
          pct,
          intradayPct: current.open > 0 ? ((current.close - current.open) / current.open) * 100 : pct,
          turnover: current.turnover,
          price: current.close,
          previousClose,
        };
      });

    return NextResponse.json({
      success: true,
      source: 'eod',
      marketOpen: false,
      asOf: `${latest}T15:30:00+05:30`,
      sessionDate: latest,
      baseDate: previous,
      tiles,
      sectors: aggregateSectors(tiles),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
