/**
 * Dhan execution adapter — MARKET INTRADAY stock-option orders via raw Dhan V2
 * REST (the SDK is bypassed for the same reason as lib/dhan/market-feed.ts).
 * Auth reuses lib/dhan/auth.ts's TOTP token chain. A light serializer spaces
 * calls well below Dhan's current order-API limit and preserves ordering.
 *
 * Endpoints (document.json, parent repo):
 *   POST   /v2/orders          → { orderId, orderStatus }
 *   GET    /v2/orders/{id}     → { orderStatus, averageTradedPrice, omsErrorDescription, ... }
 *   DELETE /v2/orders/{id}     → cancel
 *   GET    /v2/fundlimit       → { availabelBalance } (Dhan's actual field spelling)
 */

import { getDhanAccessToken } from '@/lib/dhan/auth';
import { env } from '@/lib/env';
import {
  BrokerSubmissionError,
  type BrokerAdapter,
  type BrokerFunds,
  type BrokerNetPosition,
  type BrokerPositionQuery,
  type OrderState,
  type OrderTicket,
  type PlacedOrder,
  type RecoveredOrder,
} from './adapter';
import { ticketQtyUnits } from './adapter';

const TAG = '[DhanTrade]';
const BASE = 'https://api.dhan.co/v2';
const MIN_INTERVAL_MS = 300;
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const AMBIGUOUS_ORDER_CODES = new Set(['DH-904', 'DH-908', 'DH-909', '800', '805']);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const g = globalThis as unknown as {
  __dhanTradeGate?: { tail: Promise<unknown>; lastAt: number };
};
g.__dhanTradeGate ??= { tail: Promise.resolve(), lastAt: 0 };
const gate = g.__dhanTradeGate;

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

class DhanHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null
  ) {
    super(message);
    this.name = 'DhanHttpError';
  }
}

class DhanPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DhanPreflightError';
  }
}

/** GETs are safe to retry once. Mutating requests are never retried here: a
 * transient response after POST /orders is ambiguous and must be recovered by
 * correlationId before any new submission is considered. */
async function dhanFetch(pathname: string, init: { method: string; body?: unknown }): Promise<Record<string, unknown>> {
  let token: string;
  try {
    token = await getDhanAccessToken();
  } catch (err) {
    throw new DhanPreflightError(`${TAG} access token unavailable before request: ${(err as Error).message}`);
  }
  const clientId = env.DHAN_CLIENT_ID;
  if (!clientId) {
    throw new DhanPreflightError(`${TAG} DHAN_CLIENT_ID is not configured`);
  }

  const doFetch = async (): Promise<{ res: Response; text: string }> => {
    const res = await serial(() =>
      fetch(`${BASE}${pathname}`, {
        method: init.method,
        headers: {
          'access-token': token,
          'client-id': clientId,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
    );
    const text = await res.text();
    return { res, text };
  };

  let response: { res: Response; text: string };
  try {
    response = await doFetch();
  } catch (err) {
    if (init.method !== 'GET') throw err;
    console.warn(`${TAG} GET ${pathname} network failure, retrying once: ${(err as Error).message}`);
    await sleep(1000);
    response = await doFetch();
  }
  let { res, text } = response;

  if (init.method === 'GET' && RETRY_STATUS.has(res.status)) {
    console.warn(`${TAG} GET ${pathname} → ${res.status}, retrying once in 1s...`);
    await sleep(1000);
    ({ res, text } = await doFetch());
  }

  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    const remarks = data.remarks && typeof data.remarks === 'object' ? (data.remarks as Record<string, unknown>) : {};
    const codeValue = data.errorCode ?? data.internalErrorCode ?? remarks.error_code ?? remarks.errorCode;
    const code = codeValue == null ? null : String(codeValue);
    const detail = String(
      data.errorMessage ??
        data.internalErrorMessage ??
        remarks.error_message ??
        remarks.errorMessage ??
        text.slice(0, 200)
    );
    throw new DhanHttpError(
      `${TAG} ${init.method} ${pathname} → ${res.status}${code ? ` (${code})` : ''}: ${detail}`,
      res.status,
      code
    );
  }
  return data;
}

/** Dhan orderStatus → our OrderState.status. */
function mapStatus(orderStatus: string): OrderState['status'] {
  switch (orderStatus) {
    case 'TRADED':
      return 'filled';
    case 'REJECTED':
      return 'rejected';
    case 'CANCELLED':
    case 'EXPIRED':
      return 'cancelled';
    case 'TRANSIT':
    case 'PENDING':
    case 'PART_TRADED':
      return 'pending';
    default:
      return 'unknown';
  }
}

export class DhanAdapter implements BrokerAdapter {
  readonly id = 'dhan' as const;

  async getFunds(): Promise<BrokerFunds> {
    try {
      const data = await dhanFetch('/fundlimit', { method: 'GET' });
      const amount = Number(data.availabelBalance ?? data.availableBalance);
      return { available: Number.isFinite(amount) ? amount : null };
    } catch (err) {
      console.warn(`${TAG} fundlimit failed: ${(err as Error).message}`);
      return { available: null };
    }
  }

  async placeMarketOrder(ticket: OrderTicket): Promise<PlacedOrder> {
    // The caller supplies a persisted, deterministic, alphanumeric broker
    // correlation ID. It is the recovery key if the POST response is lost.
    let data: Record<string, unknown>;
    try {
      data = await dhanFetch('/orders', {
        method: 'POST',
        body: {
          dhanClientId: env.DHAN_CLIENT_ID,
          correlationId: ticket.correlationId,
          transactionType: ticket.side,
          exchangeSegment: 'NSE_FNO',
          productType: 'INTRADAY',
          orderType: 'MARKET',
          validity: 'DAY',
          securityId: ticket.optSecurityId,
          quantity: ticketQtyUnits(ticket),
          disclosedQuantity: 0,
          price: 0,
          afterMarketOrder: false,
        },
      });
    } catch (err) {
      const ambiguous =
        err instanceof DhanPreflightError
          ? false
          : !(err instanceof DhanHttpError) ||
            RETRY_STATUS.has(err.status) ||
            (err.code != null && AMBIGUOUS_ORDER_CODES.has(err.code));
      throw new BrokerSubmissionError((err as Error).message, ambiguous);
    }
    const orderId = String(data.orderId ?? '');
    if (!orderId) throw new BrokerSubmissionError(`${TAG} order response had no orderId`, true);
    if (String(data.orderStatus) === 'REJECTED') {
      throw new BrokerSubmissionError(`${TAG} order ${orderId} rejected at placement`, false);
    }
    return { brokerOrderId: orderId };
  }

  async getOrderByCorrelationId(correlationId: string): Promise<RecoveredOrder | null> {
    try {
      const data = await dhanFetch(`/orders/external/${encodeURIComponent(correlationId)}`, { method: 'GET' });
      const row = (Array.isArray(data) ? (data as Record<string, unknown>[])[0] : data) ?? {};
      const brokerOrderId = String(row.orderId ?? '');
      if (!brokerOrderId) return null;
      const status = mapStatus(String(row.orderStatus ?? ''));
      const price = Number(row.averageTradedPrice);
      const filledQty = Number(row.filledQty ?? row.tradedQuantity ?? row.filledQuantity);
      return {
        brokerOrderId,
        status,
        avgFillPrice: Number.isFinite(price) && price > 0 ? price : null,
        filledQtyUnits: Number.isFinite(filledQty) && filledQty > 0 ? filledQty : null,
        detail: row.omsErrorDescription ? String(row.omsErrorDescription) : undefined,
      };
    } catch (err) {
      if (err instanceof DhanHttpError && err.status === 404) return null;
      throw err;
    }
  }

  async getOrderState(brokerOrderId: string): Promise<OrderState> {
    try {
      const data = await dhanFetch(`/orders/${brokerOrderId}`, {
        method: 'GET',
      });
      // GET /orders/{id} returns the order object (some deployments wrap in an array).
      const row = (Array.isArray(data) ? (data as Record<string, unknown>[])[0] : data) ?? {};
      const status = mapStatus(String(row.orderStatus ?? ''));
      const price = Number(row.averageTradedPrice);
      const filledQty = Number(row.filledQty ?? row.tradedQuantity ?? row.filledQuantity);
      return {
        status,
        avgFillPrice: Number.isFinite(price) && price > 0 ? price : null,
        filledQtyUnits: Number.isFinite(filledQty) && filledQty > 0 ? filledQty : null,
        detail: row.omsErrorDescription ? String(row.omsErrorDescription) : undefined,
      };
    } catch (err) {
      return {
        status: 'unknown',
        avgFillPrice: null,
        detail: (err as Error).message,
      };
    }
  }

  async getNetPosition(query: BrokerPositionQuery): Promise<BrokerNetPosition | null> {
    try {
      const data = await dhanFetch('/positions', { method: 'GET' });
      // GET /positions returns an array of position objects for the day.
      const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
      const row = rows.find((p) => String(p.securityId) === query.optSecurityId);
      // A successful read with no row for the contract = definitively flat.
      if (!row) return { netQtyUnits: 0, sellAvg: null };
      const net = Number(row.netQty);
      const sellAvg = Number(row.sellAvg ?? row.sellAverage);
      return {
        netQtyUnits: Number.isFinite(net) ? net : 0,
        sellAvg: Number.isFinite(sellAvg) && sellAvg > 0 ? sellAvg : null,
      };
    } catch (err) {
      console.warn(`${TAG} positions lookup failed: ${(err as Error).message}`);
      return null;
    }
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    await dhanFetch(`/orders/${brokerOrderId}`, { method: 'DELETE' });
  }
}
