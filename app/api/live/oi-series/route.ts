import { NextResponse } from 'next/server';
import { todayIST } from '@/lib/dhan/market-feed';
import { computeOiUrgency, getIntradaySeries } from '@/lib/signals/oi-intraday';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/live/oi-series?symbol=RELIANCE&date=YYYY-MM-DD
 *
 * Returns the persisted intraday futures-OI series for one symbol on a trading
 * day (captured by /api/live/quote on each live poll) plus the derived urgency
 * summary — backs the OI-build sparkline / detail on the Live Urgency page.
 * `date` defaults to today (IST). Returns an empty series (never fabricated) when
 * nothing was captured for that name/day.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const symbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase();
    if (!symbol) {
      return NextResponse.json({ success: false, error: 'symbol query param is required' }, { status: 400 });
    }
    const date = url.searchParams.get('date')?.trim() || todayIST();

    const series = await getIntradaySeries(symbol, date);
    const urgency = computeOiUrgency(series);

    return NextResponse.json({ success: true, symbol, date, series, urgency });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
