import { NextResponse } from 'next/server';
import { getMarketCalendar } from '@/lib/backtest/trading-calendar';

export const dynamic = 'force-dynamic';

/**
 * GET /api/market-calendar
 *
 * NSE trading-holiday calendar: official CSV list (with occasion names),
 * data-derived closures outside its coverage, and observed special weekend
 * sessions. Backed by the market_holidays table + real candle/bhavcopy data.
 */
export async function GET() {
  try {
    const calendar = await getMarketCalendar();
    return NextResponse.json({ success: true, data: calendar });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
