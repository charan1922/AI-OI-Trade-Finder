/**
 * Shared execution paths — EVERY way a position opens or closes funnels
 * through these two functions (AI tool, human approval, position guard,
 * manual exit button), so idempotency, fill handling, and audit behave
 * identically regardless of who initiated.
 *
 * Idempotency: entry key `${date}:${symbol}:${optionType}:entry`, exit key
 * `...:exit:${tradeId}` — a second placement attempt for the same key is
 * refused at the store before any broker call.
 */

import { FILL_POLL_ATTEMPTS, FILL_POLL_DELAY_MS, MAX_LOSS_PER_LOT_FALLBACK, TARGET_PER_LOT_FALLBACK } from './config';
import { getAdapterById, getExecutionAdapter } from './brokers';
import type { BrokerAdapter, OrderTicket } from './brokers/adapter';
import { ticketQtyUnits } from './brokers/adapter';
import { insertOrder, orderExistsForKey, updateOrder, updateTrade } from './store';
import type { AutoTrade, AutoTradeSettings, TradeMode } from './types';

const TAG = '[AutoTradeExec]';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Premium backstops re-anchored to the ACTUAL fill: stop = tighter of −40%
 *  and −₹cap/lot; target = +₹target/lot (mirrors the scanner's math). */
export function backstopsFromFill(fill: number, lotSize: number): { slPremium: number; targetPremium: number } {
  const slPct = fill * 0.6; // −40% premium backstop
  const slCap = fill - MAX_LOSS_PER_LOT_FALLBACK / lotSize;
  return {
    slPremium: Math.round(Math.max(0, Math.max(slPct, slCap)) * 100) / 100,
    targetPremium: Math.round((fill + TARGET_PER_LOT_FALLBACK / lotSize) * 100) / 100,
  };
}

function ticketFromTrade(trade: AutoTrade, side: 'BUY' | 'SELL', idemKey: string): OrderTicket {
  return {
    side,
    symbol: trade.symbol,
    optionType: trade.optionType,
    strike: trade.strike,
    expiryDate: trade.expiryDate,
    optSecurityId: trade.optSecurityId,
    lotSize: trade.lotSize,
    lots: trade.lots,
    idemKey,
  };
}

export interface ExecOutcome {
  ok: boolean;
  message: string;
}

/**
 * Place the ENTRY order for a trade row that has already passed the gates.
 * Handles paper immediate fills, live fill polling, and failure bookkeeping.
 * The trade row must exist (status 'open') before calling.
 */
export async function placeEntryOrder(
  trade: AutoTrade,
  settings: AutoTradeSettings,
  executionMode: TradeMode,
): Promise<ExecOutcome> {
  // Per-trade key (symmetric with the exit key `…:exit:${id}`). A prior
  // rejected attempt for the same symbol leaves its own order row holding the
  // OLD key — a non-scoped key would collide on the UNIQUE constraint here and,
  // because insertOrder runs before this function's try/catch, throw AFTER the
  // trade row was inserted 'open' → an orphaned phantom position. Scoping by
  // trade.id makes each attempt's key distinct; the store still blocks a true
  // double-placement for the SAME trade row.
  const idemKey = `${trade.date}:${trade.symbol}:${trade.optionType}:entry:${trade.id}`;
  if (await orderExistsForKey(idemKey)) {
    return { ok: false, message: `entry order for ${trade.symbol} already exists (idempotency)` };
  }
  const adapter = getExecutionAdapter(settings, executionMode);
  const ticket = ticketFromTrade(trade, 'BUY', idemKey);
  let orderId: number;
  try {
    orderId = await insertOrder({
      tradeId: trade.id,
      idemKey,
      broker: adapter.id,
      mode: executionMode,
      side: 'BUY',
      qtyUnits: ticketQtyUnits(ticket),
      brokerOrderId: null,
      status: 'sent',
      avgFillPrice: null,
      error: null,
    });
  } catch (err) {
    // Could not even record the order — the trade row must NOT linger 'open'
    // with no live broker order behind it (that was the phantom).
    const message = (err as Error).message;
    await updateTrade(trade.id, { status: 'failed', exitReason: `entry not placed: ${message}` });
    return { ok: false, message: `entry not placed: ${message}` };
  }

  let placed: { brokerOrderId: string; immediateFillPrice?: number };
  try {
    placed = await adapter.placeMarketOrder(ticket);
  } catch (err) {
    const message = (err as Error).message;
    await updateOrder(orderId, { status: 'rejected', error: message });
    await updateTrade(trade.id, { status: 'failed', exitReason: `entry order failed: ${message}` });
    return { ok: false, message: `entry order failed: ${message}` };
  }
  await updateOrder(orderId, { brokerOrderId: placed.brokerOrderId });

  const applyFill = async (fill: number): Promise<void> => {
    const stops = backstopsFromFill(fill, trade.lotSize);
    await updateOrder(orderId, { status: 'filled', avgFillPrice: fill });
    await updateTrade(trade.id, {
      entryFillPremium: fill,
      slPremium: stops.slPremium,
      targetPremium: stops.targetPremium,
      openedAt: new Date().toISOString(),
    });
  };

  if (placed.immediateFillPrice != null) {
    await applyFill(placed.immediateFillPrice);
    return { ok: true, message: `filled at ₹${placed.immediateFillPrice} (${adapter.id})` };
  }

  // Live venue: poll briefly; an unresolved order is picked up by the next
  // cycle's reconcile step — never assumed filled, never assumed dead.
  for (let i = 0; i < FILL_POLL_ATTEMPTS; i++) {
    await sleep(FILL_POLL_DELAY_MS);
    const state = await adapter.getOrderState(placed.brokerOrderId);
    if (state.status === 'filled' && state.avgFillPrice != null) {
      await applyFill(state.avgFillPrice);
      return { ok: true, message: `filled at ₹${state.avgFillPrice} (${adapter.id} order ${placed.brokerOrderId})` };
    }
    if (state.status === 'rejected' || state.status === 'cancelled') {
      await updateOrder(orderId, { status: state.status, error: state.detail ?? null });
      await updateTrade(trade.id, { status: 'failed', exitReason: `entry ${state.status}: ${state.detail ?? ''}` });
      return { ok: false, message: `entry ${state.status}: ${state.detail ?? 'no detail'}` };
    }
  }
  console.warn(`${TAG} entry order ${placed.brokerOrderId} unresolved after polling — reconcile will follow up`);
  return { ok: true, message: `order ${placed.brokerOrderId} placed; fill pending confirmation (${adapter.id})` };
}

/**
 * Close an open trade at market. Idempotent: a second call while the exit
 * order is in flight is refused by the idempotency key. PnL is booked only
 * when both fills are known — never estimated.
 */
export async function exitTrade(trade: AutoTrade, reason: string, aiReason?: string): Promise<ExecOutcome> {
  if (trade.status !== 'open') return { ok: false, message: `trade ${trade.id} is ${trade.status}, not open` };
  const idemKey = `${trade.date}:${trade.symbol}:${trade.optionType}:exit:${trade.id}`;
  if (await orderExistsForKey(idemKey)) {
    return { ok: false, message: `exit for ${trade.symbol} already in flight` };
  }
  const adapter = getAdapterById(trade.broker);
  const ticket = ticketFromTrade(trade, 'SELL', idemKey);
  const orderId = await insertOrder({
    tradeId: trade.id,
    idemKey,
    broker: adapter.id,
    mode: trade.mode,
    side: 'SELL',
    qtyUnits: ticketQtyUnits(ticket),
    brokerOrderId: null,
    status: 'sent',
    avgFillPrice: null,
    error: null,
  });

  let placed: { brokerOrderId: string; immediateFillPrice?: number };
  try {
    placed = await adapter.placeMarketOrder(ticket);
  } catch (err) {
    const message = (err as Error).message;
    // A failed exit keeps the trade OPEN and retryable (rejected orders don't
    // block the idempotency key) — the guard retries next cycle.
    await updateOrder(orderId, { status: 'rejected', error: message });
    return { ok: false, message: `exit order failed (will retry): ${message}` };
  }
  await updateOrder(orderId, { brokerOrderId: placed.brokerOrderId });
  await updateTrade(trade.id, { exitReason: reason, ...(aiReason ? { aiReasonExit: aiReason } : {}) });

  const applyClose = async (fill: number): Promise<void> => {
    const entryFill = trade.entryFillPremium ?? trade.entryPremium;
    const pnl = Math.round((fill - entryFill) * trade.lotSize * trade.lots);
    await updateOrder(orderId, { status: 'filled', avgFillPrice: fill });
    await updateTrade(trade.id, {
      status: 'closed',
      exitFillPremium: fill,
      realizedPnlRupees: pnl,
      closedAt: new Date().toISOString(),
    });
  };

  if (placed.immediateFillPrice != null) {
    await applyClose(placed.immediateFillPrice);
    return { ok: true, message: `exited at ₹${placed.immediateFillPrice} (${reason})` };
  }

  for (let i = 0; i < FILL_POLL_ATTEMPTS; i++) {
    await sleep(FILL_POLL_DELAY_MS);
    const state = await adapter.getOrderState(placed.brokerOrderId);
    if (state.status === 'filled' && state.avgFillPrice != null) {
      await applyClose(state.avgFillPrice);
      return { ok: true, message: `exited at ₹${state.avgFillPrice} (${reason})` };
    }
    if (state.status === 'rejected' || state.status === 'cancelled') {
      await updateOrder(orderId, { status: state.status, error: state.detail ?? null });
      return { ok: false, message: `exit ${state.status} (will retry): ${state.detail ?? 'no detail'}` };
    }
  }
  console.warn(`${TAG} exit order ${placed.brokerOrderId} unresolved after polling — reconcile will follow up`);
  return { ok: true, message: `exit order ${placed.brokerOrderId} placed; fill pending confirmation` };
}

/** Adapter accessor for the reconcile step (keeps brokers/ out of engine.ts). */
export function adapterFor(brokerId: string): BrokerAdapter {
  return getAdapterById(brokerId);
}
