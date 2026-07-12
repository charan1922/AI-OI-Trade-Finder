/**
 * Auto-trade engine — the per-cycle orchestrator, called from the Fyers
 * poller's autonomous capture (right after the scan + commentary) and from
 * the manual "Run pass" action. Deterministic safety runs FIRST, the AI runs
 * LAST, and nothing here ever throws to the caller:
 *
 *   1. reconcile   — resolve fills of orders the last pass left pending
 *   2. expire      — time-out stale approval proposals
 *   3. guard       — code-enforced exits (stops/targets/15:12 square-off)
 *   4. AI pass     — the decision model manages positions + considers ONE entry
 *
 * Kill switch: steps 1–3 always run (they only reduce risk); step 4 entries
 * are gate-blocked, so the AI pass is skipped entirely to save tokens.
 */

import { isMarketHours, todayIST } from '@/lib/dhan/market-feed';
import { hasAzureConfig } from '@/lib/ai-assistant/azure-client';
import { buildPicks } from '@/lib/ai-commentary/picks';
import { getCommentary, insertCommentary } from '@/lib/ai-commentary/store';
import { hasMimo } from '@/lib/env';
import { recordPromptVersion } from '@/lib/prompts/store';
import type { SuggestResponse } from '@/lib/trade-suggest/types';
import { expireStaleApprovals } from './approval';
import { backstopsFromFill, adapterFor } from './execution';
import { isEntryWindow, nowISTClock } from './config';
import { runToolLoop } from './decision/providers';
import { AUTO_TRADER_SYSTEM } from './decision/system-prompt';
import { runPositionGuard } from './risk/position-guard';
import { getAutoTradeSettings } from './settings';
import {
  countEntriesToday,
  getOpenTrades,
  getTrade,
  getUnresolvedOrders,
  insertDecision,
  updateOrder,
  updateTrade,
} from './store';
import { AUTO_TRADE_TOOLS } from './tools/defs';
import { executeAutoTradeTool, type ToolRuntime } from './tools/execute';

const TAG = '[AutoTrade]';

export interface AutoTradePassOutcome {
  ran: boolean;
  reason?: string;
  guardActions: string[];
  aiSummary?: string;
  /** True when the AI pass's read was stored as this cycle's trade_commentary
   *  row — the poller then SKIPS the standalone MiMo commentary (one AI
   *  analysis per cycle, never two). */
  commentaryStored: boolean;
  error?: string;
}

// One pass at a time per process (poller serializes its own captures; this
// also covers a manual "Run pass" overlapping the autonomous one).
const g = globalThis as unknown as { __autoTradePassRunning?: boolean };

/**
 * Resolve fills the previous pass left pending: a filled BUY anchors the
 * premium backstops to the real fill; a filled SELL books the close + P&L.
 * Terminal failures free the idempotency key so the guard can retry exits.
 */
async function reconcileUnresolvedOrders(): Promise<string[]> {
  const unresolved = await getUnresolvedOrders();
  const notes: string[] = [];
  for (const order of unresolved) {
    if (order.broker === 'paper' || !order.brokerOrderId) continue;
    const state = await adapterFor(order.broker).getOrderState(order.brokerOrderId);
    if (state.status === 'pending' || state.status === 'unknown') continue;
    const trade = await getTrade(order.tradeId);
    if (!trade) continue;
    if (state.status === 'filled' && state.avgFillPrice != null) {
      await updateOrder(order.id, { status: 'filled', avgFillPrice: state.avgFillPrice });
      if (order.side === 'BUY') {
        const stops = backstopsFromFill(state.avgFillPrice, trade.lotSize);
        await updateTrade(trade.id, {
          entryFillPremium: state.avgFillPrice,
          slPremium: stops.slPremium,
          targetPremium: stops.targetPremium,
          openedAt: trade.openedAt ?? new Date().toISOString(),
        });
        notes.push(`${trade.symbol} entry confirmed at ₹${state.avgFillPrice}`);
      } else {
        const entryFill = trade.entryFillPremium ?? trade.entryPremium;
        const pnl = Math.round((state.avgFillPrice - entryFill) * trade.lotSize * trade.lots);
        await updateTrade(trade.id, {
          status: 'closed',
          exitFillPremium: state.avgFillPrice,
          realizedPnlRupees: pnl,
          closedAt: new Date().toISOString(),
        });
        notes.push(`${trade.symbol} exit confirmed at ₹${state.avgFillPrice} (P&L ₹${pnl})`);
      }
    } else {
      // rejected / cancelled — record it; a dead ENTRY order fails the trade,
      // a dead EXIT order stays open for the guard to retry.
      await updateOrder(order.id, { status: state.status, error: state.detail ?? null });
      if (order.side === 'BUY' && trade.status === 'open' && trade.entryFillPremium == null) {
        await updateTrade(trade.id, { status: 'failed', exitReason: `entry ${state.status}: ${state.detail ?? ''}` });
        notes.push(`${trade.symbol} entry ${state.status} — trade failed`);
      } else {
        notes.push(`${trade.symbol} ${order.side} order ${state.status} — will retry if needed`);
      }
    }
  }
  return notes;
}

function providerConfigured(provider: 'azure' | 'mimo'): boolean {
  return provider === 'azure' ? hasAzureConfig() : hasMimo();
}

/**
 * Run one full auto-trade pass. `scan` is this cycle's trade-suggest result
 * (null when no scan ran — management still proceeds). Never throws.
 */
export async function runAutoTradePass(scan: SuggestResponse | null): Promise<AutoTradePassOutcome> {
  const settings = await getAutoTradeSettings();
  if (settings.mode === 'off') {
    return { ran: false, reason: 'auto-trade mode is off', guardActions: [], commentaryStored: false };
  }
  if (g.__autoTradePassRunning) {
    return { ran: false, reason: 'previous pass still running', guardActions: [], commentaryStored: false };
  }
  g.__autoTradePassRunning = true;
  const date = todayIST();

  try {
    // 1–2. Reconcile pending fills, expire stale approvals.
    const reconcileNotes = await reconcileUnresolvedOrders();
    const expired = await expireStaleApprovals(date, settings.approvalTtlMin);

    // 3. Deterministic guard — always, kill switch or not.
    const guardActions = await runPositionGuard(date);
    const systemNotes = [
      ...reconcileNotes,
      ...expired.map((e) => `approval expired: ${e}`),
      ...guardActions,
    ];
    if (systemNotes.length > 0) {
      await insertDecision({
        date,
        pass: 'guard',
        provider: null,
        model: null,
        summary: systemNotes.join(' · '),
        toolTrace: [],
        promptTokens: null,
        completionTokens: null,
      });
    }

    if (settings.killSwitch) {
      return { ran: true, reason: 'kill switch on — guard only', guardActions, commentaryStored: false };
    }

    // 4. AI pass — only when there is something to decide.
    const openTrades = await getOpenTrades();
    const entriesToday = await countEntriesToday(date);
    const entryPossible =
      isMarketHours() &&
      isEntryWindow() &&
      entriesToday < settings.maxTradesPerDay &&
      (scan?.suggestions?.length ?? 0) > 0;
    if (openTrades.length === 0 && !entryPossible) {
      return {
        ran: true,
        reason: 'nothing to decide (no positions, no entry opportunity)',
        guardActions,
        commentaryStored: false,
      };
    }
    if (!providerConfigured(settings.aiProvider)) {
      const summary = `AI provider '${settings.aiProvider}' is not configured — pass skipped (guard still ran)`;
      await insertDecision({
        date, pass: 'system', provider: settings.aiProvider, model: null, summary,
        toolTrace: [], promptTokens: null, completionTokens: null,
      });
      return { ran: true, reason: summary, guardActions, commentaryStored: false };
    }

    const rt: ToolRuntime = { scan, settings, date };
    // Today's latest stored read — the trader continues the day's thread the
    // same way the standalone commentary did.
    const previousRead = (await getCommentary({ date, limit: 1 }))[0]?.text ?? null;
    const user = JSON.stringify({
      nowIST: nowISTClock(),
      date,
      entryWindowActive: isEntryWindow(),
      openPositions: openTrades.length,
      entriesUsedToday: entriesToday,
      scanThisCycle: scan ? { scanned: scan.scanned, picks: scan.suggestions?.length ?? 0 } : null,
      previousRead,
      instruction:
        'Run your pass: account state → manage open positions → consider at most one entry. End with the day-thread read.',
    });
    const result = await runToolLoop({
      provider: settings.aiProvider,
      system: AUTO_TRADER_SYSTEM,
      user,
      tools: AUTO_TRADE_TOOLS,
      execute: (name, args) => executeAutoTradeTool(rt, name, args),
    });
    await insertDecision({
      date,
      pass: 'ai',
      provider: settings.aiProvider,
      model: result.model,
      summary: result.text,
      toolTrace: result.trace,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
    });
    // The pass's read IS this cycle's commentary — store it so /trade-commentary
    // shows it and the poller skips the standalone MiMo call (one AI per cycle).
    let commentaryStored = false;
    try {
      const promptVersion = await recordPromptVersion('auto-trader', AUTO_TRADER_SYSTEM);
      await insertCommentary({
        date,
        asOf: scan?.window?.nowIST ? `${date} ${scan.window.nowIST}` : new Date().toISOString(),
        windowActive: Boolean(scan?.window?.active),
        picksCount: scan?.suggestions?.length ?? 0,
        model: result.model,
        text: result.text,
        picks: scan ? buildPicks(scan) : [],
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        promptKey: 'auto-trader',
        promptVersion,
      });
      commentaryStored = true;
    } catch (err) {
      console.warn(`${TAG} commentary store failed (poller will fall back): ${(err as Error).message}`);
    }
    console.log(`${TAG} AI pass done: ${result.text.slice(0, 140)}`);
    return { ran: true, guardActions, aiSummary: result.text, commentaryStored };
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`${TAG} pass failed: ${message}`);
    try {
      await insertDecision({
        date, pass: 'system', provider: null, model: null,
        summary: `pass error: ${message}`, toolTrace: [], promptTokens: null, completionTokens: null,
      });
    } catch {
      // audit best-effort — never compound the failure
    }
    return { ran: true, guardActions: [], commentaryStored: false, error: message };
  } finally {
    g.__autoTradePassRunning = false;
  }
}
