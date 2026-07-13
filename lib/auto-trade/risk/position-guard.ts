/**
 * Deterministic position guard — the code backstop that guarantees every open
 * position has a working exit EVEN IF THE AI IS DOWN. Runs at the start of
 * every engine pass, BEFORE any model call, and enforces:
 *
 *   1. EOD square-off at/after 15:12 IST — no position survives into the
 *      broker's forced-square-off penalty window.
 *   2. Premium stop  (slPremium: tighter of −40% and −₹1.5k/lot, re-anchored
 *      to the actual fill) and premium target (+₹5k/lot).
 *   3. Spot stop / spot target from the scanner plan (latest 5-min close in
 *      fyers_candles) — the level the AI manages; it may only ever TIGHTEN.
 *
 * The AI can exit EARLIER than any of these (thesis broken etc.) — the guard
 * only makes sure an exit always exists. Kill switch does NOT stop the guard:
 * exits reduce risk and always stay allowed.
 */

import { isPastSquareOff, minuteOfDayIST } from '../config';
import { exitTrade } from '../execution';
import { fetchOptionQuote, latestSpot } from '../quotes';
import { getOpenTrades } from '../store';
import type { AutoTrade } from '../types';

const TAG = '[PositionGuard]';

function spotExitReason(trade: AutoTrade, spot: number): string | null {
  const bullish = trade.direction === 'bullish';
  if (trade.slSpot != null && (bullish ? spot <= trade.slSpot : spot >= trade.slSpot)) {
    return `spot stop hit (spot ${spot} vs SL ${trade.slSpot})`;
  }
  if (trade.targetSpot != null && (bullish ? spot >= trade.targetSpot : spot <= trade.targetSpot)) {
    return `spot target hit (spot ${spot} vs target ${trade.targetSpot})`;
  }
  return null;
}

/** Check every open trade against the hard exit rules; exit what must exit.
 *  Returns a human-readable action list for the audit log. */
export async function runPositionGuard(date: string): Promise<string[]> {
  const open = await getOpenTrades();
  if (open.length === 0) return [];
  const actions: string[] = [];
  const squareOff = isPastSquareOff(minuteOfDayIST());

  for (const trade of open) {
    // A trade is 'open' only briefly before its entry fill is confirmed
    // (reconcile / the entry poll resolves it). NEVER try to exit one with no
    // confirmed fill — there is no real position to sell, and a SELL here would
    // open a naked short at the broker. Leave it for reconcile to settle/fail.
    if (trade.entryFillPremium == null) continue;

    let reason: string | null = null;

    if (squareOff) {
      reason = 'EOD square-off (15:12 IST)';
    } else {
      // Premium backstops — the primary deterministic exit (we HOLD premium).
      const quote = await fetchOptionQuote(trade.optSecurityId);
      if (quote) {
        if (quote.ltp <= trade.slPremium) {
          reason = `premium stop hit (₹${quote.ltp} ≤ ₹${trade.slPremium})`;
        } else if (quote.ltp >= trade.targetPremium) {
          reason = `premium target hit (₹${quote.ltp} ≥ ₹${trade.targetPremium})`;
        }
      }
      // Spot plan levels (scanner's structure-based stop, AI-tightened).
      if (!reason) {
        const spot = await latestSpot(trade.symbol, date);
        if (spot != null) reason = spotExitReason(trade, spot);
      }
    }

    if (reason) {
      const outcome = await exitTrade(trade, reason);
      const line = `${trade.symbol} ${trade.optionType}: ${reason} → ${outcome.message}`;
      actions.push(line);
      console.log(`${TAG} ${line}`);
    }
  }
  return actions;
}
