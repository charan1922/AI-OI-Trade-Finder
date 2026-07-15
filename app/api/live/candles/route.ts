import { NextResponse } from 'next/server';
import { todayIST } from '@/lib/dhan/market-feed';
import { getFyersCandles, type StoredFyersBar } from '@/lib/fyers/candle-store';
import { addToUniverse } from '@/lib/fyers/symbols';
import { deriveSessionContext } from '@/lib/signals/session-context';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/live/candles?symbol=RELIANCE[&instrument=EQ|FUT]
 *
 * Returns a stock's 5-min intraday candle series for TODAY — the low-latency,
 * any-time access point for the R-Factor, a chart, or an AI agent / loop engine.
 *
 * Served from the `fyers_candles` store, which the autonomous Fyers poller
 * fills full-day every 5 minutes. The API intentionally returns only today's
 * session even though the store retains the newest 20 recorded sessions for
 * replay. FUT rows carry live open interest per bucket. A symbol not yet
 * tracked is enrolled into the download universe here and its full-day series
 * appears within one 5-min cycle. Never fabricates bars — an empty series
 * means we genuinely have none (yet).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const symbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase();
    if (!symbol) {
      return NextResponse.json({ success: false, error: 'symbol is required' }, { status: 400 });
    }
    const instParam = (url.searchParams.get('instrument') ?? 'EQ').trim().toUpperCase();
    if (instParam !== 'EQ' && instParam !== 'FUT') {
      return NextResponse.json({ success: false, error: "instrument must be 'EQ' or 'FUT'" }, { status: 400 });
    }

    const date = todayIST();
    const candles: StoredFyersBar[] = await getFyersCandles(symbol, date, instParam);

    // Cold symbol → enroll it; the next Fyers cycle backfills its full day.
    if (candles.length === 0) await addToUniverse([symbol], date);

    return NextResponse.json({
      success: true,
      symbol,
      instrument: instParam,
      date,
      count: candles.length,
      candles,
      sessionContext: deriveSessionContext(candles),
      ...(candles.length === 0 && {
        note: 'No bars yet — symbol enrolled in the Fyers download universe; series backfills within one 5-min cycle.',
      }),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
