/**
 * BrokerAdapter — the contract every execution venue implements (paper, Fyers,
 * Dhan). The engine and tools only ever talk to this interface; broker
 * symbology, auth, and response quirks live inside each adapter.
 *
 * Scope is deliberately minimal: MARKET orders on stock options, INTRADAY
 * product, buy-to-open / sell-to-close. No limit orders, no shorting, no
 * baskets — defined-risk long options only (the strategy's instrument).
 */

import { createHash } from 'node:crypto';
import type { OrderSide } from '../types';

/** Broker-safe alphanumeric tag (20 chars, valid for Dhan and Fyers), derived
 *  deterministically from the order's idempotency key. Lives here (not in
 *  execution.ts) so the store can persist it inside the atomic order claim
 *  without an import cycle. */
export function correlationIdForOrder(idemKey: string): string {
  return `R${createHash('sha256').update(idemKey).digest('hex').slice(0, 19)}`;
}

/** Everything an adapter needs to route one order. The full contract identity
 *  travels with the ticket so each adapter maps its own symbology (Dhan wants
 *  the securityId; Fyers wants "NSE:RELIANCE25AUG3000CE"). */
export interface OrderTicket {
  side: OrderSide;
  symbol: string; // underlying, e.g. RELIANCE
  optionType: 'CE' | 'PE';
  strike: number;
  expiryDate: string; // YYYY-MM-DD (from master_contracts OPTSTK row)
  optSecurityId: string; // Dhan security id
  lotSize: number;
  lots: number;
  /** Deterministic idempotency key — adapters pass it as correlation/tag where
   *  the API supports one; the store enforces uniqueness before placement. */
  idemKey: string;
  /** Broker-safe deterministic tag persisted before submission. It is the
   *  recovery key when the venue accepted an order but the response was lost. */
  correlationId: string;
}

export interface PlacedOrder {
  brokerOrderId: string;
  /** Set when the venue fills synchronously (paper). Live venues leave this
   *  undefined and the engine polls getOrderState. */
  immediateFillPrice?: number;
}

export interface OrderState {
  status: 'filled' | 'pending' | 'rejected' | 'cancelled' | 'unknown';
  avgFillPrice: number | null;
  /** Executed units when the venue reports them. A terminal status with a
   * positive partial quantity is never treated as a clean rejection/cancel. */
  filledQtyUnits?: number | null;
  detail?: string;
}

export interface RecoveredOrder extends OrderState {
  brokerOrderId: string;
}

/** The caller cannot prove whether a placement reached the broker. */
export class BrokerSubmissionError extends Error {
  constructor(
    message: string,
    readonly ambiguous: boolean
  ) {
    super(message);
    this.name = 'BrokerSubmissionError';
  }
}

export interface BrokerFunds {
  /** Available balance in ₹, or null when the venue can't say. */
  available: number | null;
}

/** Contract identity for a position-truth lookup (same fields the ticket carries). */
export interface BrokerPositionQuery {
  symbol: string;
  optionType: 'CE' | 'PE';
  strike: number;
  expiryDate: string;
  optSecurityId: string;
}

export interface BrokerNetPosition {
  /** Net units the venue holds RIGHT NOW; 0 = flat (position closed/absent). */
  netQtyUnits: number;
  /** Venue-reported average sell price for the day, when available — the best
   *  estimate of the exit fill when the broker squared off without us. */
  sellAvg: number | null;
}

export interface BrokerAdapter {
  readonly id: 'paper' | 'fyers' | 'dhan';
  getFunds(): Promise<BrokerFunds>;
  /** Place a MARKET INTRADAY order. Throws with a clear message on rejection
   *  at the API layer; returns the broker's order id otherwise. */
  placeMarketOrder(ticket: OrderTicket): Promise<PlacedOrder>;
  getOrderState(brokerOrderId: string): Promise<OrderState>;
  /** Recover a placement response by its durable broker tag. Null means the
   *  venue returned no match; throwing means the lookup itself was unavailable. */
  getOrderByCorrelationId?(correlationId: string): Promise<RecoveredOrder | null>;
  /** Position-level truth for one contract. Null means the venue CANNOT say
   *  (lookup failed / unsupported) — callers must NEVER treat null as flat.
   *  A definite { netQtyUnits: 0 } means the venue read succeeded and the
   *  contract is flat (e.g. the broker's own intraday square-off already ran). */
  getNetPosition?(query: BrokerPositionQuery): Promise<BrokerNetPosition | null>;
  cancelOrder(brokerOrderId: string): Promise<void>;
}

/** qty the exchange wants: units (shares), always whole lot multiples. */
export function ticketQtyUnits(t: OrderTicket): number {
  return t.lots * t.lotSize;
}
