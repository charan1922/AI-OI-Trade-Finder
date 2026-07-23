/**
 * Pre-trade hard gates — pure functions, no I/O, unit-testable. The tool
 * executor assembles an EntryGateInput from the DB + live quotes and calls
 * checkEntryGates(); EVERY entry path (AI place_entry_order, human approval)
 * goes through here. The AI's prompt repeats these rules as guidance, but this
 * file is the enforcement — a failed gate is final for the attempt.
 */

import { riskPerLotRupees } from '../backstops';
import {
  ENTRY_END_MIN,
  ENTRY_START_MIN,
  istMinuteLabel,
  MAX_ENTRY_SLIPPAGE_PCT,
  MAX_RISK_PER_LOT_FALLBACK,
  MAX_SPREAD_PCT,
  OPTION_STOP_PCT_FALLBACK,
} from '../config';
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
  /** Units in one lot — needed to price the per-lot risk in rupees. Optional so
   *  older fixtures keep working; when absent the risk-ceiling gate is skipped
   *  (perLotCost alone already blocks an unpriceable entry). */
  lotSize?: number | null;
  /** Scanner's quote this cycle vs the fresh quote at placement time (%). */
  slippagePct: number | null;
  /** Bid-ask spread % on the option contract (null when no depth available). */
  spreadPct: number | null;
  /** Spot stop from the scanner plan — an entry without one is unmanaged. */
  hasSlSpot: boolean;
  /** Broker's reported available balance (null = venue can't say; paper). */
  brokerFundsAvailable: number | null;
  /** BLOCK_STALE_AUTO_ENTRY effective toggle — when true a stale latest completed
   *  5-min candle blocks a NEW entry (exits/guards are never gated on this). */
  blockStaleAutoEntry: boolean;
  /** The symbol's latest stored completed 5-min EQ bucket (epoch s) at gate time. */
  candleLatestBucketTs: number | null;
  /** The latest FULLY COMPLETED 5-min bucket required at gate time (epoch s). */
  candleRequiredBucketTs: number;
  /** Derived: candleLatestBucketTs >= candleRequiredBucketTs (fail-closed false when missing). */
  candleFresh: boolean;
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
    ['settings.optionStopPct', s.optionStopPct ?? OPTION_STOP_PCT_FALLBACK],
    ['settings.maxRiskPerLotRupees', s.maxRiskPerLotRupees ?? MAX_RISK_PER_LOT_FALLBACK],
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
    // Per-lot risk ceiling. The premium stop is a fixed % of the option's price
    // (sized to the CONTRACT's noise), so an expensive lot carries proportionally
    // more rupees behind that stop. The budget is therefore enforced here, by
    // refusing the contract — NOT by tightening the stop until the arithmetic
    // fits, which is what produced stop widths of 7.7%–23.8% that nobody chose
    // and that lost every time they landed under ~12% (2026-07-23 review).
    const stopPct = s.optionStopPct ?? OPTION_STOP_PCT_FALLBACK;
    const maxRiskPerLot = s.maxRiskPerLotRupees ?? MAX_RISK_PER_LOT_FALLBACK;
    const lotSize = x.lotSize;
    if (lotSize != null && Number.isFinite(lotSize) && lotSize > 0) {
      const riskPerLot = riskPerLotRupees(x.perLotCost / lotSize, lotSize, stopPct);
      if (!Number.isFinite(riskPerLot)) {
        reasons.push('per-lot risk could not be computed — failing closed');
      } else if (riskPerLot > maxRiskPerLot) {
        reasons.push(
          `lot risks ₹${Math.round(riskPerLot).toLocaleString('en-IN')} at the ${stopPct}% premium stop ` +
            `> max ₹${maxRiskPerLot.toLocaleString('en-IN')} per lot — contract too expensive for this account ` +
            `(the stop is not tightened to fit)`
        );
      }
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
  // Stale-candle entry block (plan §25). The scanner's setup/stop/target are
  // built from the latest completed 5-min EQ candle; entering on an outdated one
  // means acting on a stale picture. NEW ENTRIES ONLY — exits, guards, stop
  // moves and square-off never see this gate. Enforced in code, not the prompt.
  if (x.blockStaleAutoEntry && !x.candleFresh) {
    reasons.push(
      `latest completed 5-min candle is stale (required bucket ${x.candleRequiredBucketTs}, latest ${x.candleLatestBucketTs ?? 'missing'}) — new entry blocked; exits/guards unaffected`
    );
  }

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
