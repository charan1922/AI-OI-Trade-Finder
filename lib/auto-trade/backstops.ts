/**
 * Cash-target and premium-backstop math — PURE.
 *
 * Deliberately free of any database, broker or network import so CI can verify
 * it without a populated SQLite file. It used to live in execution.ts, whose
 * import graph reaches the store; that meant the money math shipped to prod
 * covered only by a bench nothing in CI ran (AT-REVIEW 2026-07-23).
 * execution.ts re-exports these, so existing importers are unaffected.
 */
import { DEFAULT_SETTINGS, MAX_LOSS_PER_LOT_FALLBACK } from './config';
import type { AutoTradeSettings } from './types';

/** Total cash profit represented by the current runtime policy. */
export function targetRupeesForPosition(
  settings: Pick<AutoTradeSettings, 'profitTargetMode' | 'profitTargetRupees'>,
  lots: number
): number {
  return settings.profitTargetMode === 'per_lot' ? settings.profitTargetRupees * lots : settings.profitTargetRupees;
}

/** Premium backstops re-anchored to the ACTUAL fill. The target argument is
 * total rupees for this position, so this function works for either per-trade
 * or per-lot policies and any lot count. */
export function backstopsFromFill(
  fill: number,
  lotSize: number,
  lots = 1,
  totalTargetRupees = targetRupeesForPosition(DEFAULT_SETTINGS, lots)
): { slPremium: number; targetPremium: number } {
  const slPct = fill * 0.6; // −40% premium backstop
  const slCap = fill - MAX_LOSS_PER_LOT_FALLBACK / lotSize;
  const qtyUnits = lotSize * lots;
  return {
    slPremium: Math.round(Math.max(0.05, Math.max(slPct, slCap)) * 100) / 100,
    targetPremium: Math.round((fill + totalTargetRupees / qtyUnits) * 100) / 100,
  };
}

/** Re-anchor a proposal's snapshotted cash target to the broker's actual fill.
 * The proposal premium delta is the immutable policy snapshot, so changing the
 * runtime setting while an approval/order is pending cannot move its target. */
export function backstopsFromProposalFill(
  fill: number,
  lotSize: number,
  lots: number,
  proposalEntryPremium: number,
  proposalTargetPremium: number
): { slPremium: number; targetPremium: number } {
  const qtyUnits = lotSize * lots;
  const snapshottedTargetRupees = Math.max(0.01, (proposalTargetPremium - proposalEntryPremium) * qtyUnits);
  return backstopsFromFill(fill, lotSize, lots, snapshottedTargetRupees);
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
