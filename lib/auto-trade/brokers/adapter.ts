/**
 * BrokerAdapter — the contract every execution venue implements (paper, Fyers,
 * Dhan). The engine and tools only ever talk to this interface; broker
 * symbology, auth, and response quirks live inside each adapter.
 *
 * Scope is deliberately minimal: MARKET orders on stock options, INTRADAY
 * product, buy-to-open / sell-to-close. No limit orders, no shorting, no
 * baskets — defined-risk long options only (the strategy's instrument).
 */

import type { OrderSide } from '../types';

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
  detail?: string;
}

export interface BrokerFunds {
  /** Available balance in ₹, or null when the venue can't say. */
  available: number | null;
}

export interface BrokerAdapter {
  readonly id: 'paper' | 'fyers' | 'dhan';
  getFunds(): Promise<BrokerFunds>;
  /** Place a MARKET INTRADAY order. Throws with a clear message on rejection
   *  at the API layer; returns the broker's order id otherwise. */
  placeMarketOrder(ticket: OrderTicket): Promise<PlacedOrder>;
  getOrderState(brokerOrderId: string): Promise<OrderState>;
  cancelOrder(brokerOrderId: string): Promise<void>;
}

/** qty the exchange wants: units (shares), always whole lot multiples. */
export function ticketQtyUnits(t: OrderTicket): number {
  return t.lots * t.lotSize;
}
