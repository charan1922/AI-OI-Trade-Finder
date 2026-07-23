/**
 * Cash-target and premium-backstop math — PURE.
 *
 * Deliberately free of any database, broker or network import so CI can verify
 * it without a populated SQLite file. It used to live in execution.ts, whose
 * import graph reaches the store; that meant the money math shipped to prod
 * covered only by a bench nothing in CI ran (AT-REVIEW 2026-07-23).
 * execution.ts re-exports these, so existing importers are unaffected.
 */
import { DEFAULT_SETTINGS, OPTION_STOP_PCT_FALLBACK } from './config';
import type { AutoTradeSettings } from './types';

/** Total cash profit represented by the current runtime policy. */
export function targetRupeesForPosition(
  settings: Pick<AutoTradeSettings, 'profitTargetMode' | 'profitTargetRupees'>,
  lots: number
): number {
  return settings.profitTargetMode === 'per_lot' ? settings.profitTargetRupees * lots : settings.profitTargetRupees;
}

/**
 * The premium stop level for an entry at `fill`, as a straight percentage of the
 * option's own price.
 *
 * Deliberately NOT a function of lot size. The previous rule took the tighter of
 * −40% and −₹1,500/lot; because the rupee budget divided by a lot size that
 * varies 75–700 units, the effective stop landed anywhere from 7.7% to 23.8%
 * across nine live trades. The per-lot rupee budget is now enforced by REFUSING
 * over-sized contracts at the gate (riskPerLotRupees + checkEntryGates), which
 * leaves this free to be what a stop should be: wider than the contract's own
 * noise. See OPTION_STOP_PCT in lib/trade-suggest/config.ts for the evidence.
 */
export function stopPremiumForFill(fill: number, stopPct: number = OPTION_STOP_PCT_FALLBACK): number {
  const pct = Number.isFinite(stopPct) && stopPct > 0 && stopPct < 100 ? stopPct : OPTION_STOP_PCT_FALLBACK;
  return Math.round(Math.max(0.05, fill * (1 - pct / 100)) * 100) / 100;
}

/**
 * Rupees at risk on ONE lot if the premium stop is hit, measured from the price
 * actually being paid. This is the number the sizing gate compares against
 * settings.maxRiskPerLotRupees — it is what the account really stands to lose,
 * so it uses the ROUNDED stop level the guard will fire on, not the raw
 * percentage (a ₹0.005 rounding step is immaterial, but the two must agree).
 */
export function riskPerLotRupees(fill: number, lotSize: number, stopPct: number = OPTION_STOP_PCT_FALLBACK): number {
  if (!Number.isFinite(fill) || !Number.isFinite(lotSize) || fill <= 0 || lotSize <= 0) return Number.NaN;
  return Math.round((fill - stopPremiumForFill(fill, stopPct)) * lotSize * 100) / 100;
}

/** Premium backstops re-anchored to the ACTUAL fill. The target argument is
 * total rupees for this position, so this function works for either per-trade
 * or per-lot policies and any lot count. */
export function backstopsFromFill(
  fill: number,
  lotSize: number,
  lots = 1,
  totalTargetRupees = targetRupeesForPosition(DEFAULT_SETTINGS, lots),
  stopPct: number = OPTION_STOP_PCT_FALLBACK
): { slPremium: number; targetPremium: number } {
  const qtyUnits = lotSize * lots;
  return {
    slPremium: stopPremiumForFill(fill, stopPct),
    targetPremium: Math.round((fill + totalTargetRupees / qtyUnits) * 100) / 100,
  };
}

/**
 * Re-anchor a proposal's snapshotted backstops to the broker's actual fill.
 *
 * BOTH sides are recovered from the proposal, never re-read from settings: the
 * cash target from the proposal's premium delta, and the stop WIDTH from the
 * proposal's own stop as a percentage of its entry. Changing `profitTargetRupees`
 * or `optionStopPct` while an approval or order is pending therefore cannot move
 * the levels a human already approved.
 *
 * `proposalSlPremium` is optional so existing 5-argument callers keep the coded
 * default; when supplied it must be below the proposal entry (a stop at or above
 * entry is not a policy width) or the default is used.
 */
export function backstopsFromProposalFill(
  fill: number,
  lotSize: number,
  lots: number,
  proposalEntryPremium: number,
  proposalTargetPremium: number,
  proposalSlPremium?: number | null
): { slPremium: number; targetPremium: number } {
  const qtyUnits = lotSize * lots;
  const snapshottedTargetRupees = Math.max(0.01, (proposalTargetPremium - proposalEntryPremium) * qtyUnits);
  const snapshottedStopPct =
    proposalSlPremium != null &&
    Number.isFinite(proposalSlPremium) &&
    Number.isFinite(proposalEntryPremium) &&
    proposalEntryPremium > 0 &&
    proposalSlPremium > 0 &&
    proposalSlPremium < proposalEntryPremium
      ? (1 - proposalSlPremium / proposalEntryPremium) * 100
      : OPTION_STOP_PCT_FALLBACK;
  return backstopsFromFill(fill, lotSize, lots, snapshottedTargetRupees, snapshottedStopPct);
}

/**
 * Is a PROFIT TARGET actually takeable right now?
 *
 * Price alone is not enough: a ₹120 bid for 5 units is not a ₹120 exit for 500.
 * A market sell would lift the top bid and then sweep whatever sits beneath it,
 * realising materially less than the configured cash target. The FYERS stream
 * always required full displayed size; the REST guard did not, and since it
 * runs every 5 seconds it usually got there first (AT-REVIEW 2026-07-23).
 *
 * STOPS MUST NOT USE THIS. Capital protection has to fire into thin liquidity —
 * refusing to stop out because the book is small is how a small loss becomes a
 * large one.
 */
export function isRestTargetExecutable(args: {
  bid: number | null;
  bidQty: number | null;
  targetPremium: number;
  qtyUnits: number;
}): boolean {
  return (
    args.bid != null &&
    args.bidQty != null &&
    args.qtyUnits > 0 &&
    args.bid >= args.targetPremium &&
    args.bidQty >= args.qtyUnits
  );
}

/**
 * Can the WHOLE position be sold at the best bid right now?
 *
 * This is the honesty test behind the word "executable". A ₹120 bid for 5 units
 * against 500 held does not make the position worth ₹120/unit — the rest would
 * sweep down the ladder. Any P&L figure labelled executable must pass this;
 * anything that only knows the price is a mark, not an exit (PR#16 review).
 */
export function isFullPositionBidCovered(args: {
  bid: number | null;
  bidSize: number | null;
  qtyUnits: number;
}): boolean {
  return args.bid != null && args.bidSize != null && args.qtyUnits > 0 && args.bidSize >= args.qtyUnits;
}

/**
 * Top-of-book resting sizes from a Dhan depth ladder.
 *
 * Kept pure and separate from the quote fetcher so CI can prove the mapping:
 * lib/auto-trade/quotes.ts reaches lib/env, which parses at import and throws
 * without credentials, so nothing importing it can run in CI.
 */
export function topOfBookSizes(depth: {
  buy?: { quantity?: number }[];
  sell?: { quantity?: number }[];
} | null | undefined): { bidQty: number | null; askQty: number | null } {
  const size = (value: unknown): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  return { bidQty: size(depth?.buy?.[0]?.quantity), askQty: size(depth?.sell?.[0]?.quantity) };
}

/**
 * Held contracts with no usable quote this pass — the guard is BLIND on these
 * even when the HTTP request itself succeeded, because their premium stop and
 * target are both skipped. Pure so the transition is provable in CI.
 */
export function blindContractIds(protectedIds: readonly string[], quotedIds: ReadonlySet<string>): string[] {
  return protectedIds.filter((id) => !quotedIds.has(id));
}

/** Minimal shape of a trade needed to decide what this pass must protect. */
export interface ProtectableTrade {
  entryFillPremium: number | null;
  date: string;
  optSecurityId: string;
}

/**
 * Split the open book into what THIS pass is responsible for protecting.
 *
 * Two things this must get right, both of which previously went wrong
 * (PR#16 re-review):
 *
 *  - A previous session's ghost row is never exited here (reconciliation owns
 *    it), so it must not drive guard health either. Counting a transport
 *    failure against a ghost-only book would march the guard toward the
 *    `guard-blind` latch and block new entries with NO live position at risk.
 *
 *  - A CURRENT filled trade whose optSecurityId is empty or non-numeric cannot
 *    be quoted at all. Silently dropping it from the id set made it invisible:
 *    no quote, no blindness recorded, and its premium stop and target skipped —
 *    exactly the blindness this guard exists to prevent. Those trades are
 *    returned as `unquotable` so the caller can count them as blind.
 */
export function classifyProtectedContracts<T extends ProtectableTrade>(
  open: readonly T[],
  date: string
): { protectedTrades: T[]; quotableIds: string[]; unquotable: T[] } {
  const protectedTrades = open.filter((trade) => trade.entryFillPremium != null && trade.date === date);
  const quotableIds: string[] = [];
  const unquotable: T[] = [];
  for (const trade of protectedTrades) {
    const id = Number(trade.optSecurityId);
    if (Number.isFinite(id) && id > 0) quotableIds.push(String(id));
    else unquotable.push(trade);
  }
  return { protectedTrades, quotableIds, unquotable };
}
