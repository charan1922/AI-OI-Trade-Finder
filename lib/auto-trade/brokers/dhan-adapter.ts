/**
 * Dhan execution adapter — MARKET INTRADAY stock-option orders via raw Dhan V2
 * REST (the SDK is bypassed for the same reason as lib/dhan/market-feed.ts).
 * Auth reuses lib/dhan/auth.ts's TOTP token chain. Order APIs allow 25 req/s —
 * a light serializer still spaces calls, matching the repo's no-parallel-Dhan
 * rule.
 *
 * Endpoints (document.json, parent repo):
 *   POST   /v2/orders          → { orderId, orderStatus }
 *   GET    /v2/orders/{id}     → { orderStatus, averageTradedPrice, omsErrorDescription, ... }
 *   DELETE /v2/orders/{id}     → cancel
 *   GET    /v2/fundlimit       → { availabelBalance } (Dhan's actual field spelling)
 */

import { getDhanAccessToken } from '@/lib/dhan/auth';
import { env } from '@/lib/env';
import type { BrokerAdapter, BrokerFunds, OrderState, OrderTicket, PlacedOrder } from './adapter';
import { ticketQtyUnits } from './adapter';

const TAG = '[DhanTrade]';
const BASE = 'https://api.dhan.co/v2';
const MIN_INTERVAL_MS = 300;
const RETRY_STATUS = new Set([429, 502, 503, 504]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const g = globalThis as unknown as { __dhanTradeGate?: { tail: Promise<unknown>; lastAt: number } };
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
    () => undefined,
  );
  return run;
}

/** Single retry on transient HTTP errors (502/503/504/429) — Dhan and Railway
 *  occasionally return these under load. One retry is enough; persistent
 *  failures surface immediately. */
async function dhanFetch(pathname: string, init: { method: string; body?: unknown }): Promise<Record<string, unknown>> {
  const token = await getDhanAccessToken();
  const clientId = env.DHAN_CLIENT_ID;
  if (!clientId) throw new Error(`${TAG} DHAN_CLIENT_ID is not configured`);

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
      }),
    );
    const text = await res.text();
    return { res, text };
  };

  let { res, text } = await doFetch();

  // One retry on transient errors
  if (RETRY_STATUS.has(res.status)) {
    console.warn(`${TAG} ${init.method} ${pathname} → ${res.status}, retrying in 1s...`);
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
    const detail = String(data.errorMessage ?? data.internalErrorMessage ?? text.slice(0, 200));
    throw new Error(`${TAG} ${init.method} ${pathname} → ${res.status}: ${detail}`);
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
    // Dhan's live API rejects any correlationId with non-alphanumeric chars
    // ("400: Invalid correlationId") even though the OpenAPI spec only caps
    // length at 30. Our idemKey has colons/hyphens (e.g. 2026-07-13:LTF:CE:…),
    // so strip to alphanumerics. Determinism is preserved (same idemKey → same
    // id); real idempotency is enforced by the auto_orders UNIQUE idemKey, not
    // by this broker-side tracking tag.
    const correlationId = ticket.idemKey.replace(/[^a-zA-Z0-9]/g, '').slice(0, 25);
    const data = await dhanFetch('/orders', {
      method: 'POST',
      body: {
        dhanClientId: env.DHAN_CLIENT_ID,
        correlationId,
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
    const orderId = String(data.orderId ?? '');
    if (!orderId) throw new Error(`${TAG} order accepted but no orderId in response`);
    if (String(data.orderStatus) === 'REJECTED') {
      throw new Error(`${TAG} order ${orderId} rejected at placement`);
    }
    return { brokerOrderId: orderId };
  }

  async getOrderState(brokerOrderId: string): Promise<OrderState> {
    try {
      const data = await dhanFetch(`/orders/${brokerOrderId}`, { method: 'GET' });
      // GET /orders/{id} returns the order object (some deployments wrap in an array).
      const row = (Array.isArray(data) ? (data as Record<string, unknown>[])[0] : data) ?? {};
      const status = mapStatus(String(row.orderStatus ?? ''));
      const price = Number(row.averageTradedPrice);
      return {
        status,
        avgFillPrice: status === 'filled' && Number.isFinite(price) && price > 0 ? price : null,
        detail: row.omsErrorDescription ? String(row.omsErrorDescription) : undefined,
      };
    } catch (err) {
      return { status: 'unknown', avgFillPrice: null, detail: (err as Error).message };
    }
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    await dhanFetch(`/orders/${brokerOrderId}`, { method: 'DELETE' });
  }
}
