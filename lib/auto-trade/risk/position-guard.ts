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

import { alerts } from '../alerts';
import { isPastSquareOff, minuteOfDayIST, nowIST } from '../config';
import { exitTrade } from '../execution';
import { fetchOptionQuote, latestSpot } from '../quotes';
import { getOpenTrades, getOrdersForTrade, updateTrade } from '../store';
import type { AutoTrade } from '../types';
import { supertrend } from '@/lib/signals/indicators';
import { getFyersCandles } from '@/lib/fyers/candle-store';

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

/** Max age (ms) for an open trade with no confirmed fill. After this, the
 *  entry is considered lost — mark it failed rather than let it linger as
 *  an unmanaged phantom. Reconcile normally resolves fills within seconds;
 *  5 min = one poller cycle. */
const UNFILLED_STALE_MS = 5 * 60 * 1000;

/** Consecutive exit failures before escalating to a loud warning. */
const EXIT_FAILURE_ESCALATE = 3;

/** Trailing stop: once premium gains this %, move SL to entry (risk-free). */
const TRAIL_STOP_TRIGGER_PCT = 30;


/** Check every open trade against the hard exit rules; exit what must exit.
 *  Returns a human-readable action list for the audit log. */
export async function runPositionGuard(date: string): Promise<string[]> {
  const open = await getOpenTrades();
  if (open.length === 0) return [];
  const actions: string[] = [];
  const squareOff = isPastSquareOff(minuteOfDayIST());
  const now = nowIST();

  for (const trade of open) {
    // A trade is 'open' only briefly before its entry fill is confirmed
    // (reconcile / the entry poll resolves it). NEVER try to exit one with no
    // confirmed fill — there is no real position to sell, and a SELL here would
    // open a naked short at the broker. Leave it for reconcile to settle/fail.
    if (trade.entryFillPremium == null) {
      // Staleness check: if the trade has been open without a fill for >5 min,
      // the entry is likely lost (broker flake, network blip). Fail it rather
      // than let it linger as an unmanaged phantom with no broker order.
      const openedMs = trade.openedAt ? new Date(trade.openedAt).getTime() : new Date(trade.proposedAt).getTime();
      if (now.getTime() - openedMs > UNFILLED_STALE_MS) {
        await updateTrade(trade.id, { status: 'failed', exitReason: 'entry fill not confirmed after 5 min — stale phantom' });
        const line = `${trade.symbol} ${trade.optionType}: entry fill unconfirmed for >5 min → FAILED (stale phantom)`;
        actions.push(line);
        console.warn(`[PositionGuard] ⚠️ ${line}`);
        alerts.stalePhantom(trade.symbol);
      }
      continue;
    }

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

        // Trailing stop: once premium gains TRAIL_STOP_TRIGGER_PCT%, tighten
        // SL to entry fill price (risk-free trade). Only tightens — never loosens.
        if (!reason && trade.entryFillPremium > 0) {
          const gainPct = ((quote.ltp - trade.entryFillPremium) / trade.entryFillPremium) * 100;
          if (gainPct >= TRAIL_STOP_TRIGGER_PCT && trade.slPremium < trade.entryFillPremium) {
            await updateTrade(trade.id, { slPremium: trade.entryFillPremium });
            const line = `${trade.symbol} ${trade.optionType}: trailing stop → SL tightened to entry ₹${trade.entryFillPremium} (+${gainPct.toFixed(0)}% gain)`;
            actions.push(line);
            console.log(`${TAG} ${line}`);
          }
        }

        // Momentum exit: if Supertrend flips against the trade AND premium
        // has dropped below entry (giveback of gains), exit to protect capital.
        if (!reason) {
          try {
            const bars = await getFyersCandles(trade.symbol, date, 'EQ');
            const st = supertrend(bars);
            if (st != null) {
              const bullish = trade.direction === 'bullish';
              const stFlipped = bullish ? st.direction === 'down' : st.direction === 'up';
              if (stFlipped && quote.ltp < trade.entryFillPremium) {
                reason = `momentum exit: Supertrend flipped ${st.direction} + premium ₹${quote.ltp} below entry ₹${trade.entryFillPremium}`;
              }
            }
          } catch {
            // Supertrend check is best-effort — don't fail the guard
          }
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

      // Fire alerts for exits
      if (outcome.ok) {
        alerts.tradeExited(trade.symbol, reason, null);
        if (squareOff) alerts.eodSquareOff(trade.symbol);
      }

      // Exit failure escalation: if the exit order failed, count consecutive
      // failures for this trade and escalate after EXIT_FAILURE_ESCALATE.
      if (!outcome.ok) {
        const exitOrders = (await getOrdersForTrade(trade.id)).filter((o) => o.side === 'SELL');
        const consecutiveFails = exitOrders.filter((o) => o.status === 'rejected' || (o.status === 'sent' && o.error)).length;
        if (consecutiveFails >= EXIT_FAILURE_ESCALATE) {
          const esc = `⚠️ ${trade.symbol} ${trade.optionType}: ${consecutiveFails} consecutive exit failures — MANUAL INTERVENTION NEEDED`;
          actions.push(esc);
          console.error(`[PositionGuard] 🚨 ${esc}`);
          alerts.exitFailureEscalation(trade.symbol, consecutiveFails);
        }
      }
    }
  }
  return actions;
}
