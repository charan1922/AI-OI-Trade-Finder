/**
 * Paper broker — simulated fills at REAL live quotes (never fabricated: a BUY
 * fills at the live ask, a SELL at the live bid, LTP when the book is empty;
 * no quote at all → the order FAILS, same as a dead venue would).
 *
 * Funds are virtual: the configured capital budget minus what's deployed —
 * reported by the engine, not tracked here (the adapter stays stateless).
 */

import { fetchOptionQuote } from '../quotes';
import type { BrokerAdapter, BrokerFunds, OrderState, OrderTicket, PlacedOrder } from './adapter';

export class PaperAdapter implements BrokerAdapter {
  readonly id = 'paper' as const;

  async getFunds(): Promise<BrokerFunds> {
    return { available: null }; // engine reports budget-minus-deployed for paper
  }

  async placeMarketOrder(ticket: OrderTicket): Promise<PlacedOrder> {
    const quote = await fetchOptionQuote(ticket.optSecurityId);
    if (!quote) {
      throw new Error(`paper: no live quote for ${ticket.symbol} ${ticket.strike}${ticket.optionType} — order not filled`);
    }
    const fill = ticket.side === 'BUY' ? (quote.ask ?? quote.ltp) : (quote.bid ?? quote.ltp);
    return { brokerOrderId: `paper-${ticket.idemKey}`, immediateFillPrice: fill };
  }

  async getOrderState(): Promise<OrderState> {
    // Paper orders fill synchronously in placeMarketOrder; nothing is pending.
    return { status: 'filled', avgFillPrice: null, detail: 'paper orders fill at placement' };
  }

  async cancelOrder(): Promise<void> {
    // Nothing to cancel — paper orders are never resting.
  }
}
