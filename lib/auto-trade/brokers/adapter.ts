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
  /** When set, the order is sent for exactly this many units instead of
   *  lots × lotSize. Used for reduced-quantity exits: a SELL must never exceed
   *  the quantity the venue verifiably holds (broker-truth invariant). */
  qtyUnitsOverride?: number;
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

/**
 * Discriminated position-truth read. `verified` means the venue's book was
 * read successfully AND the quantity parsed strictly — 0 is a REAL flat, a
 * negative number is a REAL short. `unavailable` means the venue cannot say
 * (endpoint failed, row malformed, quantity field missing/non-numeric) —
 * callers must NEVER treat it as flat. This shape exists because the old
 * `Number.isFinite(net) ? net : 0` fallback silently turned a malformed
 * broker payload into "position closed" (AT-001, gap analysis 2026-07-20).
 */
export type BrokerPositionRead =
  | {
      kind: 'verified';
      /** Net units the venue holds RIGHT NOW; 0 = flat, < 0 = unexpected short. */
      netQtyUnits: number;
      /** Venue-reported average sell price for the day, when available — the best
       *  estimate of the exit fill when the broker squared off without us. */
      sellAvg: number | null;
    }
  | { kind: 'unavailable'; reason: string };

/**
 * The venue's OWN profit/loss for the session — broker truth, not our books.
 *
 * SCOPE WARNING, read before using this for anything that blocks a trade: this
 * counts EVERY fill the account made today, including manual orders the
 * operator placed in the broker's own app. It is truth about the ACCOUNT, and
 * it is NOT this module's P&L. `dailyRealizedPnl()` (auto_trades) remains the
 * only figure that is purely ours. Use this to CROSS-CHECK ours, never to
 * silently replace it — a manual trade would otherwise trip the bot's halt.
 *
 * `unavailable` means the venue could not say. Callers must never read that as
 * "flat" or "zero" — same fail-closed contract as BrokerPositionRead.
 */
export type BrokerPnlRead =
  | {
      kind: 'verified';
      /** Booked P&L in ₹ on closed quantity, as the venue reports it. */
      realized: number;
      /** Mark-to-market on still-open quantity; null when the venue omits it. */
      unrealized: number | null;
      /** The venue's own total (realized + unrealized where it reports both). */
      total: number;
    }
  | { kind: 'unavailable'; reason: string };

/**
 * One order that is still LIVE at the venue (accepted, not yet filled,
 * cancelled or rejected). Used to diagnose a blocked exit: a resting SELL on
 * the same contract makes our own SELL look like a fresh naked short to the
 * risk engine, which then refuses it for margin the account will never have.
 */
export interface BrokerOpenOrder {
  brokerOrderId: string;
  /** The venue's own symbol string for the contract. */
  rawSymbol: string;
  side: 'BUY' | 'SELL';
  /** Units the order is for; null when the venue does not report it. */
  qtyUnits: number | null;
}

/** One row of the venue's live intraday F&O position book (orphan scan). */
export interface BrokerBookPosition {
  /** The venue's own symbol for the contract (audit + Fyers matching). */
  rawSymbol: string;
  /** Dhan security id when the venue reports one (Dhan matching); else null. */
  securityId: string | null;
  /** Strictly parsed net units; null = the row had NO parseable quantity —
   *  callers must treat that as an incident, never as flat. */
  netQtyUnits: number | null;
}

/**
 * Strict quantity parser: only a value that converts to a FINITE number counts.
 * Missing fields, null, '' and non-numeric strings all return null — the
 * caller must decide what "cannot parse" means (usually: fail closed).
 */
export function parseFiniteNumber(row: Record<string, unknown>, fields: string[]): number | null {
  for (const name of fields) {
    const raw = row[name];
    if (raw === null || raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return null;
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
  /** Position-level truth for one contract. Always returns the discriminated
   *  BrokerPositionRead — see its doc for the verified/unavailable contract. */
  getNetPosition?(query: BrokerPositionQuery): Promise<BrokerPositionRead>;
  /** The venue's full intraday NSE F&O position book (orphan discovery:
   *  "which live positions exist that we have NO local trade for?").
   *  Null = the book could not be read — never proof that nothing exists. */
  listNetPositions?(): Promise<BrokerBookPosition[] | null>;
  /** The venue's own P&L for the session — broker truth used to CROSS-CHECK
   *  our computed figure. See BrokerPnlRead for the account-vs-module scope
   *  warning before wiring this into any gate. */
  getBrokerPnl?(): Promise<BrokerPnlRead>;
  /** Orders still LIVE at the venue. Null = the book could not be read, which
   *  is never proof that none exist. Diagnostic only — callers must not treat
   *  an empty list as permission to do anything. */
  listOpenOrders?(): Promise<BrokerOpenOrder[] | null>;
  cancelOrder(brokerOrderId: string): Promise<void>;
}

/** qty the exchange wants: units (shares), always whole lot multiples unless
 *  a reduced-exit override caps the SELL at the venue's verified holding. */
export function ticketQtyUnits(t: OrderTicket): number {
  return t.qtyUnitsOverride ?? t.lots * t.lotSize;
}
