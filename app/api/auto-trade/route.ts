import { NextResponse } from 'next/server';
import { todayIST } from '@/lib/dhan/market-feed';
import { isAutoTradeLiveEnabled } from '@/lib/env';
import { adminOnly } from '@/lib/auth/server';
import { istMinuteLabel, isEntryWindow, nowISTClock } from '@/lib/auto-trade/config';
import { getCachedBrokerPnl, type BrokerPnlSnapshot } from '@/lib/auto-trade/broker-pnl-cache';
import { getGuardLoopStatus } from '@/lib/auto-trade/guard-loop';
import { getFyersPnlStreamStatus } from '@/lib/auto-trade/fyers-pnl-stream';
import { getRiskLatch } from '@/lib/auto-trade/risk/latch';
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
    // Venue P&L for the OPERATOR (TTL-cached + coalesced, so a polling console
    // costs one broker call). Read-only cross-check on our own book — never a
    // gate, because the venue counts manual orders too. Never fails the request.
    //
    // TODAY ONLY. The venue reports its CURRENT session, so pairing it with a
    // historical `?date=` would compare today's broker figure against an older
    // day's book and render a delta that means nothing.
    //
    // Rides INSIDE the Promise.all — awaiting it afterwards would add a whole
    // broker round trip to every console poll for no reason.
    const brokerPnlPromise: Promise<BrokerPnlSnapshot> =
      date === todayIST()
        ? getCachedBrokerPnl().catch((err) => ({
            read: { kind: 'unavailable' as const, reason: (err as Error).message },
            checkedAt: new Date().toISOString(),
          }))
        : Promise.resolve({
            read: { kind: 'unavailable' as const, reason: 'venue reports the current session only' },
            checkedAt: new Date().toISOString(),
          });
    const [trades, pending, decisions, entriesToday, exposure, pnl, commentaryCutoffMin, riskLatch, brokerPnl] =
      await Promise.all([
        getTradesByDate(date),
        getPendingApprovals(date),
        getDecisions(date, 30),
        countEntriesToday(date),
        getExposure(date),
        dailyRealizedPnl(date),
        getNumberSetting('COMMENTARY_ENTRY_CUTOFF_MIN', COMMENTARY_ENTRY_CUTOFF_MIN_DEFAULT).catch(
          () => COMMENTARY_ENTRY_CUTOFF_MIN_DEFAULT
        ),
        getRiskLatch(),
        brokerPnlPromise,
      ]);
    const effectiveEntryEndMin = Math.min(settings.entryEndMin, commentaryCutoffMin - 1, settings.squareOffMin - 1);
    // Attach each trade's broker orders so the console can show why an entry
    // failed / where it stands (broker order id, status, fill, error).
    const pnlStream = getFyersPnlStreamStatus();
    const livePnlByTrade = new Map(pnlStream.trades.map((trade) => [trade.tradeId, trade]));
    const tradesWithOrders = await Promise.all(
      trades.map(async (t) => ({
        ...t,
        livePnl: livePnlByTrade.get(t.id) ?? null,
        orders: await getOrdersForTrade(t.id),
      }))
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
        /** The VENUE's own figures, for comparison against ours above. A
         *  non-zero delta is a prompt to look, not proof of a bug — a manual
         *  order on the same account lands here too. */
        broker:
          brokerPnl.read.kind === 'verified'
            ? {
                available: true as const,
                realizedPnlRupees: brokerPnl.read.realized,
                unrealizedPnlRupees: brokerPnl.read.unrealized,
                deltaRupees: Math.round((brokerPnl.read.realized - pnl) * 100) / 100,
                checkedAt: brokerPnl.checkedAt,
              }
            : { available: false as const, reason: brokerPnl.read.reason, checkedAt: brokerPnl.checkedAt },
      },
      trades: tradesWithOrders,
      pending,
      decisions,
      riskLatch,
      guardLoop: getGuardLoopStatus(),
      pnlStream,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
