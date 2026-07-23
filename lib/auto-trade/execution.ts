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

import { alerts, sendCriticalAlert } from './alerts';
import {
  ENTRY_METRIC_MAX_AGE_MS,
  FILL_POLL_ATTEMPTS,
  FILL_POLL_DELAY_MS,
  MAX_RISK_PER_LOT_FALLBACK,
} from './config';
import { getAutoTradeSettings } from './settings';
import { backstopsFromProposalFill, effectiveBreachCeiling, fillRiskPerLotRupees } from './backstops';
import { getAdapterById, getExecutionAdapter } from './brokers';
import type { BrokerAdapter, OrderTicket } from './brokers/adapter';
import { ticketQtyUnits } from './brokers/adapter';
import { toFyersOptionSymbol } from './brokers/fyers-adapter';
import { activateRiskLatch } from './risk/latch';
import {
  claimEntryOrder,
  claimExitOrder,
  getOpenTrades,
  getOrdersForTrade,
  getTrade,
  getTradesByDate,
  getUnresolvedOrders,
  markOrderReconciled,
  recordEntryQuant,
  updateOrder,
  updateTrade,
} from './store';
import { latestSpotRead } from './quotes';
import { computeReanchor } from './quant/reanchor';
import type { AutoTrade, AutoTradeSettings, TradeMode } from './types';
import { todayIST } from '@/lib/dhan/market-feed';
import { getFyersCandles, fyersBucketFor } from '@/lib/fyers/candle-store';

const TAG = '[AutoTradeExec]';
import { BrokerSubmissionError, correlationIdForOrder } from './brokers/adapter';
import type { BrokerPositionRead, OrderState, RecoveredOrder } from './brokers/adapter';

// Re-export: the tag derivation moved to brokers/adapter.ts (the store persists
// it inside the atomic exit claim); existing importers keep working.
export { correlationIdForOrder };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The cash-target math moved to backstops.ts so CI can verify it WITHOUT a
// database — this module's import graph reaches the store, which kept the money
// math out of every automated gate (AT-REVIEW 2026-07-23). Re-exported here so
// existing importers are untouched.
export {
  backstopsFromFill,
  backstopsFromProposalFill,
  effectiveBreachCeiling,
  fillRiskPerLotRupees,
  isRestTargetExecutable,
  riskPerLotRupees,
  stopPremiumForFill,
  targetRupeesForPosition,
} from './backstops';

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
  // targetPremium was calculated from the runtime policy BEFORE placement.
  // Recover that snapshotted cash amount and re-anchor it to the actual fill,
  // so a settings change while an approval/order is pending cannot move it.
  const stops = backstopsFromProposalFill(
    fill,
    trade.lotSize,
    trade.lots,
    trade.entryPremium,
    trade.targetPremium,
    trade.slPremium
  );
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
  // Start tracking the exact option as soon as FYERS confirms the fill. This
  // avoids waiting for the next 5-second guard tick before the event-driven
  // target path becomes active. Best-effort and off the fill-booking path.
  if (trade.broker === 'fyers') {
    void Promise.all([import('./fyers-pnl-stream'), getOpenTrades()])
      .then(([stream, openTrades]) => stream.syncFyersPnlStream(openTrades))
      .catch((err) => console.warn(`${TAG} P&L stream post-fill sync failed: ${(err as Error).message}`));
  }
  alerts.tradePlaced(trade.symbol, trade.optionType, fill);
  // Actual-fill risk check (PR#18 review). The entry gate sizes risk off the
  // best ask, but a MARKET order can sweep above it — so the ceiling it enforced
  // is a planned figure, not a guarantee. Measure what the position really
  // carries and, if it broke the budget the gate APPROVED it against, say so
  // loudly AND stand the system down for the day (a risk latch: blocks further
  // entries, never forces an exit — the position is already open and guarded).
  //
  // The ceiling compared against is the one SNAPSHOTTED on the trade at gate
  // time, not the live setting: an operator raising or lowering
  // maxRiskPerLotRupees in the seconds between approval and fill must not hide a
  // real breach or manufacture a false one (PR#18 review). Falls back to the
  // current setting only for rows written before the snapshot existed.
  try {
    // Prefer the ceiling SNAPSHOTTED on the trade (the one that actually
    // approved this placement); read the live setting only when there is no
    // snapshot. On the approval path the snapshot is refreshed to the
    // approval-time ceiling at the moment of the click, so this compares against
    // exactly what the gate enforced (PR#18 re-review).
    const snapshot = trade.approvedMaxRiskPerLotRupees ?? null;
    const currentSetting =
      snapshot != null && Number.isFinite(snapshot) ? null : (await getAutoTradeSettings()).maxRiskPerLotRupees;
    const ceiling = effectiveBreachCeiling(snapshot, currentSetting, MAX_RISK_PER_LOT_FALLBACK);
    const actualRiskPerLot = fillRiskPerLotRupees(fill, stops.slPremium, trade.lotSize);
    if (Number.isFinite(actualRiskPerLot) && actualRiskPerLot > ceiling) {
      const detail =
        `${trade.symbol} ${trade.strike}${trade.optionType}: filled at ₹${fill} (proposal ₹${trade.entryPremium}), ` +
        `so this lot now risks ₹${actualRiskPerLot.toLocaleString('en-IN')} to its ₹${stops.slPremium} stop — ` +
        `above the ₹${ceiling.toLocaleString('en-IN')} per-lot budget the gate approved. ` +
        `A market buy can fill above the ask, so the ceiling is a PLANNED figure, not a guaranteed maximum loss.`;
      console.warn(`${TAG} ${detail}`);
      alerts.riskCeilingBreachedOnFill(detail);
      // Durable incident: our sizing assumption was violated by the fill, so no
      // further entry may be added until an operator reviews it. Exits are never
      // gated on the latch, so THIS position stays fully guarded.
      await activateRiskLatch(`risk-ceiling-breach-on-fill:trade-${trade.id}`, detail);
    }
  } catch (err) {
    console.warn(`${TAG} actual-fill risk check failed: ${(err as Error).message}`);
  }
  // SHADOW measurement AFTER the fill is booked — off the pre-submission path,
  // at the moment the position actually opened. Best-effort; never throws.
  await captureEntryShadow(trade);
}

/**
 * Fill-time quant SHADOW capture (AT-review 2026-07-20). Runs AFTER a fill is
 * confirmed and the row is 'open', so it measures the moment the position
 * actually opened — crucial for approval mode, where the human approves minutes
 * after the AI proposed — and sits OFF the pre-submission critical path. Fully
 * best-effort: any failure is swallowed so it can never disturb fill booking.
 *
 * Two distinct R systems are persisted (never conflated):
 *  - PLAN progress (entryProgressR / entryForwardRR) — measured from the
 *    scanner's planned entry against the PLANNED risk. Answers "how late is this
 *    entry vs the plan?" (anti-chase). Denominator: entryInitialRiskPoints.
 *  - POST-ENTRY excursion baseline (entryObservedSpot + entryObservedRiskPoints)
 *    — the underlying spot WHEN the fill confirmed and |observed − stop|. The
 *    guard measures MFE/MAE from HERE, so a pre-entry run-up can't be booked as
 *    a post-entry gain (breakeven/trailing research needs the true entry).
 *
 * The spot source is the recorded 5-min candle close WITH its age (candle store,
 * NOT a live tick). All R/chg metrics require a spot inside the STRICT
 * ENTRY_METRIC_MAX_AGE_MS window (tighter than the guard's 15-min stop
 * freshness) — a staler read is recorded as null, never fabricated evidence.
 */
async function captureEntryShadow(trade: AutoTrade): Promise<void> {
  try {
    const [spotRead, bars] = await Promise.all([
      latestSpotRead(trade.symbol, trade.date),
      getFyersCandles(trade.symbol, trade.date, 'EQ'),
    ]);
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const { entrySpot, slSpot, targetSpot } = trade;
    const plannedRisk = slSpot != null ? Math.abs(entrySpot - slSpot) : null; // plan-progress denominator
    const dirSign = trade.direction === 'bullish' ? 1 : -1;
    const observed = spotRead?.price ?? null;
    const ageMs = spotRead?.ageMs ?? null;
    const dayOpen = bars.find((b) => b.open > 0)?.open ?? null;
    const havePlanRisk = plannedRisk != null && plannedRisk > 0;

    // STRICT entry-metric freshness (finding 4): a 10–14-min-old candle passes
    // the guard's 15-min stop-freshness check but is too stale to calibrate a
    // fill. Gate every R/chg metric on this tighter window instead.
    const metricFresh = observed != null && ageMs != null && ageMs <= ENTRY_METRIC_MAX_AGE_MS;

    // POST-ENTRY risk from the OBSERVED fill (finding 2) — the MFE/MAE
    // denominator; null when the fill spot was stale (no honest baseline).
    const observedRisk = metricFresh && slSpot != null ? Math.abs(observed! - slSpot) : null;

    // PLAN progress (from planned entry / planned risk) — the late-chase signal.
    const progressR = metricFresh && havePlanRisk ? round2((dirSign * (observed! - entrySpot)) / plannedRisk!) : null;
    const remainingRewardR =
      metricFresh && targetSpot != null && havePlanRisk
        ? round2((dirSign * (targetSpot - observed!)) / plannedRisk!)
        : null;
    const changePctOpen = metricFresh && dayOpen != null && dayOpen > 0 ? round2(((observed! - dayOpen) / dayOpen) * 100) : null;

    let forwardRR: number | null = null;
    let freshSlSpot: number | null = null;
    let freshTargetSpot: number | null = null;
    if (metricFresh && bars.length > 0) {
      const reanchor = computeReanchor({
        side: trade.optionType,
        direction: trade.direction,
        plannedSlSpot: slSpot,
        plannedTargetSpot: targetSpot,
        freshSpot: observed!,
        bars,
        nowBucketTs: fyersBucketFor(Date.now()),
      });
      forwardRR = reanchor.forwardRR;
      freshSlSpot = reanchor.freshSlSpot;
      freshTargetSpot = reanchor.freshTargetSpot;
    }

    await recordEntryQuant(trade.id, {
      entryObservedSpot: observed,
      entrySpotAgeMs: ageMs,
      entrySpotBucketTs: spotRead?.bucketTs ?? null,
      entrySpotFresh: metricFresh,
      entryChangePctOpen: changePctOpen,
      entryProgressR: progressR,
      entryRemainingRewardR: remainingRewardR,
      entryForwardRR: forwardRR,
      entryFreshSlSpot: freshSlSpot,
      entryFreshTargetSpot: freshTargetSpot,
      entryInitialRiskPoints: plannedRisk,
      entryObservedRiskPoints: observedRisk,
    });
    console.log(
      `${TAG} [shadow] ${trade.symbol} fill: chgOpen ${changePctOpen ?? '—'}% · progressR ${progressR ?? '—'} · fwdRR ${forwardRR ?? '—'} · obsRisk ${observedRisk ?? '—'} · metricFresh ${metricFresh} (age ${ageMs ?? '—'}ms)`
    );
  } catch (err) {
    console.warn(`${TAG} [shadow] entry capture failed for ${trade.symbol}: ${(err as Error).message}`);
  }
}

async function applyExitFill(
  orderId: number,
  trade: AutoTrade,
  fill: number,
  soldUnits = trade.lotSize * trade.lots
): Promise<void> {
  const entryFill = trade.entryFillPremium ?? trade.entryPremium;
  // P&L from the units ACTUALLY sold — a partial fill must never book the
  // full-lot P&L (AT-010: quantity is part of the fill, not just the price).
  const pnl = Math.round((fill - entryFill) * soldUnits);
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
  reference = String(orderId),
  expectedQtyUnits = trade.lotSize * trade.lots
): Promise<ExecOutcome | null> {
  if (state.status === 'filled' && state.avgFillPrice != null) {
    const filledUnits = partialFillUnits(state);
    await applyEntryFill(orderId, trade, state.avgFillPrice);
    if (filledUnits > 0 && filledUnits !== expectedQtyUnits) {
      // The venue says TRADED but reported a different quantity than requested.
      // The row is opened anyway (the guard must protect whatever exists) and
      // the mismatch is latched — the exit path sells only the venue-verified
      // quantity, so the wrong local size can never produce an oversized SELL.
      const detail = `${trade.symbol} entry reported filled ${filledUnits}/${expectedQtyUnits} units (ref ${reference})`;
      alerts.positionMismatch(trade.symbol, detail);
      await activateRiskLatch(`entry-qty-mismatch:trade-${trade.id}`, detail);
      return { ok: true, state: 'filled', message: `filled at ₹${state.avgFillPrice} but only ${filledUnits}/${expectedQtyUnits} units — mismatch latched` };
    }
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
  reference = String(orderId),
  expectedQtyUnits = trade.lotSize * trade.lots
): Promise<ExecOutcome | null> {
  if (state.status === 'filled' && state.avgFillPrice != null) {
    const filledUnits = partialFillUnits(state);
    const soldUnits = filledUnits > 0 ? filledUnits : expectedQtyUnits;
    await applyExitFill(orderId, trade, state.avgFillPrice, soldUnits);
    if (filledUnits > 0 && filledUnits !== expectedQtyUnits) {
      // TRADED with a different quantity than the order asked for: P&L above
      // used the real units; the residual position (if any) is the incident.
      const detail = `${trade.symbol} exit reported filled ${filledUnits}/${expectedQtyUnits} units (ref ${reference}) — residual position possible`;
      alerts.positionMismatch(trade.symbol, detail);
      await activateRiskLatch(`exit-qty-mismatch:trade-${trade.id}`, detail);
      return { ok: true, state: 'filled', message: `exited ${filledUnits}/${expectedQtyUnits} units at ₹${state.avgFillPrice} — mismatch latched` };
    }
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
  // Position-level truth: before SELLing on a real venue, classify what the
  // venue ACTUALLY holds against what the DB expects (AT-002):
  //   verified 0        → the venue already squared off — close the row, no SELL
  //   verified < 0      → unexpected SHORT: selling would deepen it — refuse + latch
  //   verified > expect → excess (manual interference): automation stands down — refuse + latch
  //   verified < expect → partial: SELL ONLY the verified units (never oversell) + latch
  //   unavailable       → NEVER blocks a protective exit — sell the expected quantity
  const expectedQtyUnits = trade.lotSize * trade.lots;
  let sellQtyUnits = expectedQtyUnits;
  if (adapter.id !== 'paper' && adapter.getNetPosition && trade.entryFillPremium != null) {
    let read: BrokerPositionRead | null = null;
    try {
      read = await adapter.getNetPosition({
        symbol: trade.symbol,
        optionType: trade.optionType,
        strike: trade.strike,
        expiryDate: trade.expiryDate,
        optSecurityId: trade.optSecurityId,
      });
    } catch {
      // best-effort — an unreadable position book never blocks an exit
    }
    if (read?.kind === 'verified') {
      if (read.netQtyUnits === 0) {
        await closeBrokerFlatTrade(trade, read.sellAvg, `${reason} — broker already flat (position squared off at the venue)`);
        return {
          ok: true,
          state: 'filled',
          message: `position already flat at the broker — row closed${read.sellAvg != null ? ` from venue sellAvg ₹${read.sellAvg}` : '; verify final P&L in the broker statement'}`,
        };
      }
      if (read.netQtyUnits < 0) {
        const detail = `${trade.symbol} venue shows a SHORT of ${read.netQtyUnits} units while the DB expects long ${expectedQtyUnits} — automated SELL refused`;
        alerts.positionMismatch(trade.symbol, detail);
        await activateRiskLatch(`unexpected-short:trade-${trade.id}`, detail);
        return { ok: false, message: `refusing to SELL: ${detail}` };
      }
      if (read.netQtyUnits > expectedQtyUnits) {
        const detail = `${trade.symbol} venue holds ${read.netQtyUnits} units vs expected ${expectedQtyUnits} (excess — manual interference?) — automated SELL refused, resolve at the broker`;
        alerts.positionMismatch(trade.symbol, detail);
        await activateRiskLatch(`excess-position:trade-${trade.id}`, detail);
        return { ok: false, message: `refusing to SELL: ${detail}` };
      }
      if (read.netQtyUnits < expectedQtyUnits) {
        sellQtyUnits = read.netQtyUnits;
        const detail = `${trade.symbol} venue holds only ${read.netQtyUnits}/${expectedQtyUnits} units — exit reduced to the verified quantity`;
        alerts.positionMismatch(trade.symbol, detail);
        await activateRiskLatch(`partial-position:trade-${trade.id}`, detail);
      }
    }
  }
  const claim = await claimExitOrder({
    tradeId: trade.id,
    idemKeyBase: `${trade.date}:${trade.symbol}:${trade.optionType}:exit:${trade.id}`,
    broker: adapter.id,
    mode: trade.mode,
    qtyUnits: sellQtyUnits,
  });
  if (!claim) return { ok: false, message: `exit for ${trade.symbol} already in flight` };
  const { id: orderId, idemKey } = claim;
  const ticket = ticketFromTrade(trade, 'SELL', idemKey);
  if (sellQtyUnits !== expectedQtyUnits) ticket.qtyUnitsOverride = sellQtyUnits;
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
      const outcome = await applyExitState(orderId, exitingTrade, recovered, true, ticket.correlationId, sellQtyUnits);
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
    await applyExitFill(orderId, exitingTrade, placed.immediateFillPrice, sellQtyUnits);
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
    const outcome = await applyExitState(orderId, exitingTrade, state, true, placed.brokerOrderId, sellQtyUnits);
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
        sendCriticalAlert(`🚨 ${trade.symbol} ${trade.optionType}: ${reason}`);
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
      const read = await adapter.getNetPosition({
        symbol: trade.symbol,
        optionType: trade.optionType,
        strike: trade.strike,
        expiryDate: trade.expiryDate,
        optSecurityId: trade.optSecurityId,
      });
      if (read.kind !== 'verified') continue; // venue cannot say — never proof of anything
      const expected = trade.lotSize * trade.lots;
      if (read.netQtyUnits === 0) {
        const reason = `broker shows the position flat (squared off at the venue without us) — row closed${read.sellAvg != null ? ` at venue sellAvg ₹${read.sellAvg}` : '; verify final P&L in the broker statement'}`;
        await closeBrokerFlatTrade(trade, read.sellAvg, reason);
        sendCriticalAlert(`🚨 ${trade.symbol} ${trade.optionType}: ${reason}`);
        notes.push(`${trade.symbol}: ${reason}`);
      } else if (read.netQtyUnits < 0) {
        const detail = `${trade.symbol} venue shows SHORT ${read.netQtyUnits} units while the DB expects long ${expected}`;
        alerts.positionMismatch(trade.symbol, detail);
        await activateRiskLatch(`unexpected-short:trade-${trade.id}`, detail);
        notes.push(`${trade.symbol}: ${detail} — latched, automation stands down`);
      } else if (read.netQtyUnits !== expected) {
        const kind = read.netQtyUnits > expected ? 'excess' : 'partial';
        const detail = `${trade.symbol} venue holds ${read.netQtyUnits} units vs expected ${expected} (${kind})`;
        alerts.positionMismatch(trade.symbol, detail);
        await activateRiskLatch(`${kind}-position:trade-${trade.id}`, detail);
        notes.push(`${trade.symbol}: ${detail} — latched (exit will use the verified quantity)`);
      }
    } catch (err) {
      notes.push(`${trade.symbol}: position reconcile failed (${(err as Error).message})`);
    }
  }
  return notes;
}

/**
 * Reverse (broker → DB) reconciliation, AT-003: list every live INTRADAY NSE
 * F&O position at the ACTIVE broker and demand a local explanation for it. A
 * position matching no local trade (a lost order, a crash after placement, a
 * manual order in the automation's account) is an ORPHAN: it has no stop, no
 * square-off, and no exposure accounting here — latch entries and alert. A
 * position matching only a CLOSED/FAILED local row means the DB thinks risk is
 * gone while the venue still holds it — same severity.
 *
 * Runs on real-broker modes only (approval/live): in paper/off the operator's
 * own manual intraday trading must not trip the latch.
 */
export async function scanForOrphanBrokerPositions(settings: AutoTradeSettings): Promise<string[]> {
  if (settings.mode !== 'approval' && settings.mode !== 'live') return [];
  const adapter = getAdapterById(settings.broker);
  if (!adapter.listNetPositions) return [];
  let book: Awaited<ReturnType<NonNullable<BrokerAdapter['listNetPositions']>>>;
  try {
    book = await adapter.listNetPositions();
  } catch (err) {
    book = null;
    console.warn(`${TAG} orphan scan: listNetPositions threw: ${(err as Error).message}`);
  }
  if (book == null) return ['orphan scan: broker position book unreadable this pass (not proof of flat)'];
  const notes: string[] = [];
  const trades = await getTradesByDate(todayIST());
  const RISK_BEARING = new Set(['open', 'placing', 'pending_approval']);
  const matchesTrade = (t: AutoTrade, pos: { securityId: string | null; rawSymbol: string }): boolean =>
    pos.securityId != null
      ? pos.securityId === t.optSecurityId
      : pos.rawSymbol ===
        toFyersOptionSymbol({
          symbol: t.symbol,
          optionType: t.optionType,
          strike: t.strike,
          expiryDate: t.expiryDate,
        });
  for (const pos of book) {
    if (pos.netQtyUnits === 0) continue;
    if (pos.netQtyUnits == null) {
      const detail = `venue reports ${pos.rawSymbol} with an UNPARSEABLE quantity — position truth unknown`;
      const added = await activateRiskLatch(`unparseable-position:${pos.rawSymbol}`, detail);
      if (added) notes.push(`orphan scan: ${detail}`);
      continue;
    }
    if (trades.some((t) => RISK_BEARING.has(t.status) && matchesTrade(t, pos))) continue; // known & guarded
    const matchesClosed = trades.some((t) => matchesTrade(t, pos));
    const key = matchesClosed ? `closed-but-broker-open:${pos.rawSymbol}` : `orphan-position:${pos.rawSymbol}`;
    const detail = matchesClosed
      ? `${settings.broker} still holds ${pos.netQtyUnits} unit(s) of ${pos.rawSymbol} but the local trade is closed/failed — the venue position is UNMANAGED`
      : `${settings.broker} holds ${pos.netQtyUnits} unit(s) of ${pos.rawSymbol} with NO local trade — no stop, no square-off, no exposure accounting`;
    const added = await activateRiskLatch(key, detail);
    if (added) notes.push(`orphan scan: ${detail}`);
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
      // issued an id, and the correlation tag matches nothing. Order-book
      // misses alone are NOT sufficient proof for a money decision (AT-004):
      // before releasing the daily slot + capital, the POSITION book must
      // corroborate. Paper is exempt — it fills synchronously and has no book.
      if (
        state == null &&
        order.brokerOrderId == null &&
        order.correlationId != null && // a tag lookup really ran and missed
        nextAttempt >= 5 &&
        ageMs >= 5 * 60_000
      ) {
        if (adapter.id !== 'paper') {
          let read: BrokerPositionRead | null = null;
          if (adapter.getNetPosition) {
            try {
              read = await adapter.getNetPosition({
                symbol: trade.symbol,
                optionType: trade.optionType,
                strike: trade.strike,
                expiryDate: trade.expiryDate,
                optSecurityId: trade.optSecurityId,
              });
            } catch {
              read = null;
            }
          }
          if (read == null || read.kind !== 'verified') {
            // Cannot verify the position book → the order stays quarantined
            // (risk-bearing). "Unknown" is never converted into "failed".
            notes.push(`${trade.symbol} ${order.side}: give-up deferred — position book unverifiable, order stays quarantined`);
            continue;
          }
          if (order.side === 'BUY' && read.netQtyUnits > 0) {
            // The order book has no trace but the venue HOLDS the contract —
            // exactly the lost-fill/orphan scenario. Keep the row risk-bearing.
            const detail = `${trade.symbol} BUY missing from the order book but the venue holds ${read.netQtyUnits} unit(s) — possible lost fill`;
            alerts.manualReconciliation(trade.symbol, 'BUY', order.correlationId ?? String(order.id), detail);
            await activateRiskLatch(`unresolved-buy-position-exists:trade-${trade.id}`, detail);
            notes.push(`${trade.symbol} BUY: ${detail}`);
            continue;
          }
          if (order.side === 'SELL' && read.netQtyUnits <= 0) {
            // Position gone: this SELL (or the venue's own square-off) very
            // likely executed unseen. Terminal WITHOUT enabling a fresh SELL —
            // position-level reconcile closes the row from venue truth, and
            // exitTrade's flat pre-check blocks any racing SELL.
            const note = 'SELL missing from the order book but the position is flat at the venue — resolved position-level (no retry)';
            await updateOrder(order.id, { status: 'cancelled', error: `${order.error ? `${order.error}; ` : ''}${note}` });
            notes.push(`${trade.symbol} SELL: ${note}`);
            continue;
          }
          // BUY + verified flat → the placement provably never took effect.
          // SELL + position still held → the SELL never reached the venue; a
          // fresh attempt is safe. Both fall through to the give-up below.
        }
        const giveUp = `${order.error ? `${order.error}; ` : ''}never appeared in the broker order book after ${nextAttempt} checks (position book corroborated) — placement assumed failed`;
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
            order.brokerOrderId ?? order.correlationId ?? String(order.id),
            order.qtyUnits
          )
        : await applyExitState(
            order.id,
            trade,
            state,
            order.status !== 'unknown',
            order.brokerOrderId ?? order.correlationId ?? String(order.id),
            order.qtyUnits
          );
    if (outcome) notes.push(`${trade.symbol} ${order.side}: ${outcome.message}`);
  }
  return notes;
}
