import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { todayIST } from '@/lib/dhan/market-feed';
import { type Candle, deriveSessionContext, getIntradayCandles } from '@/lib/signals/intraday-candles';
import { fetchAndStoreCandles } from '../_lib/morning-candles';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/live/candles?symbol=RELIANCE[&date=YYYY-MM-DD][&refresh=1]
 *
 * Returns a stock's persisted 5-min intraday candle series — the low-latency,
 * any-time access point for the R-Factor, a chart, or an AI agent / loop engine.
 *
 * Reads are served from the `intraday_candles` store (instant). For TODAY, if the
 * store is empty (or `refresh=1` is passed) it backfills once from Dhan, persists,
 * and serves. Past dates are served from the store only (Dhan intraday is today-
 * scoped). Never fabricates bars — an empty series means we genuinely have none.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const symbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase();
    if (!symbol) {
      return NextResponse.json({ success: false, error: 'symbol is required' }, { status: 400 });
    }
    const date = url.searchParams.get('date') ?? todayIST();
    const refresh = url.searchParams.get('refresh') === '1';
    const isToday = date === todayIST();

    let candles: Candle[] = await getIntradayCandles(symbol, date);

    // Backfill from Dhan only for today, and only when needed (empty or forced) —
    // keeps reads instant by default, fetches just once on a cold symbol.
    if (isToday && (refresh || candles.length === 0)) {
      const eq = await prisma.masterContract.findFirst({
        where: { symbol, segment: 'NSE_EQ' },
        select: { securityId: true },
      });
      if (eq?.securityId) {
        const fetched = await fetchAndStoreCandles(symbol, Number(eq.securityId));
        if (fetched.length > 0) candles = fetched;
      }
    }

    return NextResponse.json({
      success: true,
      symbol,
      date,
      count: candles.length,
      candles,
      sessionContext: deriveSessionContext(candles),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
