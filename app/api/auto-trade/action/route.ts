import { NextResponse } from 'next/server';
import { approveTrade, rejectTrade } from '@/lib/auto-trade/approval';
import { runAutoTradePass } from '@/lib/auto-trade/engine';
import { exitTrade } from '@/lib/auto-trade/execution';
import { getTrade, insertDecision } from '@/lib/auto-trade/store';
import { todayIST } from '@/lib/dhan/market-feed';
import { runTradeSuggest } from '@/lib/trade-suggest/engine';
import { adminOnly } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/auto-trade/action — operator actions from the /auto-trade console.
 * body { action: 'approve' | 'reject' | 'exit' | 'run-pass', tradeId? }
 *
 *  approve / reject — decide a pending approval (approve re-runs every gate
 *                     against a fresh quote before touching the broker)
 *  exit             — manually close one open position at market
 *  run-pass         — run a full engine pass NOW (fresh scan + guard + AI);
 *                     the main use is paper-mode testing off the poller
 *
 * Admin-only via the proxy's default-deny on unclassified mutating APIs.
 */
export async function POST(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      tradeId?: number;
    };
    const action = String(body.action ?? '');

    if (action === 'approve' || action === 'reject') {
      const tradeId = Number(body.tradeId);
      if (!Number.isFinite(tradeId)) {
        return NextResponse.json({ success: false, error: 'tradeId required' }, { status: 400 });
      }
      const outcome = action === 'approve' ? await approveTrade(tradeId) : await rejectTrade(tradeId);
      return NextResponse.json({
        success: outcome.ok,
        message: outcome.message,
        state: outcome.state ?? null,
      });
    }

    if (action === 'exit') {
      const tradeId = Number(body.tradeId);
      const trade = Number.isFinite(tradeId) ? await getTrade(tradeId) : null;
      if (!trade) return NextResponse.json({ success: false, error: 'unknown tradeId' }, { status: 400 });
      const outcome = await exitTrade(trade, 'manual exit by operator');
      await insertDecision({
        date: todayIST(),
        pass: 'system',
        provider: null,
        model: null,
        summary: `Operator manual exit: ${trade.symbol} ${trade.strike}${trade.optionType} → ${outcome.message}`,
        toolTrace: [],
        promptTokens: null,
        completionTokens: null,
      });
      return NextResponse.json({
        success: outcome.ok,
        message: outcome.message,
        state: outcome.state ?? null,
      });
    }

    if (action === 'void') {
      return NextResponse.json(
        {
          success: false,
          error:
            'Void is disabled: a missing local fill is not proof that the broker has no position. Check the broker and reconciliation audit before any manual correction.',
        },
        { status: 409 }
      );
    }

    if (action === 'run-pass') {
      const url = new URL(req.url);
      const scan = await runTradeSuggest(url.origin);
      const outcome = await runAutoTradePass(scan);
      return NextResponse.json({
        success: true,
        ...outcome,
        scanned: scan.scanned,
      });
    }

    return NextResponse.json({ success: false, error: `unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
