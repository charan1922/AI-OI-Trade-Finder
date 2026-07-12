import { NextResponse } from 'next/server';
import { todayIST } from '@/lib/dhan/market-feed';
import { isAutoTradeLiveEnabled } from '@/lib/env';
import { ENTRY_WINDOW_LABEL, isEntryWindow, nowISTClock } from '@/lib/auto-trade/config';
import { getAutoTradeSettings, SETTING_DEFS } from '@/lib/auto-trade/settings';
import {
  countEntriesToday,
  dailyRealizedPnl,
  getDecisions,
  getExposure,
  getPendingApprovals,
  getTradesByDate,
} from '@/lib/auto-trade/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/auto-trade[?date=YYYY-MM-DD] — the operator console feed: settings,
 * caps + exposure, today's trades, pending approvals, and the decision audit.
 * Read-only; all mutations go through /settings and /action (admin-only).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get('date') ?? todayIST();
    const settings = await getAutoTradeSettings();
    const [trades, pending, decisions, entriesToday, exposure, pnl] = [
      await getTradesByDate(date),
      await getPendingApprovals(date),
      await getDecisions(date, 30),
      await countEntriesToday(date),
      await getExposure(date),
      await dailyRealizedPnl(date),
    ];
    return NextResponse.json({
      success: true,
      date,
      nowIST: nowISTClock(),
      settings,
      settingDefs: SETTING_DEFS.map((d) => ({ key: d.key, label: d.label, description: d.description })),
      liveEnvEnabled: isAutoTradeLiveEnabled(),
      entryWindow: { ...ENTRY_WINDOW_LABEL, active: isEntryWindow() },
      today: {
        entriesUsed: entriesToday,
        openLots: exposure.openLots,
        deployedRupees: exposure.deployedRupees,
        realizedPnlRupees: pnl,
      },
      trades,
      pending,
      decisions,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
