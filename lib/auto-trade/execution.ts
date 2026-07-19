/**
 * Shared execution paths — EVERY way a position opens or closes funnels
 * through these two functions (AI tool, human approval, position guard,
 * manual exit button), so idempotency, fill handling, and audit behave
 * identically regardless of who initiated.
 *
 * Idempotency: entry keys are trade-scoped. Exit keys use numbered attempts;
 * one atomic store claim blocks concurrent placements while allowing a fresh
 * attempt after an explicitly rejected/cancelled order.
 */

import { alerts, sendAlert } from './alerts';
import { FILL_POLL_ATTEMPTS, FILL_POLL_DELAY_MS, MAX_LOSS_PER_LOT_FALLBACK, TARGET_PER_LOT_FALLBACK } from './config';
import { getAdapterById, getExecutionAdapter } from './brokers';
import type { BrokerAdapter, OrderTicket } from './brokers/adapter';
import { ticketQtyUnits } from './brokers/adapter';
import {
  claimEntryOrder,
  claimExitOrder,
  getOpenTrades,
  getOrdersForTrade,
  getTrade,
  getUnresolvedOrders,
  markOrderReconciled,
  updateOrder,
  updateTrade,
} from './store';
import type { AutoTrade, AutoTradeSettings, TradeMode } from './types';
import { todayIST } from '@/lib/dhan/market-feed';

const TAG = '[AutoTradeExec]';
import { BrokerSubmissionError, correlationIdForOrder } from './brokers/adapter';
import type { BrokerNetPosition, OrderState, RecoveredOrder } from './brokers/adapter';

// Re-export: the tag derivation moved to brokers/adapter.ts (the store persists
// it inside the atomic exit claim); existing importers keep working.
export { correlationIdForOrder };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Premium backstops re-anchored to the ACTUAL fill: stop = tighter of −40%
 *  and −₹cap/lot; target = +₹target/lot (mirrors the scanner's math). */
export function backstopsFromFill(fill: number, lotSize: number): { slPremium: number; targetPremium: number } {
  const slPct = fill * 0.6; // −40% premium backstop
  const slCap = fill - MAX_LOSS_PER_LOT_FALLBACK / lotSize;
  return {
    slPremium: Math.round(Math.max(0.05, Math.max(slPct, slCap)) * 100) / 100,
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
    correlationId: correlationIdForOrder(idemKey),
  };
}

export interface ExecOutcome {
  ok: boolean;
  message: string;
  state?: 'filled' | 'pending' | 'unknown' | 'rejected';
}

async function recoverByCorrelation(adapter: BrokerAdapter, correlationId: string): Promise<RecoveredOrder | null> {
  if (!adapter.getOrderByCorrelationId) return null;
  return adapter.getOrderByCorrelationId(correlationId);
}

function isTerminalFailure(state: OrderState): state is OrderState & { status: 'rejected' | 'cancelled' } {
  return state.status === 'rejected' || state.status === 'cancelled';
}

function partialFillUnits(state: OrderState): number {
  const units = Number(state.filledQtyUnits ?? 0);
  return Number.isFinite(units) && units > 0 ? units : 0;
}

async function applyEntryFill(orderId: number, trade: AutoTrade, fill: number): Promise<void> {
  const stops = backstopsFromFill(fill, trade.lotSize);
  await updateOrder(orderId, {
    status: 'filled',
    avgFillPrice: fill,
    error: null,
  });
  await updateTrade(trade.id, {
    status: 'open',
    entryFillPremium: fill,
    slPremium: stops.slPremium,
    targetPremium: stops.targetPremium,
    openedAt: new Date().toISOString(),
    exitReason: null,
  });
  alerts.tradePlaced(trade.symbol, trade.optionType, fill);
}

async function applyExitFill(orderId: number, trade: AutoTrade, fill: number): Promise<void> {
  const entryFill = trade.entryFillPremium ?? trade.entryPremium;
  const pnl = Math.round((fill - entryFill) * trade.lotSize * trade.lots);
  await updateOrder(orderId, {
    status: 'filled',
    avgFillPrice: fill,
    error: null,
  });
  await updateTrade(trade.id, {
    status: 'closed',
    exitFillPremium: fill,
    realizedPnlRupees: pnl,
    closedAt: new Date().toISOString(),
  });
  alerts.tradeExited(trade.symbol, trade.exitReason ?? 'broker-confirmed exit', pnl);
}

async function applyEntryState(
  orderId: number,
  trade: AutoTrade,
  state: OrderState,
  notifyManual = false,
  reference = String(orderId)
): Promise<ExecOutcome | null> {
  if (state.status === 'filled' && state.avgFillPrice != null) {
    await applyEntryFill(orderId, trade, state.avgFillPrice);
    return {
      ok: true,
      state: 'filled',
      message: `filled at ₹${state.avgFillPrice}`,
    };
  }
  if (isTerminalFailure(state)) {
    const partialUnits = partialFillUnits(state);
    if (partialUnits > 0 || state.avgFillPrice != null) {
      const detail = `entry ${state.status} after a partial fill (${partialUnits || 'unknown'} units${state.avgFillPrice != null ? ` at ₹${state.avgFillPrice}` : ''}); manual broker reconciliation required`;
      await updateOrder(orderId, { status: 'unknown', error: detail });
      if (notifyManual) alerts.manualReconciliation(trade.symbol, 'BUY', reference, detail);
      return { ok: true, state: 'unknown', message: detail };
    }
    await updateOrder(orderId, {
      status: state.status,
      error: state.detail ?? null,
    });
    await updateTrade(trade.id, {
      status: 'failed',
      exitReason: `entry ${state.status}: ${state.detail ?? 'no detail'}`,
    });
    return {
      ok: false,
      state: 'rejected',
      message: `entry ${state.status}: ${state.detail ?? 'no detail'}`,
    };
  }
  return null;
}

async function applyExitState(
  orderId: number,
  trade: AutoTrade,
  state: OrderState,
  notifyManual = false,
  reference = String(orderId)
): Promise<ExecOutcome | null> {
  if (state.status === 'filled' && state.avgFillPrice != null) {
    await applyExitFill(orderId, trade, state.avgFillPrice);
    return {
      ok: true,
      state: 'filled',
      message: `exited at ₹${state.avgFillPrice}`,
    };
  }
  if (isTerminalFailure(state)) {
    const partialUnits = partialFillUnits(state);
    if (partialUnits > 0 || state.avgFillPrice != null) {
      const detail = `exit ${state.status} after a partial fill (${partialUnits || 'unknown'} units${state.avgFillPrice != null ? ` at ₹${state.avgFillPrice}` : ''}); automatic retry blocked to prevent an oversized sell`;
      await updateOrder(orderId, { status: 'unknown', error: detail });
      if (notifyManual) alerts.manualReconciliation(trade.symbol, 'SELL', reference, detail);
      return { ok: true, state: 'unknown', message: detail };
    }
    await updateOrder(orderId, {
      status: state.status,
      error: state.detail ?? null,
    });
    return {
      ok: false,
      state: 'rejected',
      message: `exit ${state.status}; a new attempt may be made`,
    };
  }
  return null;
}

/**
 * Place the ENTRY order for a trade row that has already passed the gates.
 * Handles paper immediate fills, live fill polling, and failure bookkeeping.
 * The trade row must exist in status `placing` before calling; that state
 * reserves risk until the broker confirms a fill or a clear rejection.
 */
export async function placeEntryOrder(
  trade: AutoTrade,
  settings: AutoTradeSettings,
  executionMode: TradeMode
): Promise<ExecOutcome> {
  // Per-trade key (symmetric with the exit key `…:exit:${id}`). A prior
  // rejected attempt for the same symbol leaves its own order row holding the
  // OLD key — a non-scoped key would collide on the UNIQUE constraint here and,
  // because insertOrder runs before this function's try/catch, throw AFTER the
  // trade row was inserted 'open' → an orphaned phantom position. Scoping by
  // trade.id makes each attempt's key distinct; the store still blocks a true
  // double-placement for the SAME trade row.
  const idemKey = `${trade.date}:${trade.symbol}:${trade.optionType}:entry:${trade.id}`;
  const adapter = getExecutionAdapter(settings, executionMode);
  const ticket = ticketFromTrade(trade, 'BUY', idemKey);
  let orderId: number;
  try {
    const claimed = await claimEntryOrder({
      tradeId: trade.id,
      idemKey,
      correlationId: ticket.correlationId,
      broker: adapter.id,
      mode: executionMode,
      side: 'BUY',
      qtyUnits: ticketQtyUnits(ticket),
      brokerOrderId: null,
      status: 'sent',
      avgFillPrice: null,
      error: null,
    });
    if (claimed == null) {
      return {
        ok: true,
        state: 'pending',
        message: `entry for ${trade.symbol} is already claimed; reconciliation owns it`,
      };
    }
    orderId = claimed;
  } catch (err) {
    // Could not even record the order — the trade row must NOT linger 'open'
    // with no live broker order behind it (that was the phantom).
    const message = (err as Error).message;
    await updateTrade(trade.id, {
      status: 'failed',
      exitReason: `entry not placed: ${message}`,
    });
    return { ok: false, message: `entry not placed: ${message}` };
  }

  let placed: { brokerOrderId: string; immediateFillPrice?: number };
  try {
    placed = await adapter.placeMarketOrder(ticket);
  } catch (err) {
    const message = (err as Error).message;
    const ambiguous = !(err instanceof BrokerSubmissionError) || err.ambiguous;
    // ALWAYS surface placement failures in the server log — the DB error
    // column alone proved invisible in ops (2026-07-16 SRF incident).
    console.error(
      `${TAG} ENTRY placement failed for ${trade.symbol} (trade ${trade.id}, corr ${ticket.correlationId}, ambiguous=${ambiguous}): ${message}`
    );
    let recovered: RecoveredOrder | null = null;
    try {
      recovered = await recoverByCorrelation(adapter, ticket.correlationId);
    } catch (lookupErr) {
      const detail = `${message}; recovery lookup failed: ${(lookupErr as Error).message}`;
      await updateOrder(orderId, { status: 'unknown', error: detail });
      return {
        ok: true,
        state: 'unknown',
        message: `entry submission state is unknown; reconciliation will recover it (${detail})`,
      };
    }
    if (recovered) {
      await updateOrder(orderId, {
        brokerOrderId: recovered.brokerOrderId,
        status: recovered.status === 'unknown' ? 'unknown' : 'sent',
        error: message,
      });
      const outcome = await applyEntryState(orderId, trade, recovered, true, ticket.correlationId);
      if (outcome) return outcome;
      placed = { brokerOrderId: recovered.brokerOrderId };
    } else if (ambiguous) {
      await updateOrder(orderId, { status: 'unknown', error: message });
      return {
        ok: true,
        state: 'unknown',
        message: `entry submission state is unknown; reconciliation will recover correlation ${ticket.correlationId}`,
      };
    } else {
      await updateOrder(orderId, { status: 'rejected', error: message });
      await updateTrade(trade.id, {
        status: 'failed',
        exitReason: `entry order rejected: ${message}`,
      });
      return {
        ok: false,
        state: 'rejected',
        message: `entry order rejected: ${message}`,
      };
    }
  }
  await updateOrder(orderId, { brokerOrderId: placed.brokerOrderId });

  if (placed.immediateFillPrice != null) {
    await applyEntryFill(orderId, trade, placed.immediateFillPrice);
    return {
      ok: true,
      state: 'filled',
      message: `filled at ₹${placed.immediateFillPrice} (${adapter.id})`,
    };
  }

  // Live venue: poll briefly; an unresolved order is picked up by the next
  // cycle's reconcile step — never assumed filled, never assumed dead.
  let observedPartialUnits = 0;
  for (let i = 0; i < FILL_POLL_ATTEMPTS; i++) {
    await sleep(FILL_POLL_DELAY_MS);
    const state = await adapter.getOrderState(placed.brokerOrderId);
    observedPartialUnits = Math.max(observedPartialUnits, partialFillUnits(state));
    const outcome = await applyEntryState(orderId, trade, state, true, placed.brokerOrderId);
    if (outcome) return outcome;
  }
  if (observedPartialUnits > 0) {
    const detail = `entry has ${observedPartialUnits} partially filled units and remains unresolved; manual broker verification required`;
    await updateOrder(orderId, { status: 'unknown', error: detail });
    alerts.manualReconciliation(trade.symbol, 'BUY', placed.brokerOrderId, detail);
    return { ok: true, state: 'unknown', message: detail };
  }
  console.warn(`${TAG} entry order ${placed.brokerOrderId} unresolved after polling — reconcile will follow up`);
  return {
    ok: true,
    state: 'pending',
    message: `order ${placed.brokerOrderId} placed; fill pending confirmation (${adapter.id})`,
  };
}

/**
 * Close an open trade at market. Idempotent: a second call while the exit
 * order is in flight is refused by the idempotency key. PnL is booked only
 * when both fills are known — never estimated.
 */
export async function exitTrade(trade: AutoTrade, reason: string, aiReason?: string): Promise<ExecOutcome> {
  if (trade.status !== 'open')
    return {
      ok: false,
      message: `trade ${trade.id} is ${trade.status}, not open`,
    };
  // Positions are INTRADAY — the broker force-squares them by close. A row
  // still 'open' from a previous session is a stale ghost; SELLing it would
  // open a naked short. Refuse; reconcileOpenPositions() closes such rows.
  if (trade.date !== todayIST()) {
    return {
      ok: false,
      message: `trade ${trade.id} is from ${trade.date} (stale open row) — refusing to place a SELL; position reconciliation will close it`,
    };
  }
  const adapter = getAdapterById(trade.broker);
  // Position-level truth: before SELLing on a real venue, confirm the venue
  // still holds the contract. A definite flat (e.g. the broker's own 15:26
  // square-off ran while this process was down) means the SELL would open a
  // naked short — close the row from the broker's numbers instead. A null
  // (unverifiable) answer must NEVER block a protective exit.
  if (adapter.id !== 'paper' && adapter.getNetPosition && trade.entryFillPremium != null) {
    let pos: BrokerNetPosition | null = null;
    try {
      pos = await adapter.getNetPosition({
        symbol: trade.symbol,
        optionType: trade.optionType,
        strike: trade.strike,
        expiryDate: trade.expiryDate,
        optSecurityId: trade.optSecurityId,
      });
    } catch {
      // best-effort — an unreadable position book never blocks an exit
    }
    if (pos && pos.netQtyUnits <= 0) {
      await closeBrokerFlatTrade(trade, pos.sellAvg, `${reason} — broker already flat (position squared off at the venue)`);
      return {
        ok: true,
        state: 'filled',
        message: `position already flat at the broker — row closed${pos.sellAvg != null ? ` from venue sellAvg ₹${pos.sellAvg}` : '; verify final P&L in the broker statement'}`,
      };
    }
  }
  const claim = await claimExitOrder({
    tradeId: trade.id,
    idemKeyBase: `${trade.date}:${trade.symbol}:${trade.optionType}:exit:${trade.id}`,
    broker: adapter.id,
    mode: trade.mode,
    qtyUnits: trade.lotSize * trade.lots,
  });
  if (!claim) return { ok: false, message: `exit for ${trade.symbol} already in flight` };
  const { id: orderId, idemKey } = claim;
  const ticket = ticketFromTrade(trade, 'SELL', idemKey);
  // correlationId is already persisted inside the atomic claim INSERT — a crash
  // from here on is recoverable from the broker order book by tag.
  // Persist the exit intent before the broker POST. If the response is lost or
  // the process restarts, correlation-based reconciliation can close the fill
  // with the exact operator/guard/AI reason instead of inventing one later.
  await updateTrade(trade.id, {
    exitReason: reason,
    ...(aiReason ? { aiReasonExit: aiReason } : {}),
  });
  const exitingTrade: AutoTrade = {
    ...trade,
    exitReason: reason,
    ...(aiReason ? { aiReasonExit: aiReason } : {}),
  };

  let placed: { brokerOrderId: string; immediateFillPrice?: number };
  try {
    placed = await adapter.placeMarketOrder(ticket);
  } catch (err) {
    const message = (err as Error).message;
    const ambiguous = !(err instanceof BrokerSubmissionError) || err.ambiguous;
    console.error(
      `${TAG} EXIT placement failed for ${trade.symbol} (trade ${trade.id}, corr ${ticket.correlationId}, ambiguous=${ambiguous}): ${message}`
    );
    let recovered: RecoveredOrder | null = null;
    try {
      recovered = await recoverByCorrelation(adapter, ticket.correlationId);
    } catch (lookupErr) {
      const detail = `${message}; recovery lookup failed: ${(lookupErr as Error).message}`;
      await updateOrder(orderId, { status: 'unknown', error: detail });
      return {
        ok: true,
        state: 'unknown',
        message: `exit submission state is unknown; reconciliation will recover it (${detail})`,
      };
    }
    if (recovered) {
      await updateOrder(orderId, {
        brokerOrderId: recovered.brokerOrderId,
        status: recovered.status === 'unknown' ? 'unknown' : 'sent',
        error: message,
      });
      const outcome = await applyExitState(orderId, exitingTrade, recovered, true, ticket.correlationId);
      if (outcome) return outcome;
      placed = { brokerOrderId: recovered.brokerOrderId };
    } else if (ambiguous) {
      await updateOrder(orderId, { status: 'unknown', error: message });
      return {
        ok: true,
        state: 'unknown',
        message: `exit submission state is unknown; reconciliation will recover correlation ${ticket.correlationId}`,
      };
    } else {
      // Only an explicit broker rejection is retryable. A timeout never is.
      await updateOrder(orderId, { status: 'rejected', error: message });
      return {
        ok: false,
        state: 'rejected',
        message: `exit order rejected: ${message}`,
      };
    }
  }
  await updateOrder(orderId, { brokerOrderId: placed.brokerOrderId });

  if (placed.immediateFillPrice != null) {
    await applyExitFill(orderId, exitingTrade, placed.immediateFillPrice);
    return {
      ok: true,
      state: 'filled',
      message: `exited at ₹${placed.immediateFillPrice} (${reason})`,
    };
  }

  let observedPartialUnits = 0;
  for (let i = 0; i < FILL_POLL_ATTEMPTS; i++) {
    await sleep(FILL_POLL_DELAY_MS);
    const state = await adapter.getOrderState(placed.brokerOrderId);
    observedPartialUnits = Math.max(observedPartialUnits, partialFillUnits(state));
    const outcome = await applyExitState(orderId, exitingTrade, state, true, placed.brokerOrderId);
    if (outcome) return outcome;
  }
  if (observedPartialUnits > 0) {
    const detail = `exit has ${observedPartialUnits} partially filled units and remains unresolved; automatic retry blocked to prevent an oversized sell`;
    await updateOrder(orderId, { status: 'unknown', error: detail });
    alerts.manualReconciliation(trade.symbol, 'SELL', placed.brokerOrderId, detail);
    return { ok: true, state: 'unknown', message: detail };
  }
  console.warn(`${TAG} exit order ${placed.brokerOrderId} unresolved after polling — reconcile will follow up`);
  return {
    ok: true,
    state: 'pending',
    message: `exit order ${placed.brokerOrderId} placed; fill pending confirmation`,
  };
}

/** Close a DB row whose position the broker no longer holds. P&L is booked
 *  only when the venue reported a sell average — never estimated. */
async function closeBrokerFlatTrade(trade: AutoTrade, sellAvg: number | null, reasonDetail: string): Promise<void> {
  const entryFill = trade.entryFillPremium;
  const pnl = sellAvg != null && entryFill != null ? Math.round((sellAvg - entryFill) * trade.lotSize * trade.lots) : null;
  await updateTrade(trade.id, {
    status: 'closed',
    exitFillPremium: sellAvg,
    realizedPnlRupees: pnl,
    exitReason: reasonDetail,
    closedAt: new Date().toISOString(),
  });
  alerts.tradeExited(trade.symbol, reasonDetail, pnl);
}

/**
 * Position-level reconciliation — the truth check order-level reconcile cannot
 * provide. Runs on every engine pass (verifyBroker) and every fast-guard tick
 * (cheap date check only):
 *
 *   1. STALE rows: any 'open' trade dated before today is a ghost — INTRADAY
 *      product means the broker squared it off at the previous close. Close it
 *      locally (no invented P&L) and alert; a premium stop tripping on it the
 *      next morning would otherwise MARKET-SELL a position that no longer
 *      exists (naked short).
 *   2. BROKER-FLAT rows (verifyBroker, real venues, market intraday): the venue
 *      says the contract is flat while the DB row is open → the broker's own
 *      square-off/manual close ran without us. Close the row from the venue's
 *      sellAvg. A null (unverifiable) venue answer changes nothing — missing
 *      broker state is never treated as proof that no position exists.
 */
export async function reconcileOpenPositions(options: { verifyBroker?: boolean } = {}): Promise<string[]> {
  const notes: string[] = [];
  const today = todayIST();
  for (const trade of await getOpenTrades()) {
    try {
      if (trade.date !== today) {
        const reason = `stale open row from ${trade.date} auto-closed — INTRADAY position was already squared off broker-side; verify final P&L in the broker statement`;
        await closeBrokerFlatTrade(trade, null, reason);
        sendAlert(`🚨 ${trade.symbol} ${trade.optionType}: ${reason}`);
        notes.push(`${trade.symbol}: ${reason}`);
        continue;
      }
      if (!options.verifyBroker || trade.broker === 'paper' || trade.entryFillPremium == null) continue;
      const adapter = getAdapterById(trade.broker);
      if (!adapter.getNetPosition) continue;
      // An exit already in flight belongs to order-level reconcile — closing the
      // row here would race the fill that books the real P&L.
      const activeSell = (await getOrdersForTrade(trade.id)).some(
        (o) => o.side === 'SELL' && (o.status === 'sent' || o.status === 'unknown')
      );
      if (activeSell) continue;
      const pos = await adapter.getNetPosition({
        symbol: trade.symbol,
        optionType: trade.optionType,
        strike: trade.strike,
        expiryDate: trade.expiryDate,
        optSecurityId: trade.optSecurityId,
      });
      if (pos && pos.netQtyUnits <= 0) {
        const reason = `broker shows the position flat (squared off at the venue without us) — row closed${pos.sellAvg != null ? ` at venue sellAvg ₹${pos.sellAvg}` : '; verify final P&L in the broker statement'}`;
        await closeBrokerFlatTrade(trade, pos.sellAvg, reason);
        sendAlert(`🚨 ${trade.symbol} ${trade.optionType}: ${reason}`);
        notes.push(`${trade.symbol}: ${reason}`);
      }
    } catch (err) {
      notes.push(`${trade.symbol}: position reconcile failed (${(err as Error).message})`);
    }
  }
  return notes;
}

const MAX_RECONCILE_ORDERS = 20;
let reconcilePromise: Promise<string[]> | null = null;

/**
 * Recover orders left unresolved by a timeout, process restart, or a broker
 * acknowledgement without an immediate fill. Missing broker state is never
 * treated as proof that no position exists.
 */
export function reconcileUnresolvedOrders(): Promise<string[]> {
  if (reconcilePromise) return reconcilePromise;
  reconcilePromise = reconcileUnresolvedOrdersInner().finally(() => {
    reconcilePromise = null;
  });
  return reconcilePromise;
}

async function reconcileUnresolvedOrdersInner(): Promise<string[]> {
  // getUnresolvedOrders() is oldest-first. Always service the oldest bounded
  // batch so a stream of new orders cannot starve an earlier ambiguous order.
  const unresolved = (await getUnresolvedOrders()).slice(0, MAX_RECONCILE_ORDERS);
  const notes: string[] = [];
  for (const order of unresolved) {
    const trade = await getTrade(order.tradeId);
    if (!trade) {
      await markOrderReconciled(order.id, 'trade row missing');
      notes.push(`order ${order.id} needs manual review: trade row missing`);
      continue;
    }

    const adapter = getAdapterById(order.broker);
    let state: OrderState | null = null;
    try {
      if (order.brokerOrderId) {
        state = await adapter.getOrderState(order.brokerOrderId);
      } else if (order.correlationId) {
        const recovered = await recoverByCorrelation(adapter, order.correlationId);
        if (recovered) {
          await updateOrder(order.id, {
            brokerOrderId: recovered.brokerOrderId,
          });
          state = recovered;
        }
      }
    } catch (err) {
      const detail = `reconcile lookup failed: ${(err as Error).message}`;
      await markOrderReconciled(order.id, detail);
      notes.push(`${trade.symbol} ${order.side} ${detail}`);
      continue;
    }

    // Preserve the ORIGINAL failure text: markOrderReconciled COALESCEs its
    // note over `error`, and the first reconcile pass used to overwrite the
    // broker's actual rejection reason within seconds (2026-07-16 SRF).
    const notFoundNote = order.error ? null : 'broker order not found by id or correlation yet';
    await markOrderReconciled(order.id, state ? null : notFoundNote);
    if (!state || state.status === 'pending' || state.status === 'unknown') {
      const ageMs = Date.now() - new Date(order.createdAt).getTime();
      const nextAttempt = order.reconcileAttempts + 1;

      // Terminal give-up: the order book read SUCCEEDED, the broker never
      // issued an id, and the correlation tag matches nothing. After enough
      // clean misses the order provably never reached the venue — stop
      // reserving a daily slot + capital for a ghost. (Any order that DID
      // reach Fyers/Dhan appears in the day's book immediately, even pending.)
      if (
        state == null &&
        order.brokerOrderId == null &&
        order.correlationId != null && // a tag lookup really ran and missed
        nextAttempt >= 5 &&
        ageMs >= 5 * 60_000
      ) {
        const giveUp = `${order.error ? `${order.error}; ` : ''}never appeared in the broker order book after ${nextAttempt} checks — placement assumed failed`;
        await updateOrder(order.id, { status: 'rejected', error: giveUp });
        console.error(`${TAG} ${trade.symbol} ${order.side} order ${order.id}: ${giveUp}`);
        if (order.side === 'BUY' && trade.status === 'placing') {
          await updateTrade(trade.id, {
            status: 'failed',
            exitReason: 'entry never reached the broker — placement failed (see order log)',
          });
          alerts.manualReconciliation(
            trade.symbol,
            'BUY',
            order.correlationId ?? String(order.id),
            'Entry never reached the broker; the daily slot and capital were released. Verify once at the broker that no stray order exists.'
          );
        }
        // SELL: the order row is now terminal-rejected, so claimExitOrder
        // allows the guard/AI to place a FRESH exit attempt next pass.
        notes.push(`${trade.symbol} ${order.side}: ${giveUp}`);
        continue;
      }
      const partialUnits = state ? partialFillUnits(state) : 0;
      if (partialUnits > 0) {
        notes.push(
          `${trade.symbol} ${order.side} has ${partialUnits} partially filled units; automatic retry is blocked pending broker resolution`
        );
      }
      if (nextAttempt >= 3 || ageMs >= 90_000) {
        notes.push(
          `${trade.symbol} ${order.side} still unresolved after ${nextAttempt} checks; manual broker verification required`
        );
      }
      // Alert once at the normal third check, or immediately when the first
      // check discovers an already-old order after a restart. The DB attempt
      // counter makes this stable across both the engine and fast guard loops.
      if (nextAttempt === 3 || (order.reconcileAttempts === 0 && order.lastReconciledAt == null && ageMs >= 90_000)) {
        alerts.manualReconciliation(
          trade.symbol,
          order.side,
          order.brokerOrderId ?? order.correlationId ?? String(order.id),
          partialUnits > 0
            ? `${partialUnits} units are reported partially filled; automatic retry is blocked.`
            : `No terminal broker state after ${nextAttempt} reconciliation checks.`
        );
      }
      continue;
    }

    const outcome =
      order.side === 'BUY'
        ? await applyEntryState(
            order.id,
            trade,
            state,
            order.status !== 'unknown',
            order.brokerOrderId ?? order.correlationId ?? String(order.id)
          )
        : await applyExitState(
            order.id,
            trade,
            state,
            order.status !== 'unknown',
            order.brokerOrderId ?? order.correlationId ?? String(order.id)
          );
    if (outcome) notes.push(`${trade.symbol} ${order.side}: ${outcome.message}`);
  }
  return notes;
}
