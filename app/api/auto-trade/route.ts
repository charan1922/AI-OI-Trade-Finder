import { NextResponse } from 'next/server';
import { todayIST } from '@/lib/dhan/market-feed';
import { isAutoTradeLiveEnabled } from '@/lib/env';
import { adminOnly } from '@/lib/auth/server';
import { istMinuteLabel, isEntryWindow, nowISTClock } from '@/lib/auto-trade/config';
import { getAutoTradeSettings, SETTING_DEFS } from '@/lib/auto-trade/settings';
import { getNumberSetting } from '@/lib/config/feature-toggles';
import { COMMENTARY_ENTRY_CUTOFF_MIN_DEFAULT } from '@/lib/ai-commentary/generate';
import {
  countEntriesToday,
  dailyRealizedPnl,
  getDecisions,
  getExposure,
  getOrdersForTrade,
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
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const url = new URL(req.url);
    const date = url.searchParams.get('date') ?? todayIST();
    const settings = await getAutoTradeSettings();
    const [trades, pending, decisions, entriesToday, exposure, pnl, commentaryCutoffMin] = await Promise.all([
      getTradesByDate(date),
      getPendingApprovals(date),
      getDecisions(date, 30),
      countEntriesToday(date),
      getExposure(date),
      dailyRealizedPnl(date),
      getNumberSetting('COMMENTARY_ENTRY_CUTOFF_MIN', COMMENTARY_ENTRY_CUTOFF_MIN_DEFAULT).catch(
        () => COMMENTARY_ENTRY_CUTOFF_MIN_DEFAULT
      ),
    ]);
    const effectiveEntryEndMin = Math.min(settings.entryEndMin, commentaryCutoffMin - 1, settings.squareOffMin - 1);
    // Attach each trade's broker orders so the console can show why an entry
    // failed / where it stands (broker order id, status, fill, error).
    const tradesWithOrders = await Promise.all(
      trades.map(async (t) => ({ ...t, orders: await getOrdersForTrade(t.id) }))
    );
    return NextResponse.json({
      success: true,
      date,
      nowIST: nowISTClock(),
      settings,
      settingDefs: SETTING_DEFS.map((d) => ({
        key: d.key,
        label: d.label,
        description: d.description,
      })),
      liveEnvEnabled: isAutoTradeLiveEnabled(),
      entryWindow: {
        opensAt: istMinuteLabel(settings.entryStartMin),
        closesAt: istMinuteLabel(effectiveEntryEndMin),
        active: isEntryWindow(undefined, settings.entryStartMin, effectiveEntryEndMin),
      },
      today: {
        entriesUsed: entriesToday,
        openLots: exposure.openLots,
        deployedRupees: exposure.deployedRupees,
        realizedPnlRupees: pnl,
      },
      trades: tradesWithOrders,
      pending,
      decisions,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
