/**
 * Pre-trade hard gates — pure functions, no I/O, unit-testable. The tool
 * executor assembles an EntryGateInput from the DB + live quotes and calls
 * checkEntryGates(); EVERY entry path (AI place_entry_order, human approval)
 * goes through here. The AI's prompt repeats these rules as guidance, but this
 * file is the enforcement — a failed gate is final for the attempt.
 */

import { ENTRY_END_MIN, ENTRY_START_MIN, istMinuteLabel, MAX_ENTRY_SLIPPAGE_PCT, MAX_SPREAD_PCT } from '../config';
import type { AutoTradeSettings, GateVerdict } from '../types';

export interface EntryGateInput {
  settings: AutoTradeSettings;
  /** Second key for live mode: env AUTO_TRADE_LIVE_ENABLED === 'true'. */
  liveEnvEnabled: boolean;
  marketOpen: boolean;
  /** Fail-closed exchange-session verdict (lib/backtest/trading-calendar.ts
   *  isVerifiedTradingDay): weekday+clock alone can never authorize an entry —
   *  the NSE holiday calendar must positively verify the date (AT-007). */
  sessionVerified: boolean;
  /** Active risk-latch reasons (risk/latch.ts). ANY entry is blocked while the
   *  latch holds an incident — orphan position, quantity mismatch, guard
   *  blindness. Exits are never gated on this. */
  riskLatchReasons: string[];
  minuteIST: number;
  /** Code-enforced no-new-entry cutoff shared with commentary. */
  entryCutoffMin?: number;
  /** Entries that already consumed a daily slot (pending + open + closed). */
  entriesToday: number;
  openLots: number;
  /** Premium ₹ reserved across open + pending positions. */
  deployedRupees: number;
  /** Realized P&L booked today (negative = loss). */
  dailyRealizedPnl: number;
  symbolTradedToday: boolean;
  /** The lot being entered. */
  lots: number;
  perLotCost: number | null;
  /** Scanner's quote this cycle vs the fresh quote at placement time (%). */
  slippagePct: number | null;
  /** Bid-ask spread % on the option contract (null when no depth available). */
  spreadPct: number | null;
  /** Spot stop from the scanner plan — an entry without one is unmanaged. */
  hasSlSpot: boolean;
  /** Broker's reported available balance (null = venue can't say; paper). */
  brokerFundsAvailable: number | null;
}

export function checkEntryGates(x: EntryGateInput): GateVerdict {
  const reasons: string[] = [];
  const s = x.settings;

  // Corrupt numbers must fail CLOSED: every JS comparison against NaN is
  // false, so a NaN minuteIST would silently pass the time window and a NaN
  // pnl would pass the loss halt. Reject the attempt outright.
  const numerics: [string, number][] = [
    ['minuteIST', x.minuteIST],
    ['entriesToday', x.entriesToday],
    ['openLots', x.openLots],
    ['deployedRupees', x.deployedRupees],
    ['dailyRealizedPnl', x.dailyRealizedPnl],
    ['lots', x.lots],
    ['settings.maxTradesPerDay', s.maxTradesPerDay],
    ['settings.maxOpenLots', s.maxOpenLots],
    ['settings.maxCapitalRupees', s.maxCapitalRupees],
    ['settings.dailyLossHaltRupees', s.dailyLossHaltRupees],
    ['settings.squareOffMin', s.squareOffMin],
    ['settings.entryStartMin', s.entryStartMin ?? ENTRY_START_MIN],
    ['settings.entryEndMin', s.entryEndMin ?? ENTRY_END_MIN],
    ['settings.maxSpreadPct', s.maxSpreadPct ?? MAX_SPREAD_PCT],
  ];
  const corrupt = numerics.filter(([, value]) => !Number.isFinite(value)).map(([name]) => name);
  if (x.entryCutoffMin != null && Number.isNaN(x.entryCutoffMin)) corrupt.push('entryCutoffMin');
  if (corrupt.length > 0) {
    return { allow: false, reasons: [`corrupt numeric input(s): ${corrupt.join(', ')} — failing closed`] };
  }

  if (s.mode === 'off') reasons.push('auto-trade mode is OFF');
  if (s.killSwitch) reasons.push('kill switch is ON — no new orders');
  if (s.mode === 'live' && !x.liveEnvEnabled) {
    reasons.push('live mode selected but AUTO_TRADE_LIVE_ENABLED is not set in env (two-key rule)');
  }
  if (!x.marketOpen) reasons.push('market is closed');
  if (!x.sessionVerified) {
    reasons.push('exchange session not verified as a trading day (holiday calendar) — failing closed');
  }
  if (x.riskLatchReasons.length > 0) {
    reasons.push(`risk latch active: ${x.riskLatchReasons.join('; ')} — clear it on /auto-trade after resolving`);
  }
  // Window bounds come from settings (clamped in settings.ts); ?? keeps older
  // test fixtures without the fields on the long-standing defaults.
  const entryStart = s.entryStartMin ?? ENTRY_START_MIN;
  const entryEnd = s.entryEndMin ?? ENTRY_END_MIN;
  const cutoff = x.entryCutoffMin ?? Number.POSITIVE_INFINITY;
  const hardEnd = Math.min(entryEnd, cutoff - 1, s.squareOffMin - 1);
  if (x.minuteIST < entryStart || x.minuteIST > hardEnd) {
    reasons.push(`outside the effective entry window ${istMinuteLabel(entryStart)}–${istMinuteLabel(hardEnd)}`);
  }
  if (x.minuteIST >= cutoff) reasons.push(`past the hard fresh-entry cutoff ${istMinuteLabel(cutoff)}`);
  if (x.minuteIST >= s.squareOffMin) reasons.push(`at/after forced square-off ${istMinuteLabel(s.squareOffMin)}`);
  if (x.entriesToday >= s.maxTradesPerDay) {
    reasons.push(`daily trade cap reached (${x.entriesToday}/${s.maxTradesPerDay})`);
  }
  if (x.openLots + x.lots > s.maxOpenLots) {
    reasons.push(`open-lot cap: ${x.openLots} open + ${x.lots} new > max ${s.maxOpenLots}`);
  }
  if (x.symbolTradedToday) reasons.push('symbol already traded today (no re-entry rule)');
  if (x.dailyRealizedPnl <= -s.dailyLossHaltRupees) {
    reasons.push(`daily loss halt: realized ₹${x.dailyRealizedPnl} ≤ -₹${s.dailyLossHaltRupees}`);
  }
  // Real orders (approval/live) must verify the balance; a funds-API failure
  // fails CLOSED. Paper never trips this — the executor computes its funds as
  // budget-minus-deployed, so paper always arrives with a number.
  const funds =
    x.brokerFundsAvailable != null && Number.isFinite(x.brokerFundsAvailable) ? x.brokerFundsAvailable : null;
  if (s.mode !== 'paper' && funds == null) {
    reasons.push('broker funds unavailable — cannot verify balance for a real order');
  }
  if (x.perLotCost == null || x.perLotCost <= 0) {
    reasons.push('no live option premium — cannot size the position');
  } else {
    const cost = x.perLotCost * x.lots;
    if (x.deployedRupees + cost > s.maxCapitalRupees) {
      reasons.push(
        `capital cap: ₹${Math.round(x.deployedRupees + cost).toLocaleString('en-IN')} would exceed ₹${s.maxCapitalRupees.toLocaleString('en-IN')}`
      );
    }
    if (funds != null && funds < cost) {
      reasons.push(
        `broker funds: ₹${Math.round(funds).toLocaleString('en-IN')} available < ₹${Math.round(cost).toLocaleString('en-IN')} needed`
      );
    }
  }
  if (x.slippagePct == null || !Number.isFinite(x.slippagePct)) {
    // No scan-quote comparison available (scanner premium missing) — the AI
    // would be entering on numbers nobody verified. Fail closed.
    reasons.push('premium slippage vs the scan quote cannot be verified — failing closed');
  } else if (Math.abs(x.slippagePct) > MAX_ENTRY_SLIPPAGE_PCT) {
    reasons.push(
      `premium moved ${x.slippagePct.toFixed(1)}% since the scan quote (> ${MAX_ENTRY_SLIPPAGE_PCT}% slippage guard)`
    );
  }
  const maxSpread = s.maxSpreadPct ?? MAX_SPREAD_PCT;
  if (x.spreadPct == null || !Number.isFinite(x.spreadPct) || x.spreadPct < 0) {
    reasons.push('option spread unavailable — liquidity cannot be verified');
  } else if (x.spreadPct > maxSpread) {
    reasons.push(`option spread ${x.spreadPct.toFixed(1)}% exceeds max ${maxSpread}% — too illiquid`);
  }
  if (!x.hasSlSpot) reasons.push('scanner plan has no spot stop-loss — unmanaged entries are not allowed');

  return { allow: reasons.length === 0, reasons };
}

/** Stop moves may only TIGHTEN (reduce risk): for a bullish (CE) position the
 *  spot SL may only move UP toward price; for a bearish (PE) one only DOWN. */
export function checkStopMove(
  direction: 'bullish' | 'bearish',
  currentSlSpot: number | null,
  newSlSpot: number
): GateVerdict {
  if (!Number.isFinite(newSlSpot) || newSlSpot <= 0) {
    return { allow: false, reasons: ['newSlSpot must be a positive number'] };
  }
  if (currentSlSpot != null) {
    if (direction === 'bullish' && newSlSpot <= currentSlSpot) {
      return {
        allow: false,
        reasons: [`bullish stop may only move UP (current ${currentSlSpot}, got ${newSlSpot})`],
      };
    }
    if (direction === 'bearish' && newSlSpot >= currentSlSpot) {
      return {
        allow: false,
        reasons: [`bearish stop may only move DOWN (current ${currentSlSpot}, got ${newSlSpot})`],
      };
    }
  }
  return { allow: true, reasons: [] };
}
