import { NextResponse } from 'next/server';
import { adminOnly } from '@/lib/auth/server';
import { getAutoTradeDates, getTradesByDate } from '@/lib/auto-trade/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/auto-trade/history — EOD auto-trade history, same shape as the other
 * EOD pages (live/urgency-history):
 *   ?dates=true        → { dates: [...] } distinct trade dates, newest first
 *   ?date=YYYY-MM-DD   → { date, trades, summary } that day's trades + rollup
 * Read-only, admin-only. No broker/AI calls.
 */
export async function GET(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const url = new URL(req.url);

    if (url.searchParams.get('dates') === 'true') {
      const dates = await getAutoTradeDates();
      return NextResponse.json({ success: true, dates });
    }

    const date = url.searchParams.get('date');
    if (!date) return NextResponse.json({ success: false, error: 'date or dates=true required' }, { status: 400 });

    const trades = await getTradesByDate(date);
    // Only closed trades carry realized P&L; open/pending show in the log but
    // are excluded from the day's win-rate and P&L maths.
    const closed = trades.filter((t) => t.status === 'closed');
    const wins = closed.filter((t) => (t.realizedPnlRupees ?? 0) > 0).length;
    const losses = closed.filter((t) => (t.realizedPnlRupees ?? 0) < 0).length;
    const pnl = closed.reduce((s, t) => s + (t.realizedPnlRupees ?? 0), 0);

    return NextResponse.json({
      success: true,
      date,
      trades,
      summary: {
        trades: closed.length,
        wins,
        losses,
        flat: closed.length - wins - losses,
        pnl,
        winRatePct: closed.length > 0 ? Math.round((wins / closed.length) * 1000) / 10 : null,
        avgPnl: closed.length > 0 ? Math.round(pnl / closed.length) : 0,
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
