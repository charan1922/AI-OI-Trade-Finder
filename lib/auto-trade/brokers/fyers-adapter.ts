/**
 * Fyers execution adapter — MARKET INTRADAY stock-option orders via the
 * fyers-api-v3 SDK already used by the data recorder (same TOTP auth chain,
 * lib/fyers/auth.ts). Order calls run through their own tiny serializer so we
 * never issue two trading calls concurrently (the data poller has its own gate).
 *
 * Symbology: monthly stock option = "NSE:RELIANCE25AUG3000CE" — underlying +
 * 2-digit year + 3-letter month (from the pick's OPTSTK expiryDate, no
 * last-Thursday math) + strike + CE/PE. Same style the recorder uses for
 * futures (lib/fyers/symbols.ts).
 *
 * Fyers order status codes (orderBook rows): 1=Cancelled, 2=Traded/Filled,
 * 4=Transit, 5=Rejected, 6=Pending. Fill price is `tradedPrice`.
 */

import path from 'node:path';
import { fyersModel } from 'fyers-api-v3';
import { fyersAppId, getFyersAccessToken } from '@/lib/fyers/auth';
import {
  BrokerSubmissionError,
  type BrokerAdapter,
  type BrokerFunds,
  type OrderState,
  type OrderTicket,
  type PlacedOrder,
  type RecoveredOrder,
} from './adapter';
import { ticketQtyUnits } from './adapter';

const TAG = '[FyersTrade]';
const MONTH_CODES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MIN_INTERVAL_MS = 600;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Serial gate on globalThis (Turbopack HMR re-evaluates modules — same
// rationale as lib/fyers/client.ts).
const g = globalThis as unknown as {
  __fyersTradeGate?: { tail: Promise<unknown>; lastAt: number };
  __fyersTradeModel?: fyersModel;
};
g.__fyersTradeGate ??= { tail: Promise.resolve(), lastAt: 0 };
const gate = g.__fyersTradeGate;

function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = gate.tail.then(async (): Promise<T> => {
    const wait = gate.lastAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    gate.lastAt = Date.now();
    return task();
  });
  gate.tail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function getFyers(): Promise<fyersModel> {
  if (!g.__fyersTradeModel) {
    g.__fyersTradeModel = new fyersModel({
      path: path.join(process.cwd(), 'data'),
      enableLogging: false,
    });
  }
  const fyers = g.__fyersTradeModel;
  fyers.setAppId(fyersAppId());
  fyers.setAccessToken(await getFyersAccessToken());
  return fyers;
}

/** "NSE:RELIANCE25AUG3000CE" — strike printed as-is (fractional strikes keep
 *  their decimal, whole strikes have none). */
export function toFyersOptionSymbol(t: Pick<OrderTicket, 'symbol' | 'optionType' | 'strike' | 'expiryDate'>): string {
  const exp = new Date(`${t.expiryDate}T00:00:00`);
  if (Number.isNaN(exp.getTime())) throw new Error(`${TAG} invalid expiryDate: ${t.expiryDate}`);
  const yy = String(exp.getFullYear() % 100).padStart(2, '0');
  return `NSE:${t.symbol}${yy}${MONTH_CODES[exp.getMonth()]}${t.strike}${t.optionType}`;
}

export class FyersAdapter implements BrokerAdapter {
  readonly id = 'fyers' as const;

  async getFunds(): Promise<BrokerFunds> {
    try {
      const fyers = await getFyers();
      const res = await serial(() => fyers.get_funds());
      if (!res || res.s !== 'ok') return { available: null };
      // fund_limit rows: id 10 = "Available Balance" (equityAmount holds the ₹).
      const rows = Array.isArray(res.fund_limit) ? (res.fund_limit as Record<string, unknown>[]) : [];
      const avail = rows.find((r) => Number(r.id) === 10) ?? rows.find((r) => /available/i.test(String(r.title ?? '')));
      const amount = Number(avail?.equityAmount);
      return { available: Number.isFinite(amount) ? amount : null };
    } catch (err) {
      console.warn(`${TAG} get_funds failed: ${(err as Error).message}`);
      return { available: null };
    }
  }

  async placeMarketOrder(ticket: OrderTicket): Promise<PlacedOrder> {
    let fyers: fyersModel;
    try {
      fyers = await getFyers();
    } catch (err) {
      throw new BrokerSubmissionError(
        `${TAG} credentials unavailable before placement: ${(err as Error).message}`,
        false
      );
    }
    const req = {
      symbol: toFyersOptionSymbol(ticket),
      qty: ticketQtyUnits(ticket),
      type: 2, // MARKET
      side: ticket.side === 'BUY' ? 1 : -1,
      productType: 'INTRADAY',
      limitPrice: 0,
      stopPrice: 0,
      validity: 'DAY',
      disclosedQty: 0,
      offlineOrder: false,
      // Fyers orderTag is alphanumeric only (and shouldn't lead with a digit) —
      // our idemKey has colons/hyphens, so strip and prefix a letter. Mirrors
      // the Dhan correlationId fix; real idempotency is the DB UNIQUE idemKey.
      orderTag: ticket.correlationId,
    };
    let res: Record<string, unknown>;
    try {
      res = await serial(() => fyers.place_order(req));
    } catch (err) {
      // SDK rejects with { s:'error', code, message } via its errorHandler.
      const e = (err ?? {}) as Record<string, unknown>;
      throw new BrokerSubmissionError(`${TAG} place_order failed: ${String(e.message ?? e)}`, true);
    }
    const orderId = String(res?.id ?? '');
    if (res?.s !== 'ok' || !orderId) {
      throw new BrokerSubmissionError(
        `${TAG} place_order rejected: ${String(res?.message ?? JSON.stringify(res ?? {}).slice(0, 200))}`,
        false
      );
    }
    return { brokerOrderId: orderId };
  }

  async getOrderState(brokerOrderId: string): Promise<OrderState> {
    try {
      const fyers = await getFyers();
      // NOTE: get_orders() fetches the ENTIRE day's order book. The Fyers SDK
      // (fyers-api-v3) does not expose a single-order query endpoint — every
      // call returns all orders. The serial gate + MIN_INTERVAL_MS keep this
      // bounded; if perf becomes an issue, consider caching the book for a few
      // seconds on globalThis.
      const res = await serial(() => fyers.get_orders());
      if (!res || res.s !== 'ok')
        return {
          status: 'unknown',
          avgFillPrice: null,
          detail: 'orderbook unavailable',
        };
      const book = Array.isArray(res.orderBook) ? (res.orderBook as Record<string, unknown>[]) : [];
      const row = book.find((o) => String(o.id) === brokerOrderId);
      if (!row)
        return {
          status: 'unknown',
          avgFillPrice: null,
          detail: "order not in today's book",
        };
      const price = Number(row.tradedPrice);
      const fill = Number.isFinite(price) && price > 0 ? price : null;
      const filledQty = Number(row.filledQty ?? row.tradedQty);
      const filledQtyUnits = Number.isFinite(filledQty) && filledQty > 0 ? filledQty : null;
      switch (Number(row.status)) {
        case 2:
          return { status: 'filled', avgFillPrice: fill, filledQtyUnits };
        case 5:
          return {
            status: 'rejected',
            avgFillPrice: fill,
            filledQtyUnits,
            detail: String(row.message ?? 'rejected'),
          };
        case 1:
          return { status: 'cancelled', avgFillPrice: fill, filledQtyUnits };
        case 4:
        case 6:
          return { status: 'pending', avgFillPrice: fill, filledQtyUnits };
        default:
          return {
            status: 'unknown',
            avgFillPrice: fill,
            filledQtyUnits,
            detail: `status code ${String(row.status)}`,
          };
      }
    } catch (err) {
      return {
        status: 'unknown',
        avgFillPrice: null,
        detail: (err as Error).message,
      };
    }
  }

  async getOrderByCorrelationId(correlationId: string): Promise<RecoveredOrder | null> {
    const fyers = await getFyers();
    const res = await serial(() => fyers.get_orders());
    if (!res || res.s !== 'ok') throw new Error(`${TAG} orderbook unavailable during tag recovery`);
    const book = Array.isArray(res.orderBook) ? (res.orderBook as Record<string, unknown>[]) : [];
    const row = book.find((o) => String(o.orderTag ?? '') === correlationId);
    if (!row) return null;
    const brokerOrderId = String(row.id ?? '');
    if (!brokerOrderId) return null;
    const price = Number(row.tradedPrice);
    const fill = Number.isFinite(price) && price > 0 ? price : null;
    const filledQty = Number(row.filledQty ?? row.tradedQty);
    const filledQtyUnits = Number.isFinite(filledQty) && filledQty > 0 ? filledQty : null;
    let status: OrderState['status'] = 'unknown';
    switch (Number(row.status)) {
      case 2:
        status = 'filled';
        break;
      case 5:
        status = 'rejected';
        break;
      case 1:
        status = 'cancelled';
        break;
      case 4:
      case 6:
        status = 'pending';
        break;
    }
    return {
      brokerOrderId,
      status,
      avgFillPrice: fill,
      filledQtyUnits,
      detail: row.message ? String(row.message) : undefined,
    };
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    const fyers = await getFyers();
    const res = await serial(() => fyers.cancel_order({ id: brokerOrderId }));
    if (res?.s !== 'ok') {
      throw new Error(`${TAG} cancel_order failed: ${String(res?.message ?? 'unknown error')}`);
    }
  }
}
