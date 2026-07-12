/**
 * Pre-trade hard gates — pure functions, no I/O, unit-testable. The tool
 * executor assembles an EntryGateInput from the DB + live quotes and calls
 * checkEntryGates(); EVERY entry path (AI place_entry_order, human approval)
 * goes through here. The AI's prompt repeats these rules as guidance, but this
 * file is the enforcement — a failed gate is final for the attempt.
 */

import {
  ENTRY_END_MIN,
  ENTRY_START_MIN,
  ENTRY_WINDOW_LABEL,
  MAX_ENTRY_SLIPPAGE_PCT,
} from '../config';
import type { AutoTradeSettings, GateVerdict } from '../types';

export interface EntryGateInput {
  settings: AutoTradeSettings;
  /** Second key for live mode: env AUTO_TRADE_LIVE_ENABLED === 'true'. */
  liveEnvEnabled: boolean;
  marketOpen: boolean;
  minuteIST: number;
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
  /** Spot stop from the scanner plan — an entry without one is unmanaged. */
  hasSlSpot: boolean;
  /** Broker's reported available balance (null = venue can't say; paper). */
  brokerFundsAvailable: number | null;
}

export function checkEntryGates(x: EntryGateInput): GateVerdict {
  const reasons: string[] = [];
  const s = x.settings;

  if (s.mode === 'off') reasons.push('auto-trade mode is OFF');
  if (s.killSwitch) reasons.push('kill switch is ON — no new orders');
  if (s.mode === 'live' && !x.liveEnvEnabled) {
    reasons.push('live mode selected but AUTO_TRADE_LIVE_ENABLED is not set in env (two-key rule)');
  }
  if (!x.marketOpen) reasons.push('market is closed');
  if (x.minuteIST < ENTRY_START_MIN || x.minuteIST > ENTRY_END_MIN) {
    reasons.push(`outside the entry window ${ENTRY_WINDOW_LABEL.opensAt}–${ENTRY_WINDOW_LABEL.closesAt}`);
  }
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
  if (x.perLotCost == null || x.perLotCost <= 0) {
    reasons.push('no live option premium — cannot size the position');
  } else {
    const cost = x.perLotCost * x.lots;
    if (x.deployedRupees + cost > s.maxCapitalRupees) {
      reasons.push(
        `capital cap: ₹${Math.round(x.deployedRupees + cost).toLocaleString('en-IN')} would exceed ₹${s.maxCapitalRupees.toLocaleString('en-IN')}`,
      );
    }
    if (x.brokerFundsAvailable != null && x.brokerFundsAvailable < cost) {
      reasons.push(
        `broker funds: ₹${Math.round(x.brokerFundsAvailable).toLocaleString('en-IN')} available < ₹${Math.round(cost).toLocaleString('en-IN')} needed`,
      );
    }
  }
  if (x.slippagePct != null && Math.abs(x.slippagePct) > MAX_ENTRY_SLIPPAGE_PCT) {
    reasons.push(`premium moved ${x.slippagePct.toFixed(1)}% since the scan quote (> ${MAX_ENTRY_SLIPPAGE_PCT}% slippage guard)`);
  }
  if (!x.hasSlSpot) reasons.push('scanner plan has no spot stop-loss — unmanaged entries are not allowed');

  return { allow: reasons.length === 0, reasons };
}

/** Stop moves may only TIGHTEN (reduce risk): for a bullish (CE) position the
 *  spot SL may only move UP toward price; for a bearish (PE) one only DOWN. */
export function checkStopMove(
  direction: 'bullish' | 'bearish',
  currentSlSpot: number | null,
  newSlSpot: number,
): GateVerdict {
  if (!Number.isFinite(newSlSpot) || newSlSpot <= 0) {
    return { allow: false, reasons: ['newSlSpot must be a positive number'] };
  }
  if (currentSlSpot != null) {
    if (direction === 'bullish' && newSlSpot <= currentSlSpot) {
      return { allow: false, reasons: [`bullish stop may only move UP (current ${currentSlSpot}, got ${newSlSpot})`] };
    }
    if (direction === 'bearish' && newSlSpot >= currentSlSpot) {
      return { allow: false, reasons: [`bearish stop may only move DOWN (current ${currentSlSpot}, got ${newSlSpot})`] };
    }
  }
  return { allow: true, reasons: [] };
}
