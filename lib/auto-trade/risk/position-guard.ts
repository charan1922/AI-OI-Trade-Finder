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
import { fetchOptionQuotesWithHealth, latestSpotRead, type OptionQuote } from '../quotes';
import { getAutoTradeSettings } from '../settings';
import { getOpenTrades, getOrdersForTrade, updateShadowExcursion, updateTrade } from '../store';
import type { AutoTrade } from '../types';
import { activateRiskLatch, clearRiskLatchReason } from './latch';
import { supertrend } from '@/lib/signals/indicators';
import { getFyersCandles, fyersBucketFor } from '@/lib/fyers/candle-store';
import { excursionR } from '../quant/reanchor';

const TAG = '[PositionGuard]';

// ── Guard health (AT-005): a quote failure while positions are open is guard
// BLINDNESS, never silence. Consecutive failures escalate: warn → critical
// alert → risk latch (blocks new entries; exits are never blocked). The latch
// reason auto-clears the moment quotes return.
const GUARD_BLIND_ALERT_AFTER = 3;
const GUARD_BLIND_LATCH_AFTER = 6;
const GUARD_BLIND_LATCH_KEY = 'guard-blind';

export interface GuardHealth {
  consecutiveQuoteFailures: number;
  lastQuoteOkAt: string | null;
  lastQuoteError: string | null;
  status: 'healthy' | 'degraded' | 'blind';
}

const healthHost = globalThis as unknown as { __positionGuardHealth?: GuardHealth };

function getHealth(): GuardHealth {
  healthHost.__positionGuardHealth ??= {
    consecutiveQuoteFailures: 0,
    lastQuoteOkAt: null,
    lastQuoteError: null,
    status: 'healthy',
  };
  return healthHost.__positionGuardHealth;
}

/** Snapshot for ops/status endpoints. */
export function getGuardHealth(): GuardHealth {
  return { ...getHealth() };
}

async function recordQuoteHealth(sourceOk: boolean, error: string | null, openPositions: number): Promise<string[]> {
  const health = getHealth();
  const notes: string[] = [];
  if (sourceOk) {
    const wasBlind = health.consecutiveQuoteFailures >= GUARD_BLIND_ALERT_AFTER;
    health.consecutiveQuoteFailures = 0;
    health.lastQuoteOkAt = new Date().toISOString();
    health.lastQuoteError = null;
    health.status = 'healthy';
    if (wasBlind) {
      notes.push('option quotes recovered — guard sight restored');
      await clearRiskLatchReason(GUARD_BLIND_LATCH_KEY);
    }
    return notes;
  }
  health.consecutiveQuoteFailures += 1;
  health.lastQuoteError = error;
  health.status = health.consecutiveQuoteFailures >= GUARD_BLIND_ALERT_AFTER ? 'blind' : 'degraded';
  const detail = `option quote request failed ${health.consecutiveQuoteFailures}× in a row with ${openPositions} open position(s): ${error ?? 'unknown error'}`;
  notes.push(detail);
  console.error(`${TAG} ${detail}`);
  if (health.consecutiveQuoteFailures === GUARD_BLIND_ALERT_AFTER) alerts.guardBlind(detail);
  if (health.consecutiveQuoteFailures === GUARD_BLIND_LATCH_AFTER) {
    await activateRiskLatch(GUARD_BLIND_LATCH_KEY, `${detail} — premium stops unprotected; spot checks continue`);
  }
  return notes;
}

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

/** SHADOW-only R level at which an R-based rule would protect near breakeven —
 *  the doc's alternative to the +30%-premium rule. Used for MEASUREMENT logging,
 *  it never moves a stop or exits. */
const SHADOW_R_PROTECT_AT = 1;

/**
 * SHADOW measurement (never exits, never moves a stop): track the true spot-R
 * excursion over the hold so R-based profit protection can be calibrated against
 * the live +30%-premium breakeven rule. The doc's finding — a +30% premium move
 * is an inconsistent proxy for spot-R — means a trade can reach a real R-gain
 * and give it back before the premium rule ever arms (COLPAL 2026-07-20: peaked
 * ~+0.8R, premium never near +30%, gave it all back to the cash stop).
 *
 * Correctness (AT-review 2026-07-20):
 *  - the denominator is the IMMUTABLE initial risk recorded at entry, never the
 *    live (tightenable) slSpot — a stop move can't retroactively inflate a past R;
 *  - MFE/MAE come from candle HIGH/LOW since entry (via excursionR), not sampled
 *    closes; and this runs UNCONDITIONALLY every pass (before any exit check), so
 *    a premium-stop pass can't drop the final adverse excursion.
 */
async function recordShadowExcursion(trade: AutoTrade, date: string, actions: string[]): Promise<void> {
  try {
    const initialRisk = trade.entryInitialRiskPoints;
    if (initialRisk == null || !(initialRisk > 0) || trade.openedAt == null) return;
    const bars = await getFyersCandles(trade.symbol, date, 'EQ');
    const entryBucket = fyersBucketFor(new Date(trade.openedAt).getTime());
    const sinceEntry = bars.filter((b) => b.bucketTs >= entryBucket);
    const { mfeR, maeR } = excursionR(trade.direction, trade.entrySpot, initialRisk, sinceEntry);
    if (mfeR == null && maeR == null) return;
    const prevMfe = trade.shadowMfeR;
    await updateShadowExcursion(trade.id, mfeR, maeR);
    // Transition note: first crossing of the R-protect level while the LIVE
    // premium breakeven (needs +30% premium) has not armed — the giveback window.
    const beArmed = trade.entryFillPremium != null && trade.slPremium >= trade.entryFillPremium;
    if (mfeR != null && mfeR >= SHADOW_R_PROTECT_AT && (prevMfe == null || prevMfe < SHADOW_R_PROTECT_AT) && !beArmed) {
      const line = `${trade.symbol}: [shadow] reached +${mfeR}R (candle high since entry) but premium breakeven not armed (live rule needs +30% premium) — an R-based rule would protect near breakeven here`;
      actions.push(line);
      console.log(`${TAG} ${line}`);
    }
  } catch (err) {
    console.warn(`${TAG} shadow excursion failed for ${trade.symbol}: ${(err as Error).message}`);
  }
}

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
  let optionQuotes: ReadonlyMap<string, OptionQuote> = new Map<string, OptionQuote>();
  if (!squareOff && attemptedOptionIds.size > 0) {
    const batch = await fetchOptionQuotesWithHealth([...attemptedOptionIds]);
    optionQuotes = batch.quotes;
    // A failed batch is BLINDNESS, not silence: warn → critical alert → latch.
    actions.push(...(await recordQuoteHealth(batch.sourceOk, batch.error, open.length)));
  }
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

      // SHADOW excursion — recorded UNCONDITIONALLY, before any exit check, so
      // the final adverse/favorable move is captured even on a pass that exits.
      await recordShadowExcursion(trade, date, actions);

      let reason: string | null = null;

      if (squareOff) {
        reason = `EOD square-off (${istMinuteLabel(squareOffMin)})`;
      } else {
        // Premium backstops — the primary deterministic exit (we HOLD premium).
        const quote = optionQuotes.get(String(Number(trade.optSecurityId))) ?? null;
        if (quote) {
          // Executable exit side (AT-027): a long option EXITS by SELLING, so
          // the tradable price is the BID, not the last print. The stop falls
          // back to the resolved price when the book is empty (capital
          // protection beats waiting for a bid to appear); the target NEVER
          // fires on LTP alone — an unsellable "target" is not a target.
          const exitBid = quote.bid;
          const stopPx = exitBid ?? quote.ltp;
          const stopSrc = exitBid != null ? 'bid' : quote.priceSource;
          if (stopPx <= trade.slPremium) {
            reason = `premium stop hit (${stopSrc} ₹${stopPx} ≤ ₹${trade.slPremium})`;
          } else if (exitBid != null && exitBid >= trade.targetPremium) {
            reason = `premium target hit (bid ₹${exitBid} ≥ ₹${trade.targetPremium})`;
          } else if (exitBid == null && quote.ltp >= trade.targetPremium) {
            const line = `${trade.symbol} ${trade.optionType}: LTP ₹${quote.ltp} at/above target ₹${trade.targetPremium} but no live bid — holding until the target is executable`;
            actions.push(line);
            console.warn(`${TAG} ${line}`);
          }

          // Trailing stop: once premium gains TRAIL_STOP_TRIGGER_PCT%, tighten
          // SL to entry fill price (risk-free trade). Only tightens — never
          // loosens. Gain measured on the executable side (bid when available).
          if (!reason && trade.entryFillPremium > 0) {
            const gainPct = ((stopPx - trade.entryFillPremium) / trade.entryFillPremium) * 100;
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
                if (stFlipped && stopPx < trade.entryFillPremium) {
                  reason = `momentum exit: Supertrend flipped ${st.direction} + premium ₹${stopPx} below entry ₹${trade.entryFillPremium}`;
                }
              }
            } catch {
              // Supertrend check is best-effort — don't fail the guard
            }
          }
        }
        // Spot plan levels (scanner's structure-based stop, AI-tightened). A
        // STALE close must not drive them: a stalled recorder would otherwise
        // freeze the spot at its last value and silently disable (or misfire)
        // the spot stop for the rest of the day (AT-005).
        if (!reason) {
          const spotRead = await latestSpotRead(trade.symbol, date);
          spotBySymbol.set(trade.symbol, spotRead?.price ?? null);
          if (spotRead != null && !spotRead.fresh) {
            const line = `${trade.symbol}: spot close is ${Math.round(spotRead.ageMs / 60_000)} min old (recorder stalled?) — spot stop/target not evaluated on stale data`;
            actions.push(line);
            console.warn(`${TAG} ${line}`);
          } else if (spotRead != null) {
            reason = spotExitReason(trade, spotRead.price);
          }
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
