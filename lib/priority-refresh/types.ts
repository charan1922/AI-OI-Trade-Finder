/**
 * Types for the capped priority-refresh planner (see
 * ../../final-capped-priority-sector-plan.md).
 *
 * The planner decides WHICH symbols the Fyers priority download must refresh
 * FIRST each 5-minute cycle, so the scan → AI decision path can be released
 * sooner. It is pure data — no I/O, no DB, no provider calls — so every part
 * here is unit-testable without a database (scripts/priority-refresh-checks.ts).
 *
 * FOUNDATION PR: these types + the pure logic that builds a PriorityPlan.
 * Nothing here changes live poller/auto-trade behaviour yet — the plan is built
 * and (later) recorded in shadow; the poller keeps waiting for the full set
 * until USE_CAPPED_PRIORITY_REFRESH is wired and enabled in a later PR.
 */

/** The five NSE mover feeds that seed candidates (== CANDIDATE_SOURCES). */
export type PriorityFeed = 'nse-oi' | 'nse-gainers' | 'nse-losers' | 'nse-active-value' | 'nse-active-volume';

/** 0 = always-fresh-first (positions/earlier picks), 1 = capped candidates, 2 = background. */
export type PriorityTier = 0 | 1 | 2;

/** Why a symbol earned its place in the plan (a symbol may have several). */
export type PriorityReason =
  | 'risk-bearing-position'
  | 'earlier-suggestion'
  | `feed:${PriorityFeed}`
  | 'active-sector'
  | 'previous-rfactor'
  | 'rank-climber'
  | 'background';

/**
 * One name as it appears in ONE feed, AFTER that feed's eligibility filtering
 * (F&O-only, non-'avoid', live-future) — i.e. straight from `body.picks`.
 * `eligibleRank` is 1-based within the already-filtered list, so "top 10
 * eligible", never "top 10 raw then filtered down to 4".
 */
export interface RankedFeedPick {
  symbol: string;
  sector: string;
  source: PriorityFeed;
  eligibleRank: number;
  /** Feed % move (price for movers; used as the direction signal). Null if unknown. */
  retPct: number | null;
}

/** Feed → its ranked, eligibility-filtered picks for one cycle. */
export type FeedPicks = Record<PriorityFeed, RankedFeedPick[]>;

/**
 * A qualified active sector for one cycle (turnover-weighted move + breadth).
 * Produced off the critical path from the existing sector aggregation
 * (lib/sector/aggregate.ts) and selected by turnover rank. `direction` is
 * pre-decided by the producer's qualification rule.
 */
export interface ActiveSectorSignal {
  sector: string;
  direction: 'bullish' | 'bearish';
  weightedPct: number;
  totalTurnover: number;
  /** 1 = highest turnover among the day's sectors. */
  turnoverRank: number;
  advanceRatio: number | null;
  stocks: number;
  /** Optional confirmation from official NSE sector indices (metadata only). */
  officialNsePct: number | null;
  asOfMs: number;
}

/** Everything the plan knows about one symbol, for telemetry + operator display. */
export interface PrioritySymbol {
  symbol: string;
  sector: string;
  tier: PriorityTier;
  reasons: PriorityReason[];
  feedRanks: Partial<Record<PriorityFeed, number>>;
  feedReturns: Partial<Record<PriorityFeed, number | null>>;
  /** How many of the five feeds this symbol appears in. */
  sourceCount: number;
  sectorPromoted: boolean;
  sectorDirection: 'bullish' | 'bearish' | null;
  sectorRank: number | null;
}

/** The full cycle plan. `version` lets recorded plans never silently mix. */
export interface PriorityPlan {
  version: 1;
  createdAtMs: number;

  perFeedLimit: number;
  maxUniqueTier1: number;
  sectorReservedSlots: number;

  /** Always fresh first, never capped (positions + earlier picks). */
  tier0Symbols: string[];
  /** The round-robin base of Tier 1 (before sector promotion / fillers). */
  baseTier1Symbols: string[];
  /** Sector-promoted names (subset of Tier 1, inside the same cap). */
  sectorPromotedSymbols: string[];
  /** Final Tier 1 (base + sector promotions + fillers), ≤ maxUniqueTier1. */
  tier1Symbols: string[];
  /** Everything else — remaining movers + full universe — refreshed in background. */
  tier2Symbols: string[];

  /** The CURRENT (uncapped) priority set, kept for shadow comparison. */
  fullPrioritySymbols: string[];
  /** Tier 0 + Tier 1 — the set the poller would wait for when capped mode is ON. */
  cappedWaitSymbols: string[];

  bySymbol: Record<string, PrioritySymbol>;
}
