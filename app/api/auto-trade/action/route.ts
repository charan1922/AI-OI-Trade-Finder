import { NextResponse } from 'next/server';
import { approveTrade, rejectTrade } from '@/lib/auto-trade/approval';
import { runOrderPipelineSmoke } from '@/lib/auto-trade/brokers/fyers-adapter';
import { runAutoTradePass } from '@/lib/auto-trade/engine';
import { exitTrade } from '@/lib/auto-trade/execution';
import { getTrade, insertDecision } from '@/lib/auto-trade/store';
import { adminOnly } from '@/lib/auth/server';
import { prisma } from '@/lib/db';
import { todayIST } from '@/lib/dhan/market-feed';
import { runTradeSuggest } from '@/lib/trade-suggest/engine';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/auto-trade/action — operator actions from the /auto-trade console.
 * body { action: 'approve' | 'reject' | 'exit' | 'run-pass' | 'order-smoke', tradeId?, symbol? }
 *
 *  approve / reject — decide a pending approval (approve re-runs every gate
 *                     against a fresh quote before touching the broker)
 *  exit             — manually close one open position at market
 *  run-pass         — run a full engine pass NOW (fresh scan + guard + AI);
 *                     the main use is paper-mode testing off the poller
 *  order-smoke      — ₹0 broker test: unfillable ₹1 limit → order book →
 *                     cancel; proves the venue accepts our orders
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
      symbol?: string;
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

    if (action === 'order-smoke') {
      // ₹0 broker order-pipeline test (place unfillable ₹1 limit → cancel).
      // Contract resolved from real data so this never rots: nearest expiry
      // from the calendar, the most liquid CE for that expiry from bhavcopy,
      // lot size from master contracts. Body may override { symbol }.
      const underlying = String(body.symbol ?? 'SRF').toUpperCase();
      const today = todayIST();
      const [expiryRow] = (await prisma.$queryRawUnsafe(
        `SELECT expiryDate FROM fno_expiry_calendar WHERE expiryDate >= ? ORDER BY expiryDate LIMIT 1`,
        today
      )) as { expiryDate: string }[];
      const [strikeRow] = (await prisma.$queryRawUnsafe(
        `SELECT strike FROM bhavcopy_option_strike
          WHERE symbol = ? AND expiry = ? AND optionType = 'CE' AND close >= 15
          ORDER BY oi DESC, date DESC LIMIT 1`,
        underlying,
        expiryRow?.expiryDate ?? ''
      )) as { strike: number }[];
      // FUTSTK rows key on `underlying` (their symbol is "SRF-Jul2026-FUT").
      const [lotRow] = (await prisma.$queryRawUnsafe(
        `SELECT lotSize FROM master_contracts WHERE underlying = ? AND instrument = 'FUTSTK' AND lotSize > 0 LIMIT 1`,
        underlying
      )) as { lotSize: number }[];
      if (!expiryRow || !strikeRow || !lotRow) {
        return NextResponse.json(
          { success: false, error: `cannot resolve a test contract for ${underlying} (expiry/strike/lot missing)` },
          { status: 400 }
        );
      }
      const contract = {
        symbol: underlying,
        optionType: 'CE' as const,
        strike: Number(strikeRow.strike),
        expiryDate: expiryRow.expiryDate,
        lotSize: Number(lotRow.lotSize),
      };
      const result = await runOrderPipelineSmoke(contract);
      await insertDecision({
        date: today,
        pass: 'system',
        provider: null,
        model: null,
        summary: `Operator order-pipeline smoke test (${underlying} ${contract.strike}CE ${contract.expiryDate}): ${result.ok ? 'PASS' : 'FAIL'} — ${result.steps.join(' · ')}`,
        toolTrace: [],
        promptTokens: null,
        completionTokens: null,
      });
      return NextResponse.json({
        success: result.ok,
        message: result.steps.join('\n'),
        steps: result.steps,
        contract,
      });
    }

    return NextResponse.json({ success: false, error: `unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
