import { NextResponse } from 'next/server';
import { adminOnly } from '@/lib/auth/server';
import { getAutoTradeSettings } from '@/lib/auto-trade/settings';
import { getGuardLoopStatus } from '@/lib/auto-trade/guard-loop';
import { getDecisions, getOrdersForTrade, getTradesByDate } from '@/lib/auto-trade/store';
import { getDhanTokenStatus } from '@/lib/dhan/auth';
import { isMarketHours, todayIST } from '@/lib/dhan/market-feed';
import { getFyersPollerStatus } from '@/lib/fyers/poller';
import { getFyersTokenStatus } from '@/lib/fyers/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/monitor — a single live snapshot of what the autonomous engine is
 * doing right now: poller + guard health, token status, the day's decision feed
 * (the closest thing to a live activity log), and today's orders/trades. All
 * READ-ONLY — no scan, no broker call, no mutation. Admin-only (defence in depth
 * on top of the proxy). Powers the /monitor page, which polls this every ~5s.
 */
export async function GET(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const date = todayIST();
    const [settings, trades, decisions] = await Promise.all([
      getAutoTradeSettings(),
      getTradesByDate(date),
      getDecisions(date, 40),
    ]);
    // Attach each trade's orders (today's book is tiny — at most a couple trades).
    const tradesWithOrders = await Promise.all(
      trades.map(async (t) => ({ trade: t, orders: await getOrdersForTrade(t.id) })),
    );

    return NextResponse.json({
      success: true,
      now: new Date().toISOString(),
      marketOpen: isMarketHours(),
      settings: {
        mode: settings.mode,
        killSwitch: settings.killSwitch,
        broker: settings.broker,
        aiProvider: settings.aiProvider,
        liveEnvEnabled: process.env.AUTO_TRADE_LIVE_ENABLED === 'true',
      },
      poller: getFyersPollerStatus(),
      guard: getGuardLoopStatus(),
      tokens: { fyers: getFyersTokenStatus(), dhan: getDhanTokenStatus() },
      decisions,
      trades: tradesWithOrders,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
