import { NextResponse } from 'next/server';
import { todayIST } from '@/lib/market-data';
import { OB_ALGORITHM_VERSION, OB_DEFAULT_CONFIG, replayOrderBlocks } from '@/lib/order-blocks/engine';
import { loadObBars, OB_SOURCE } from '@/lib/order-blocks/read';

export const dynamic = 'force-dynamic';

/** "2026-11-19 10:25:00" (IST, as commentary rows store it) or an ISO string → epoch ms. */
function parseAsOf(raw: string | null): number | null {
  if (!raw) return null;
  const iso = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}+05:30`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * GET /api/order-blocks?symbol=TITAN&date=YYYY-MM-DD&asOf=<IST datetime or ISO>
 *
 * Replays OUR order-block rule set (lib/order-blocks/engine.ts) over the
 * recorded 5-min EQ candles of `date`, with the previous recorded session as
 * ATR/pivot warm-up, using ONLY bars completed by `asOf` (default: now). So a
 * past commentary read shows exactly the zones that were knowable at that
 * moment — never one confirmed later. Display only.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const symbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase();
    const date = url.searchParams.get('date') ?? todayIST();
    if (!/^[A-Z0-9&-]{1,30}$/.test(symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ success: false, error: 'symbol and date (YYYY-MM-DD) required' }, { status: 400 });
    }
    const nowMs = Date.now();
    const asOfMs = Math.min(parseAsOf(url.searchParams.get('asOf')) ?? nowMs, nowMs);

    const { bars, skipped } = await loadObBars(symbol, date, asOfMs);
    const state = replayOrderBlocks(symbol, OB_SOURCE, bars, OB_DEFAULT_CONFIG);
    const dayBars = bars.filter((b) => b.date === date);
    const dayStartMs = dayBars[0]?.startMs ?? Number.POSITIVE_INFINITY;

    return NextResponse.json({
      success: true,
      data: {
        symbol,
        date,
        asOf: new Date(asOfMs).toISOString(),
        // Recorded candles lag the market by up to one 5-min bar + one poller cycle.
        label: date === todayIST() ? 'DELAYED' : 'HISTORICAL',
        source: OB_SOURCE,
        algorithmVersion: OB_ALGORITHM_VERSION,
        config: OB_DEFAULT_CONFIG,
        warmupBars: bars.length - dayBars.length,
        skippedBars: skipped,
        atrReady: (state.atr.at(-1) ?? null) !== null,
        bars: dayBars.map((b) => ({ startMs: b.startMs, endMs: b.endMs, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
        // Today's zones only; yesterday's expired at its session end (session policy).
        blocks: state.blocks.filter((b) => b.confirmedAtMs > dayStartMs),
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
