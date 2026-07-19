/**
 * Deterministic position guard — the code backstop that monitors every
 * confirmed open position and attempts required exits even if the AI is down.
 * Runs at the start of
 * every engine pass, BEFORE any model call, and enforces:
 *
 *   1. EOD square-off at/after the configured IST time — no position survives into the
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
import { isPastSquareOff, istMinuteLabel, minuteOfDayIST } from '../config';
import { exitTrade } from '../execution';
import { fetchOptionQuotes, latestSpot, type OptionQuote } from '../quotes';
import { getAutoTradeSettings } from '../settings';
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

/** Consecutive exit failures before escalating to a loud warning. */
const EXIT_FAILURE_ESCALATE = 3;

/** Trailing stop: once premium gains this %, move SL to entry (risk-free). */
const TRAIL_STOP_TRIGGER_PCT = 30;

interface PositionGuardCoreResult {
  actions: string[];
  optionQuotes: ReadonlyMap<string, OptionQuote>;
  attemptedOptionIds: ReadonlySet<string>;
  spotBySymbol: ReadonlyMap<string, number | null>;
}

export interface PositionGuardResult extends PositionGuardCoreResult {
  /** True when this caller joined a guard run that another caller started. */
  coalesced: boolean;
}

const guardHost = globalThis as unknown as {
  __positionGuardInFlight?: Promise<PositionGuardCoreResult>;
};

/** Check every open trade against the hard exit rules; exit what must exit.
 *  Returns a human-readable action list for the audit log. */
async function runPositionGuardCore(date: string): Promise<PositionGuardCoreResult> {
  const open = await getOpenTrades();
  if (open.length === 0) {
    return {
      actions: [],
      optionQuotes: new Map(),
      attemptedOptionIds: new Set(),
      spotBySymbol: new Map(),
    };
  }
  const actions: string[] = [];
  // Square-off time from settings (clamped ≤ 15:20; getAutoTradeSettings fails
  // safe to the 15:12 default on a DB hiccup).
  const { squareOffMin } = await getAutoTradeSettings();
  const squareOff = isPastSquareOff(minuteOfDayIST(), squareOffMin);
  const attemptedOptionIds = new Set(
    open
      .filter((trade) => trade.entryFillPremium != null)
      .map((trade) => Number(trade.optSecurityId))
      .filter((id) => Number.isFinite(id) && id > 0)
      .map(String)
  );
  const optionQuotes = squareOff ? new Map<string, OptionQuote>() : await fetchOptionQuotes([...attemptedOptionIds]);
  const spotBySymbol = new Map<string, number | null>();

  for (const trade of open) {
    try {
      // A trade is 'open' only briefly before its entry fill is confirmed
      // (reconcile / the entry poll resolves it). NEVER try to exit one with no
      // confirmed fill — there is no real position to sell, and a SELL here would
      // open a naked short at the broker. Leave it for reconcile to settle/fail.
      if (trade.entryFillPremium == null) {
        // Absence of a local fill is not proof that the broker has no position.
        // Reconciliation owns this state; never age it into a retryable failure.
        continue;
      }

      // A row from a previous session is a ghost — INTRADAY positions never
      // survive the broker's own square-off. NEVER exit it (that SELL would
      // open a naked short); reconcileOpenPositions() closes such rows.
      if (trade.date !== date) {
        const line = `${trade.symbol} ${trade.optionType}: stale open row from ${trade.date} — skipped (position reconciliation will close it)`;
        actions.push(line);
        console.warn(`${TAG} ${line}`);
        continue;
      }

      let reason: string | null = null;

      if (squareOff) {
        reason = `EOD square-off (${istMinuteLabel(squareOffMin)})`;
      } else {
        // Premium backstops — the primary deterministic exit (we HOLD premium).
        const quote = optionQuotes.get(String(Number(trade.optSecurityId))) ?? null;
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
          spotBySymbol.set(trade.symbol, spot);
          if (spot != null) reason = spotExitReason(trade, spot);
        }
      }

      if (reason) {
        const outcome = await exitTrade(trade, reason);
        const line = `${trade.symbol} ${trade.optionType}: ${reason} → ${outcome.message}`;
        actions.push(line);
        console.log(`${TAG} ${line}`);

        // Confirmed-fill alerts are centralized in execution.ts. The guard's
        // EOD-specific alert also waits for a fill; accepted/pending is not exit.
        if (outcome.state === 'filled' && squareOff) alerts.eodSquareOff(trade.symbol);

        // Exit failure escalation: if the exit order failed, count consecutive
        // failures for this trade and escalate after EXIT_FAILURE_ESCALATE.
        if (!outcome.ok) {
          const exitOrders = (await getOrdersForTrade(trade.id)).filter((o) => o.side === 'SELL');
          const consecutiveFails = exitOrders.filter(
            (o) => o.status === 'rejected' || (o.status === 'sent' && o.error)
          ).length;
          if (consecutiveFails >= EXIT_FAILURE_ESCALATE) {
            const esc = `⚠️ ${trade.symbol} ${trade.optionType}: ${consecutiveFails} consecutive exit failures — MANUAL INTERVENTION NEEDED`;
            actions.push(esc);
            console.error(`[PositionGuard] 🚨 ${esc}`);
            alerts.exitFailureEscalation(trade.symbol, consecutiveFails);
          }
        }
      }
    } catch (err) {
      const line = `${trade.symbol} ${trade.optionType}: guard check failed (${(err as Error).message})`;
      actions.push(line);
      console.error(`${TAG} ${line}`);
    }
  }
  return { actions, optionQuotes, attemptedOptionIds, spotBySymbol };
}

/**
 * Process-wide single-flight guard. If the 60s loop and a full engine pass
 * meet at the same instant, the second caller awaits the first caller's exact
 * result instead of quoting or exiting twice.
 */
export async function runPositionGuard(date: string): Promise<PositionGuardResult> {
  const existing = guardHost.__positionGuardInFlight;
  if (existing) return { ...(await existing), coalesced: true };

  const run = runPositionGuardCore(date);
  guardHost.__positionGuardInFlight = run;
  try {
    return { ...(await run), coalesced: false };
  } finally {
    if (guardHost.__positionGuardInFlight === run) delete guardHost.__positionGuardInFlight;
  }
}
