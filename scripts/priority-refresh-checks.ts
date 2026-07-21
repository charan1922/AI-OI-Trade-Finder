/**
 * Pure, DB-free checks for the capped priority-refresh planner
 * (lib/priority-refresh/*). Mirrors the planner / round-robin / sector-selection
 * tests in final-capped-priority-sector-plan.md §35, plus the PR#9-review
 * regressions (Tier 0 disjoint from Tier 1; OI% ≠ price direction; sector
 * promotion respects PRIORITY_PER_FEED; unknown breadth fails closed). No
 * database, no I/O — runs in GitHub CI via scripts/verify-priority-refresh.ts.
 */
import { assertPriorityNumberCombo } from '../lib/config/feature-toggles';
import { runLiveDecisionPath } from '../lib/fyers/live-decision-path';
import type { SectorAggregate } from '../lib/sector/aggregate';
import { FEED_ORDER } from '../lib/priority-refresh/config';
import { buildPriorityPlan } from '../lib/priority-refresh/build-plan';
import { selectRoundRobinCandidates } from '../lib/priority-refresh/round-robin';
import { buildActiveSectorSignals, prepareSectorSnapshotWrite } from '../lib/priority-refresh/sector-producer';
import { qualifySectorDirection, selectActiveSectors, selectSectorPromotions } from '../lib/priority-refresh/sector-signal';
import { runPostDecisionShadowCore, type ShadowSettings } from '../lib/priority-refresh/shadow-orchestration';
import type { ActiveSectorSignal, FeedPicks, PriorityFeed, RankedFeedPick } from '../lib/priority-refresh/types';

type Check = (name: string, ok: boolean, detail?: string) => void;

function emptyFeeds(): FeedPicks {
  return Object.fromEntries(FEED_ORDER.map((s) => [s, [] as RankedFeedPick[]])) as FeedPicks;
}

/**
 * Build one feed's ranked picks. Entry: 'SYM' | [sym, pct] | [sym, pct, sector].
 * Mirrors candidates.ts: `pct` is the feed metric; only NON-oi feeds convey a
 * PRICE direction (nse-oi's metric is OI change, so priceDirectionPct is null).
 */
function feed(source: PriorityFeed, entries: Array<string | [string, number] | [string, number, string]>): RankedFeedPick[] {
  return entries.map((e, i) => {
    const sym = Array.isArray(e) ? e[0] : e;
    const pct = Array.isArray(e) ? e[1] : null;
    const sector = Array.isArray(e) ? (e[2] ?? 'X') : 'X';
    return {
      symbol: sym,
      sector,
      source,
      eligibleRank: i + 1,
      feedMetricPct: pct,
      priceDirectionPct: source === 'nse-oi' ? null : pct,
    };
  });
}

const names = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const NOW = 1_000_000;

function basePlanInput(feedPicks: FeedPicks, over: Partial<Parameters<typeof buildPriorityPlan>[0]> = {}) {
  return {
    feedPicks,
    riskBearingSymbols: [],
    earlierSuggestionSymbols: [],
    fullPrioritySymbols: [],
    fullUniverseSymbols: [],
    perFeedLimit: 10,
    maxUniqueTier1: 40,
    activeSectors: [] as ActiveSectorSignal[],
    sectorEnabled: false,
    sectorReservedSlots: 10,
    nowMs: NOW,
    ...over,
  };
}

const sector = (name: string, direction: 'bullish' | 'bearish', over: Partial<ActiveSectorSignal> = {}): ActiveSectorSignal => ({
  sector: name,
  direction,
  weightedPct: direction === 'bullish' ? 1.2 : -1.2,
  totalTurnover: 999,
  turnoverRank: 1,
  advanceRatio: direction === 'bullish' ? 0.8 : 0.2,
  stocks: 10,
  officialNsePct: null,
  asOfMs: NOW,
  ...over,
});

export function runPriorityRefreshChecks(check: Check): void {
  // ── Round-robin (pure) ─────────────────────────────────────────────────────
  {
    const f = emptyFeeds();
    f['nse-oi'] = feed('nse-oi', ['A', 'B', 'C']);
    f['nse-gainers'] = feed('nse-gainers', ['D', 'E']);
    const out = selectRoundRobinCandidates(f, 10, 40);
    check('round-robin interleaves feeds (no single feed dominates)', out.join(',') === 'A,D,B,E,C', out.join(','));
  }
  {
    const f = emptyFeeds();
    f['nse-oi'] = feed('nse-oi', ['A', 'B', 'C', 'D', 'E']);
    const out = selectRoundRobinCandidates(f, 10, 3);
    check('round-robin respects maxUnique cap', out.length === 3 && out.join(',') === 'A,B,C', out.join(','));
  }
  {
    const f = emptyFeeds();
    f['nse-oi'] = feed('nse-oi', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']);
    const out = selectRoundRobinCandidates(f, 10, 40);
    check('round-robin considers only perFeedLimit ranks (10, not 12)', out.length === 10 && !out.includes('K'), `n=${out.length}`);
  }
  {
    const f = emptyFeeds();
    f['nse-oi'] = feed('nse-oi', ['A', 'B']);
    f['nse-gainers'] = feed('nse-gainers', ['A', 'C']); // A duplicated across feeds
    const out = selectRoundRobinCandidates(f, 10, 40);
    check('round-robin dedupes cross-feed (one slot per symbol)', out.filter((s) => s === 'A').length === 1 && out.includes('C'), out.join(','));
  }
  {
    const f = emptyFeeds();
    f['nse-oi'] = feed('nse-oi', ['A']);
    const out = selectRoundRobinCandidates(f, 10, 40, new Set(['A', 'B']));
    check('round-robin honours exclude set (no re-adds, exclude not counted)', out.length === 0, out.join(','));
  }
  check('round-robin: empty feeds do not crash', selectRoundRobinCandidates(emptyFeeds(), 10, 40).length === 0);
  {
    const partial = { 'nse-oi': feed('nse-oi', ['A']) } as unknown as FeedPicks; // missing 4 feed keys
    check('round-robin: missing feed keys do not crash', selectRoundRobinCandidates(partial, 10, 40).join(',') === 'A');
  }

  // ── Plan: tiers, caps, determinism ─────────────────────────────────────────
  {
    const f = emptyFeeds();
    // 12 eligible OI names — already filtered (this IS body.picks), so cap applies to filtered list.
    f['nse-oi'] = feed('nse-oi', names('O', 12));
    const plan = buildPriorityPlan(basePlanInput(f));
    check('plan: cap applies to already-filtered picks (10 per feed)', plan.baseTier1Symbols.length === 10 && !plan.tier1Symbols.includes('O11'), `n=${plan.tier1Symbols.length}`);
  }
  {
    const f = emptyFeeds();
    for (const s of FEED_ORDER) f[s] = feed(s, names(`${s}-`, 10));
    const plan = buildPriorityPlan(basePlanInput(f));
    // 5 feeds × 10 unique = 50, capped to 40.
    check('plan: Tier 1 never exceeds maxUnique (50 candidates → 40)', plan.tier1Symbols.length === 40, `n=${plan.tier1Symbols.length}`);
    check('plan: all five feeds are represented', FEED_ORDER.every((s) => plan.tier1Symbols.some((sym) => sym.startsWith(`${s}-`))));
  }
  {
    const f = emptyFeeds();
    f['nse-oi'] = feed('nse-oi', ['A', 'B']);
    const plan1 = buildPriorityPlan(basePlanInput(f));
    const plan2 = buildPriorityPlan(basePlanInput(f));
    check('plan: ordering is deterministic', JSON.stringify(plan1.tier1Symbols) === JSON.stringify(plan2.tier1Symbols));
  }
  {
    const f = emptyFeeds();
    f['nse-oi'] = feed('nse-oi', ['A', 'B']);
    f['nse-gainers'] = feed('nse-gainers', ['A']); // A in two feeds
    const plan = buildPriorityPlan(basePlanInput(f));
    const a = plan.bySymbol['A'];
    check('plan: duplicate symbol keeps ALL feed ranks', a?.feedRanks['nse-oi'] === 1 && a?.feedRanks['nse-gainers'] === 1 && a.sourceCount === 2, JSON.stringify(a?.feedRanks));
  }

  // ── Plan: Tier 0 continuity + disjoint from Tier 1 (PR#9 review Blocker 1) ──
  {
    const f = emptyFeeds();
    // 5 feeds × 10 = 50 unique candidates → Tier 1 caps at 40.
    for (const s of FEED_ORDER) f[s] = feed(s, names(s, 10));
    const plan = buildPriorityPlan(basePlanInput(f, { riskBearingSymbols: ['POSN'], earlierSuggestionSymbols: ['PICK'] }));
    check('plan: Tier 0 holds risk-bearing + earlier picks even absent from feeds', plan.tier0Symbols.includes('POSN') && plan.tier0Symbols.includes('PICK'));
    check('plan: Tier 0 is NOT counted against the Tier 1 cap (Tier 1 still 40)', plan.tier1Symbols.length === 40, `n=${plan.tier1Symbols.length}`);
    check('plan: cappedWait = Tier 0 + Tier 1', plan.cappedWaitSymbols.length === 42 && plan.cappedWaitSymbols.includes('POSN'));
    check('plan: earlier suggestion tagged Tier 0 with reason', plan.bySymbol['PICK']?.tier === 0 && plan.bySymbol['PICK'].reasons.includes('earlier-suggestion'));
  }
  {
    // A risk-bearing symbol that is ALSO a top feed name must NOT consume a Tier 1
    // slot — Tier 1 stays 40 genuinely-new names, and the wait set is Tier0 + 40.
    const f = emptyFeeds();
    f['nse-oi'] = feed('nse-oi', ['SBIN', ...names('O', 9)]); // SBIN is OI rank #1
    f['nse-gainers'] = feed('nse-gainers', names('G', 10));
    f['nse-losers'] = feed('nse-losers', names('L', 10));
    f['nse-active-value'] = feed('nse-active-value', names('V', 10));
    f['nse-active-volume'] = feed('nse-active-volume', names('A', 10));
    const plan = buildPriorityPlan(basePlanInput(f, { riskBearingSymbols: ['SBIN'] }));
    check('plan: Tier 0 symbol in a feed is NOT double-counted in Tier 1', plan.tier0Symbols.length === 1 && !plan.tier1Symbols.includes('SBIN'));
    check('plan: Tier 1 is a full 40 NEW names despite the Tier 0 overlap', plan.tier1Symbols.length === 40, `n=${plan.tier1Symbols.length}`);
    check('plan: wait set = Tier 0 (1) + Tier 1 (40) = 41', plan.cappedWaitSymbols.length === 41, `n=${plan.cappedWaitSymbols.length}`);
  }
  {
    const f = emptyFeeds();
    f['nse-oi'] = feed('nse-oi', ['A', 'B']);
    const plan = buildPriorityPlan(basePlanInput(f, { fullPrioritySymbols: ['A', 'B', 'X', 'Y'], fullUniverseSymbols: ['Z'] }));
    check('plan: remaining full-priority names fall to Tier 2', plan.tier2Symbols.includes('X') && plan.tier2Symbols.includes('Y') && plan.tier2Symbols.includes('Z'));
    check('plan: Tier 2 excludes anything already in the capped wait set', !plan.tier2Symbols.includes('A') && !plan.tier2Symbols.includes('B'));
    check('plan: fullPrioritySymbols preserved on the plan (shadow comparison)', plan.fullPrioritySymbols.join(',') === 'A,B,X,Y');
  }

  // ── Plan: sector promotion inside the same cap ─────────────────────────────
  {
    // Small cap so the sector-aligned stock lands in a RESERVED slot, not the base.
    // maxUnique=5, reserved=2 → baseSlots=3. Base fills with A,E,B; SBIN (rank-2
    // gainer, PSU Bank, +move) is promoted into a reserved slot.
    const f = emptyFeeds();
    f['nse-oi'] = feed('nse-oi', ['A', 'B', 'C', 'D']);
    f['nse-gainers'] = feed('nse-gainers', ['E', ['SBIN', 2.0, 'PSU Bank']]);
    const plan = buildPriorityPlan(basePlanInput(f, { activeSectors: [sector('PSU Bank', 'bullish')], sectorEnabled: true, sectorReservedSlots: 2, maxUniqueTier1: 5 }));
    check('plan: sector reservation reduces base slots (5 cap − 2 reserved = 3 base)', plan.baseTier1Symbols.length === 3, `base=${plan.baseTier1Symbols.length}`);
    check('plan: sector-aligned feed stock is promoted (not via base)', plan.sectorPromotedSymbols.includes('SBIN') && !plan.baseTier1Symbols.includes('SBIN'));
    check('plan: sector promotion stays inside the cap (≤ 5 unique)', plan.tier1Symbols.length <= 5, `n=${plan.tier1Symbols.length}`);
    check('plan: promoted symbol carries active-sector reason + direction', plan.bySymbol['SBIN']?.sectorPromoted === true && plan.bySymbol['SBIN'].sectorDirection === 'bullish');
  }
  {
    // maxUnique=5, reserved=2 but NO active sectors → the 2 sector slots go unused
    // and round-robin fillers backfill so Tier 1 still fills toward the cap.
    const f = emptyFeeds();
    f['nse-oi'] = feed('nse-oi', ['A', 'B', 'C']);
    f['nse-gainers'] = feed('nse-gainers', ['D', 'E', 'F']);
    const plan = buildPriorityPlan(basePlanInput(f, { activeSectors: [], sectorEnabled: true, sectorReservedSlots: 2, maxUniqueTier1: 5 }));
    check('plan: sector reservation with no sectors still reserves base 3', plan.baseTier1Symbols.length === 3, `base=${plan.baseTier1Symbols.length}`);
    check('plan: unused sector slots return to round-robin (fills toward cap)', plan.tier1Symbols.length === 5, `n=${plan.tier1Symbols.length}`);
  }
  {
    // Stale snapshot (older than max age) → no active sectors → no promotion.
    const stale = selectActiveSectors({
      snapshots: [sector('PSU Bank', 'bullish', { asOfMs: NOW - 5 * 60 * 1000 })],
      topPerSide: 2,
      nowMs: NOW,
      maxAgeSec: 120,
    });
    check('sector: stale snapshot is dropped (no active sectors)', stale.bullish.length === 0 && stale.bearish.length === 0);
    const f = emptyFeeds();
    f['nse-oi'] = feed('nse-oi', [['SBIN', 2.0, 'PSU Bank']]);
    const plan = buildPriorityPlan(basePlanInput(f, { activeSectors: [], sectorEnabled: true }));
    check('plan: no active sectors → ordinary selection, no promotions', plan.sectorPromotedSymbols.length === 0);
  }
  {
    // The REAL next-cycle workflow: a snapshot produced by the previous 5-min
    // cycle is ~4–5 min old; under the corrected 420s default it must be ACCEPTED
    // (PR#11 review B3). The old 120s default would have rejected every read.
    const accepted = selectActiveSectors({
      snapshots: [sector('PSU Bank', 'bullish', { asOfMs: NOW - 270_000 })], // 4.5 min old
      topPerSide: 2,
      nowMs: NOW,
      maxAgeSec: 420,
    });
    check('sector: previous-cycle snapshot (270s old) accepted under 420s maxAge', accepted.bullish.length === 1);
    const rejected = selectActiveSectors({
      snapshots: [sector('PSU Bank', 'bullish', { asOfMs: NOW - 500_000 })], // > 420s
      topPerSide: 2,
      nowMs: NOW,
      maxAgeSec: 420,
    });
    check('sector: snapshot older than maxAge is still rejected', rejected.bullish.length === 0);
    const future = selectActiveSectors({
      snapshots: [sector('PSU Bank', 'bullish', { asOfMs: NOW + 1_000 })], // 1s in the future
      topPerSide: 2,
      nowMs: NOW,
      maxAgeSec: 420,
    });
    check('sector: future-timestamped snapshot rejected (negative age)', future.bullish.length === 0);
    const nan = selectActiveSectors({
      snapshots: [sector('PSU Bank', 'bullish', { asOfMs: Number.NaN })],
      topPerSide: 2,
      nowMs: NOW,
      maxAgeSec: 420,
    });
    check('sector: NaN-timestamped snapshot rejected', nan.bullish.length === 0);
  }
  {
    // PR#9 review Blocker 3: sector promotion must respect PRIORITY_PER_FEED. A
    // rank-11 stock in the strongest active sector must NOT be promoted.
    const f = emptyFeeds();
    f['nse-gainers'] = feed('nse-gainers', [...names('G', 10).map((s) => [s, 0.5, 'Other'] as [string, number, string]), ['PSU11', 2.0, 'PSU Bank']]);
    const plan = buildPriorityPlan(basePlanInput(f, { activeSectors: [sector('PSU Bank', 'bullish')], sectorEnabled: true, sectorReservedSlots: 2, maxUniqueTier1: 5 }));
    check('plan: rank-11 sector stock is NOT promoted (respects perFeedLimit)', !plan.sectorPromotedSymbols.includes('PSU11') && !plan.tier1Symbols.includes('PSU11'));
  }
  {
    // PR#9 review Blocker 2 (integrated): an nse-oi-only name has +OI% but UNKNOWN
    // price direction → must NOT be sector-promoted (it can still arrive via RR).
    const f = emptyFeeds();
    f['nse-oi'] = feed('nse-oi', ['x1', 'x2', 'x3', ['SBIN', 12, 'PSU Bank']]); // nse-oi: priceDirectionPct null
    const plan = buildPriorityPlan(basePlanInput(f, { activeSectors: [sector('PSU Bank', 'bullish')], sectorEnabled: true, sectorReservedSlots: 2, maxUniqueTier1: 5 }));
    check('plan: nse-oi-only name (OI% up, price unknown) is NOT sector-promoted', !plan.sectorPromotedSymbols.includes('SBIN'));
  }

  // ── Sector-signal (pure) ───────────────────────────────────────────────────
  check('sector: qualify bullish (weightedPct ≥ 0.5, advance ≥ 0.6)', qualifySectorDirection({ weightedPct: 0.7, advanceRatio: 0.65 }) === 'bullish');
  check('sector: qualify bearish (weightedPct ≤ -0.5, advance ≤ 0.4)', qualifySectorDirection({ weightedPct: -0.8, advanceRatio: 0.3 }) === 'bearish');
  check('sector: flat/mixed sector qualifies as neither', qualifySectorDirection({ weightedPct: 0.2, advanceRatio: 0.55 }) === null);
  check('sector: bullish % but weak breadth is not bullish', qualifySectorDirection({ weightedPct: 0.9, advanceRatio: 0.4 }) === null);
  // PR#9 review medium: unknown breadth must fail CLOSED, never qualify on % alone.
  check('sector: unknown breadth (advanceRatio null) + bullish % → not qualified', qualifySectorDirection({ weightedPct: 1.2, advanceRatio: null }) === null);
  check('sector: unknown breadth (advanceRatio null) + bearish % → not qualified', qualifySectorDirection({ weightedPct: -1.2, advanceRatio: null }) === null);
  {
    const sectors = [sector('PSU Bank', 'bullish')];
    const promoted = selectSectorPromotions({
      remainingFeedCandidates: [
        { symbol: 'SBIN', sector: 'PSU Bank', priceDirectionPct: 2.0 },
        { symbol: 'PNB', sector: 'PSU Bank', priceDirectionPct: -1.0 }, // wrong direction
        { symbol: 'TCS', sector: 'IT', priceDirectionPct: 3.0 }, // wrong sector
      ],
      activeSectors: sectors,
      existingSymbols: new Set(),
      maxPromotions: 10,
    });
    check('sector: bullish sector does NOT promote a negative-move stock', !promoted.includes('PNB'));
    check('sector: promotion requires stock in an ACTIVE sector', promoted.includes('SBIN') && !promoted.includes('TCS'));
  }
  {
    const promoted = selectSectorPromotions({
      remainingFeedCandidates: [
        { symbol: 'DLF', sector: 'Realty', priceDirectionPct: -2.0 },
        { symbol: 'GODREJPROP', sector: 'Realty', priceDirectionPct: 1.5 }, // positive → not promoted for a bearish sector
      ],
      activeSectors: [sector('Realty', 'bearish')],
      existingSymbols: new Set(),
      maxPromotions: 10,
    });
    check('sector: bearish sector does NOT promote a positive-move stock', promoted.includes('DLF') && !promoted.includes('GODREJPROP'));
  }
  {
    // PR#9 review Blocker 2 (unit): price direction, never OI change, drives it.
    const bull = [sector('PSU Bank', 'bullish')];
    check(
      'sector: candidate with UNKNOWN price direction (null) is NOT promoted',
      selectSectorPromotions({ remainingFeedCandidates: [{ symbol: 'SBIN', sector: 'PSU Bank', priceDirectionPct: null }], activeSectors: bull, existingSymbols: new Set(), maxPromotions: 5 }).length === 0
    );
    check(
      'sector: same name WITH a known +price is promoted (bullish)',
      selectSectorPromotions({ remainingFeedCandidates: [{ symbol: 'SBIN', sector: 'PSU Bank', priceDirectionPct: 1.5 }], activeSectors: bull, existingSymbols: new Set(), maxPromotions: 5 }).includes('SBIN')
    );
  }
  check(
    'sector: no active sectors → no promotions',
    selectSectorPromotions({ remainingFeedCandidates: [{ symbol: 'X', sector: 'Y', priceDirectionPct: 1 }], activeSectors: [], existingSymbols: new Set(), maxPromotions: 10 }).length === 0
  );

  // ── Config unsafe-combo guard (§30, pure) ──────────────────────────────────
  const throws = (fn: () => void): boolean => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  check('guard: reserved slots > max unique → rejected', throws(() => assertPriorityNumberCombo('PRIORITY_SECTOR_RESERVED_SLOTS', 41, { maxUnique: 40, reserved: 10 })));
  check('guard: reserved slots ≤ max unique → allowed', !throws(() => assertPriorityNumberCombo('PRIORITY_SECTOR_RESERVED_SLOTS', 10, { maxUnique: 40, reserved: 10 })));
  check('guard: max unique < reserved slots → rejected', throws(() => assertPriorityNumberCombo('PRIORITY_MAX_UNIQUE', 5, { maxUnique: 40, reserved: 10 })));

  // ── Sector producer (pure): SectorAggregate[] → ActiveSectorSignal[] ───────
  const agg = (sector: string, weightedPct: number, totalTurnover: number, advanceRatio: number | null): SectorAggregate => ({
    sector,
    stocks: 10,
    totalTurnover,
    weightedPct,
    simplePct: weightedPct,
    advancers: advanceRatio == null ? 0 : Math.round(advanceRatio * 10),
    decliners: advanceRatio == null ? 0 : 10 - Math.round(advanceRatio * 10),
    unchanged: 0,
    advanceRatio,
  });
  {
    const signals = buildActiveSectorSignals([agg('PSU Bank', 1.2, 1000, 0.8), agg('Realty', -1.2, 800, 0.2), agg('IT', 0.1, 900, 0.5)], NOW);
    check('producer: qualifying sectors become directional signals', signals.some((s) => s.sector === 'PSU Bank' && s.direction === 'bullish') && signals.some((s) => s.sector === 'Realty' && s.direction === 'bearish'));
    check('producer: flat sector (no direction) is omitted', !signals.some((s) => s.sector === 'IT'));
    check('producer: turnoverRank is by turnover desc (PSU Bank #1)', signals.find((s) => s.sector === 'PSU Bank')?.turnoverRank === 1);
  }
  {
    // Top-turnover restriction: a qualifying sector outside the top-N is excluded.
    const aggs = Array.from({ length: 8 }, (_, i) => agg(`S${i}`, 1.2, 1000 - i, 0.8));
    const signals = buildActiveSectorSignals(aggs, NOW, { topTurnover: 6 });
    check('producer: sector below the top-turnover group is excluded', signals.length === 6 && !signals.some((s) => s.sector === 'S6' || s.sector === 'S7'));
  }
  {
    const observedAtMs = 1_800_000_025_000;
    const scannerFinishedAtMs = observedAtMs + 105_000;
    const databaseWriteAtMs = scannerFinishedAtMs + 50_000;
    const write = prepareSectorSnapshotWrite({
      aggregates: [agg('PSU Bank', 1.2, 1000, 0.8)],
      marketDataAsOfMs: observedAtMs,
      currentCycleBucketTs: 1_800_000_000,
      nowMs: databaseWriteAtMs,
    });
    check('producer: delayed scan/write preserves Dhan observation timestamp', write.asOfMs === observedAtMs && write.signals.every((s) => s.asOfMs === observedAtMs));
    check('producer: sector bucket comes from Dhan observation time', write.bucketTs === 1_800_000_000, `bucket=${write.bucketTs}`);

    const invalid = prepareSectorSnapshotWrite({
      aggregates: [agg('PSU Bank', 1.2, 1000, 0.8)],
      marketDataAsOfMs: Number.NaN,
      currentCycleBucketTs: 1_800_000_300,
      nowMs: databaseWriteAtMs,
    });
    check('producer: invalid quote timestamp fails closed to current-cycle empty marker', invalid.bucketTs === 1_800_000_300 && invalid.asOfMs === 0 && invalid.signals.length === 0);
    const future = prepareSectorSnapshotWrite({
      aggregates: [agg('PSU Bank', 1.2, 1000, 0.8)],
      marketDataAsOfMs: databaseWriteAtMs + 1,
      currentCycleBucketTs: 1_800_000_300,
      nowMs: databaseWriteAtMs,
    });
    check('producer: future quote timestamp fails closed to current-cycle empty marker', future.asOfMs === 0 && future.signals.length === 0);
  }
}

export async function runPriorityRefreshOrchestrationChecks(check: Check): Promise<void> {
  const candidateSnapshot = {
    discoveredAt: NOW,
    fullUniverse: false,
    sectorEntries: [['SBIN', 'PSU Bank']] as [string, string][],
    oiSpurtSymbols: ['SBIN'],
    prioritySymbols: ['SBIN'],
    feedPicks: emptyFeeds(),
  };
  const input = {
    today: '2099-05-05',
    bucketTs: 1_800_000_300,
    candidateSnapshot,
    riskBearing: [],
    earlierSuggestions: [],
    fullPriority: ['SBIN'],
    universe: ['SBIN'],
  };
  const settings: ShadowSettings = {
    shadowEnabled: true,
    cappedLiveEnabled: false,
    blockStaleEntry: true,
    sectorShadowEnabled: true,
    sectorLiveEnabled: false,
    perFeedLimit: 10,
    maxUniqueTier1: 40,
    sectorReservedSlots: 10,
    topSectorsPerSide: 2,
    sectorMaxAgeSec: 420,
  };

  const events: string[] = ['candidate discovery', 'priority refresh starts'];
  await runLiveDecisionPath({
    scan: async () => {
      events.push('scan');
      return { suggestions: [], sectorAggregates: [], marketDataAsOfMs: 1_800_000_025_000 };
    },
    decide: async () => {
      events.push('Auto Trade decision');
      return { commentaryHandled: true, shadowSafe: true };
    },
    afterDecision: async (result, decision) => {
      if (!decision.shadowSafe) return;
      await runPostDecisionShadowCore(input, result, {
        readSettings: async () => {
          events.push('shadow settings read');
          return settings;
        },
        readPreviousSectors: async () => {
          events.push('shadow sector read');
          return [];
        },
        selectSectors: selectActiveSectors,
        buildPlan: (planInput) => {
          events.push('shadow plan build');
          return buildPriorityPlan(planInput);
        },
        prepareSectorWrite: prepareSectorSnapshotWrite,
        recordCycle: async () => {
          events.push('shadow telemetry persistence');
        },
        recordSectors: async () => {
          events.push('shadow sector persistence');
        },
        nowMs: () => 1_800_000_180_000,
      });
    },
  });
  const expected = [
    'candidate discovery',
    'priority refresh starts',
    'scan',
    'Auto Trade decision',
    'shadow settings read',
    'shadow sector read',
    'shadow plan build',
    'shadow telemetry persistence',
    'shadow sector persistence',
  ];
  check('orchestration: all shadow work is after refresh, scan, and Auto Trade decision', events.join('|') === expected.join('|'), events.join(' → '));

  const notOwnerEvents: string[] = [];
  await runLiveDecisionPath({
    scan: async () => ({ suggestions: [] }),
    decide: async () => ({ commentaryHandled: true, shadowSafe: false }),
    afterDecision: async (result, decision) => {
      if (!decision.shadowSafe) return;
      await runPostDecisionShadowCore(input, result, {
        readSettings: async () => {
          notOwnerEvents.push('settings read');
          return settings;
        },
        readPreviousSectors: async () => {
          notOwnerEvents.push('sector read');
          return [];
        },
        selectSectors: selectActiveSectors,
        buildPlan: (planInput) => {
          notOwnerEvents.push('planner build');
          return buildPriorityPlan(planInput);
        },
        prepareSectorWrite: prepareSectorSnapshotWrite,
        recordCycle: async () => {
          notOwnerEvents.push('telemetry write');
        },
        recordSectors: async () => {
          notOwnerEvents.push('sector write');
        },
        nowMs: () => NOW,
      });
    },
  });
  check(
    'orchestration: non-owner Auto Trade result skips every shadow read/build/write',
    notOwnerEvents.length === 0,
    notOwnerEvents.join(' → ')
  );

  const disabledEvents: string[] = [];
  await runPostDecisionShadowCore(input, { suggestions: [] }, {
    readSettings: async () => {
      disabledEvents.push('master toggle read');
      return null;
    },
    readPreviousSectors: async () => {
      disabledEvents.push('sector read');
      return [];
    },
    selectSectors: selectActiveSectors,
    buildPlan: (planInput) => {
      disabledEvents.push('planner build');
      return buildPriorityPlan(planInput);
    },
    prepareSectorWrite: prepareSectorSnapshotWrite,
    recordCycle: async () => {
      disabledEvents.push('telemetry write');
    },
    recordSectors: async () => {
      disabledEvents.push('sector write');
    },
    nowMs: () => NOW,
  });
  check('orchestration: shadow OFF performs no sector read, planner build, or write', disabledEvents.join('|') === 'master toggle read', disabledEvents.join(' → '));
}
