/**
 * Pure priority-plan orchestration (see plan §5, §8, §19). No I/O.
 *
 * Given the five feeds' ranked picks plus the risk-bearing / earlier-suggestion
 * symbols and the full priority + universe sets, produce a PriorityPlan:
 *   Tier 0 — positions + earlier picks (always fresh first, never capped)
 *   Tier 1 — ≤ maxUniqueTier1 unique: a round-robin base + reserved sector
 *            promotion slots + round-robin fillers for any unused sector slots
 *   Tier 2 — everything else (background)
 *
 * `activeSectors` are ALREADY selected by the caller (selectActiveSectors) so
 * this stays a pure, deterministic function of its inputs.
 */
import { FEED_ORDER } from './config';
import { selectRoundRobinCandidates } from './round-robin';
import { selectSectorPromotions, type SectorPromotionCandidate } from './sector-signal';
import type {
  ActiveSectorSignal,
  FeedPicks,
  PriorityFeed,
  PriorityPlan,
  PriorityReason,
  PrioritySymbol,
} from './types';

export interface BuildPriorityPlanInput {
  feedPicks: FeedPicks;
  riskBearingSymbols: string[];
  earlierSuggestionSymbols: string[];
  fullPrioritySymbols: string[];
  fullUniverseSymbols: string[];
  perFeedLimit: number;
  maxUniqueTier1: number;
  /** Already-selected active sectors (empty when sector promotion is disabled). */
  activeSectors: ActiveSectorSignal[];
  sectorEnabled: boolean;
  sectorReservedSlots: number;
  nowMs: number;
}

function dedupe(symbols: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of symbols) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

interface FeedIndexEntry {
  sector: string;
  feedRanks: Partial<Record<PriorityFeed, number>>;
  feedReturns: Partial<Record<PriorityFeed, number | null>>;
}

/** symbol → the feeds it appears in (best rank per feed) + its sector. */
function indexFeeds(feedPicks: FeedPicks): Map<string, FeedIndexEntry> {
  const map = new Map<string, FeedIndexEntry>();
  for (const source of FEED_ORDER) {
    for (const pick of feedPicks[source] ?? []) {
      if (!pick.symbol) continue;
      let entry = map.get(pick.symbol);
      if (!entry) {
        entry = { sector: pick.sector ?? '', feedRanks: {}, feedReturns: {} };
        map.set(pick.symbol, entry);
      }
      const existing = entry.feedRanks[source];
      if (existing === undefined || pick.eligibleRank < existing) entry.feedRanks[source] = pick.eligibleRank;
      entry.feedReturns[source] = pick.feedMetricPct;
      if (!entry.sector && pick.sector) entry.sector = pick.sector;
    }
  }
  return map;
}

/**
 * Feed candidates flattened & deduped, ordered best-rank-first, for sector
 * promotion. Only the first `perFeedLimit` ranks of each feed are considered —
 * the same eligibility depth ordinary round-robin uses, so promotion can never
 * pull in a rank-11+ name (PR#9 review). Carries only PRICE direction, merged
 * from whichever feed conveys it (nse-oi contributes none).
 */
function rankedRemaining(feedPicks: FeedPicks, perFeedLimit: number): SectorPromotionCandidate[] {
  const best = new Map<string, SectorPromotionCandidate & { rank: number }>();
  for (const source of FEED_ORDER) {
    for (const pick of (feedPicks[source] ?? []).slice(0, perFeedLimit)) {
      if (!pick.symbol) continue;
      const cur = best.get(pick.symbol);
      if (!cur) {
        best.set(pick.symbol, {
          symbol: pick.symbol,
          sector: pick.sector ?? '',
          priceDirectionPct: pick.priceDirectionPct,
          rank: pick.eligibleRank,
        });
      } else {
        // Merge a KNOWN price direction from any feed; keep the best rank/sector.
        if (cur.priceDirectionPct === null && pick.priceDirectionPct !== null) cur.priceDirectionPct = pick.priceDirectionPct;
        if (!cur.sector && pick.sector) cur.sector = pick.sector;
        if (pick.eligibleRank < cur.rank) cur.rank = pick.eligibleRank;
      }
    }
  }
  return [...best.values()]
    .sort((a, b) => a.rank - b.rank)
    .map((c) => ({ symbol: c.symbol, sector: c.sector, priceDirectionPct: c.priceDirectionPct }));
}

export function buildPriorityPlan(input: BuildPriorityPlanInput): PriorityPlan {
  const {
    feedPicks,
    riskBearingSymbols,
    earlierSuggestionSymbols,
    fullPrioritySymbols,
    fullUniverseSymbols,
    perFeedLimit,
    maxUniqueTier1,
    activeSectors,
    sectorEnabled,
    sectorReservedSlots,
    nowMs,
  } = input;

  const feedIndex = indexFeeds(feedPicks);
  const riskSet = new Set(riskBearingSymbols.filter(Boolean));
  const suggestionSet = new Set(earlierSuggestionSymbols.filter(Boolean));

  // ── Tier 0: continuity — never capped, and disjoint from Tier 1 ───────────
  const tier0 = dedupe([...riskSet, ...suggestionSet]);
  const tier0Set = new Set(tier0);

  // ── Tier 1: reserve sector slots inside the same cap ──────────────────────
  const sectorSlots = sectorEnabled ? Math.min(Math.max(0, sectorReservedSlots), maxUniqueTier1) : 0;
  const baseSlots = maxUniqueTier1 - sectorSlots;

  // Tier 0 is EXCLUDED from every Tier 1 step, so Tier 1 is genuinely 40 NEW
  // names beyond the positions/earlier-picks we already wait for (PR#9 review).
  const baseTier1 = selectRoundRobinCandidates(feedPicks, perFeedLimit, baseSlots, tier0Set);

  const promotionDir = new Map(activeSectors.map((s) => [s.sector, s.direction]));
  const promotionRank = new Map(activeSectors.map((s) => [s.sector, s.turnoverRank]));
  const promotionCandidates: SectorPromotionCandidate[] = rankedRemaining(feedPicks, perFeedLimit);
  const sectorPromoted =
    sectorEnabled && sectorSlots > 0
      ? selectSectorPromotions({
          remainingFeedCandidates: promotionCandidates,
          activeSectors,
          existingSymbols: new Set([...tier0, ...baseTier1]),
          maxPromotions: sectorSlots,
        })
      : [];

  let tier1 = dedupe([...baseTier1, ...sectorPromoted]);
  if (tier1.length < maxUniqueTier1) {
    const fillers = selectRoundRobinCandidates(
      feedPicks,
      perFeedLimit,
      maxUniqueTier1 - tier1.length,
      new Set([...tier0, ...tier1])
    );
    tier1 = dedupe([...tier1, ...fillers]).slice(0, maxUniqueTier1);
  }

  const cappedWaitSymbols = dedupe([...tier0, ...tier1]);
  const cappedSet = new Set(cappedWaitSymbols);

  // ── Tier 2: remaining priority + universe ─────────────────────────────────
  const tier2 = dedupe([...fullPrioritySymbols, ...fullUniverseSymbols]).filter((s) => !cappedSet.has(s));

  // ── Per-symbol telemetry ──────────────────────────────────────────────────
  const promotedSet = new Set(sectorPromoted);
  const bySymbol: Record<string, PrioritySymbol> = {};

  const build = (symbol: string, tier: 0 | 1 | 2): PrioritySymbol => {
    const idx = feedIndex.get(symbol);
    const reasons: PriorityReason[] = [];
    if (riskSet.has(symbol)) reasons.push('risk-bearing-position');
    if (suggestionSet.has(symbol)) reasons.push('earlier-suggestion');
    if (idx) for (const source of FEED_ORDER) if (idx.feedRanks[source] !== undefined) reasons.push(`feed:${source}`);
    const promoted = promotedSet.has(symbol);
    if (promoted) reasons.push('active-sector');
    if (tier === 2) reasons.push('background');

    let sectorDirection: 'bullish' | 'bearish' | null = null;
    let sectorRank: number | null = null;
    if (promoted && idx) {
      sectorDirection = promotionDir.get(idx.sector) ?? null;
      sectorRank = promotionRank.get(idx.sector) ?? null;
    }

    return {
      symbol,
      sector: idx?.sector ?? '',
      tier,
      reasons,
      feedRanks: idx?.feedRanks ?? {},
      feedReturns: idx?.feedReturns ?? {},
      sourceCount: idx ? Object.keys(idx.feedRanks).length : 0,
      sectorPromoted: promoted,
      sectorDirection,
      sectorRank,
    };
  };

  const tier1Set = new Set(tier1);
  for (const s of tier0) bySymbol[s] = build(s, 0);
  for (const s of tier1) if (!tier0Set.has(s)) bySymbol[s] = build(s, 1);
  for (const s of tier2) if (!tier0Set.has(s) && !tier1Set.has(s)) bySymbol[s] = build(s, 2);

  return {
    version: 1,
    createdAtMs: nowMs,
    perFeedLimit,
    maxUniqueTier1,
    sectorReservedSlots: sectorSlots,
    tier0Symbols: tier0,
    baseTier1Symbols: baseTier1,
    sectorPromotedSymbols: sectorPromoted,
    tier1Symbols: tier1,
    tier2Symbols: tier2,
    fullPrioritySymbols: dedupe(fullPrioritySymbols),
    cappedWaitSymbols,
    bySymbol,
  };
}
