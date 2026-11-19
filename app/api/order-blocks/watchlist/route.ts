import { NextResponse } from 'next/server';
import { todayIST } from '@/lib/market-data';
import { loadRetestWatchlist } from '@/lib/order-blocks/retest-store';

export const dynamic = 'force-dynamic';

/** GET /api/order-blocks/watchlist?date=YYYY-MM-DD — the latest retest watch-list the scanner wrote. */
export async function GET(req: Request) {
  try {
    const date = new URL(req.url).searchParams.get('date') ?? todayIST();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ success: false, error: 'date must be YYYY-MM-DD' }, { status: 400 });
    }
    const saved = await loadRetestWatchlist(date);
    return NextResponse.json({
      success: true,
      data: { date, asOf: saved?.asOf ?? null, items: saved?.items ?? [], meta: saved?.meta ?? null },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
