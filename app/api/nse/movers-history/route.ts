import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/nse/movers-history — EOD movers reconstructed from NSE bhavcopy.
 *
 *   ?dates=true        → { dates: [...] } the available session dates (desc)
 *   ?date=YYYY-MM-DD   → per-stock close-to-close stats for that session
 *
 * Pure DB read of `bhavcopy_days` (NSE official end-of-day) — no NSE/Dhan calls.
 * For session D vs the prior session: pctChange = (close[D]−close[D−1])/close[D−1];
 * turnover/volume = D's values; oiPct = change in TOTAL derivatives OI
 * (futures + options) vs the prior session — matching NSE's live "OI spurts"
 * metric, which is fut+opt, not futures-only. EOD counterpart to /nse/movers.
 */

interface HistRow {
  symbol: string;
  date: string;
  eqClose: number;
  eqTurnover: number;
  eqVolume: number;
  futOi: number;
  optOi: number;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);

    const dateRows = await prisma.$queryRawUnsafe<{ date: string }[]>(
      `SELECT DISTINCT date FROM bhavcopy_days ORDER BY date DESC`,
    );
    const dates = dateRows.map((r) => r.date);

    if (url.searchParams.get('dates') === 'true') {
      return NextResponse.json({ success: true, dates });
    }
    if (dates.length < 2) {
      return NextResponse.json(
        { success: false, error: 'Need at least 2 synced bhavcopy sessions — sync NSE data first.' },
        { status: 400 },
      );
    }

    const requested = url.searchParams.get('date');
    const date = requested && dates.includes(requested) ? requested : dates[0];
    const prevDate = dates[dates.indexOf(date) + 1]; // dates are DESC → next index is the older session
    if (!prevDate) {
      return NextResponse.json(
        { success: false, error: `No prior session before ${date} to compute change.` },
        { status: 400 },
      );
    }

    const rows = await prisma.$queryRawUnsafe<HistRow[]>(
      `SELECT symbol, date, eqClose, eqTurnover, eqVolume, futOi, optOi
       FROM bhavcopy_days WHERE date IN (?, ?) AND eqClose > 0`,
      date,
      prevDate,
    );

    // Prior session's close + TOTAL derivatives OI (futures + options). NSE's live
    // "OI spurts" feed measures fut+opt OI, so the EOD reconstruction must too —
    // futures-only OI gives a different (wrong-looking) number vs the live page.
    const prevClose = new Map<string, number>();
    const prevTotalOi = new Map<string, number>();
    for (const r of rows) {
      if (r.date === prevDate) {
        prevClose.set(r.symbol, r.eqClose);
        prevTotalOi.set(r.symbol, r.futOi + r.optOi);
      }
    }

    const stocks = [];
    for (const r of rows) {
      if (r.date !== date) continue;
      const pc = prevClose.get(r.symbol);
      if (pc === undefined || pc <= 0) continue; // need both sessions for a real change — never fabricate
      const totalOi = r.futOi + r.optOi;
      const priorOi = prevTotalOi.get(r.symbol) ?? 0;
      stocks.push({
        symbol: r.symbol,
        close: r.eqClose,
        pctChange: ((r.eqClose - pc) / pc) * 100,
        turnover: r.eqTurnover,
        volume: r.eqVolume,
        oiPct: priorOi > 0 ? ((totalOi - priorOi) / priorOi) * 100 : 0,
        hasFno: r.futOi > 0,
      });
    }

    return NextResponse.json({ success: true, date, prevDate, count: stocks.length, stocks });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
