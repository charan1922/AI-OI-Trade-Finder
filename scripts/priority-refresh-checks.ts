/**
 * Pure, DB-free checks for the capped priority-refresh planner
 * (lib/priority-refresh/*). Mirrors the planner / round-robin / sector-selection
 * tests in final-capped-priority-sector-plan.md §35. No database, no I/O — runs
 * in GitHub CI via scripts/verify-priority-refresh.ts.
 */
import { FEED_ORDER } from '../lib/priority-refresh/config';
import { buildPriorityPlan } from '../lib/priority-refresh/build-plan';
import { selectRoundRobinCandidates } from '../lib/priority-refresh/round-robin';
import { qualifySectorDirection, selectActiveSectors, selectSectorPromotions } from '../lib/priority-refresh/sector-signal';
import type { ActiveSectorSignal, FeedPicks, PriorityFeed, RankedFeedPick } from '../lib/priority-refresh/types';

type Check = (name: string, ok: boolean, detail?: string) => void;

function emptyFeeds(): FeedPicks {
  return Object.fromEntries(FEED_ORDER.map((s) => [s, [] as RankedFeedPick[]])) as FeedPicks;
}

/** Build one feed's ranked picks. Entry: 'SYM' | [sym, retPct] | [sym, retPct, sector]. */
function feed(source: PriorityFeed, entries: Array<string | [string, number] | [string, number, string]>): RankedFeedPick[] {
  return entries.map((e, i) => {
    if (Array.isArray(e)) return { symbol: e[0], sector: e[2] ?? 'X', source, eligibleRank: i + 1, retPct: e[1] };
    return { symbol: e, sector: 'X', source, eligibleRank: i + 1, retPct: null };
  });
}

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

export function runPriorityRefreshChecks(check: Check): void {
  // ── Round-robin (pure) ─────────────────────────────────────────────────────
  {
    const f = emptyFeeds();
    f['nse-oi'] = feed('nse-oi', ['A', 'B', 'C']);
    f['nse-gainers'] = feed('nse-gainers', ['D', 'E']);
    const out = selectRoundRobinCandidates(f, 10, 40);
    // round 1: A, D ; round 2: B, E ; round 3: C
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
    f['nse-oi'] = feed('nse-oi', Array.from({ length: 12 }, (_, i) => `O${i + 1}`));
    const plan = buildPriorityPlan(basePlanInput(f));
    check('plan: cap applies to already-filtered picks (10 per feed)', plan.baseTier1Symbols.length === 10 && !plan.tier1Symbols.includes('O11'), `n=${plan.tier1Symbols.length}`);
  }
  {
    const f = emptyFeeds();
    for (const s of FEED_ORDER) f[s] = feed(s, Array.from({ length: 10 }, (_, i) => `${s}-${i + 1}`));
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

  // ── Plan: Tier 0 continuity ────────────────────────────────────────────────
  {
    const f = emptyFeeds();
    // 5 feeds × 10 = 50 unique candidates → Tier 1 caps at 40.
    for (const s of FEED_ORDER) f[s] = feed(s, Array.from({ length: 10 }, (_, i) => `${s}${i + 1}`));
    const plan = buildPriorityPlan(basePlanInput(f, { riskBearingSymbols: ['POSN'], earlierSuggestionSymbols: ['PICK'] }));
    check('plan: Tier 0 holds risk-bearing + earlier picks even absent from feeds', plan.tier0Symbols.includes('POSN') && plan.tier0Symbols.includes('PICK'));
    check('plan: Tier 0 is NOT counted against the Tier 1 cap (Tier 1 still 40)', plan.tier1Symbols.length === 40, `n=${plan.tier1Symbols.length}`);
    check('plan: cappedWait = Tier 0 + Tier 1', plan.cappedWaitSymbols.length === 42 && plan.cappedWaitSymbols.includes('POSN'));
    check('plan: earlier suggestion tagged Tier 0 with reason', plan.bySymbol['PICK']?.tier === 0 && plan.bySymbol['PICK'].reasons.includes('earlier-suggestion'));
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
    const sectors: ActiveSectorSignal[] = [
      { sector: 'PSU Bank', direction: 'bullish', weightedPct: 1.2, totalTurnover: 999, turnoverRank: 1, advanceRatio: 0.8, stocks: 10, officialNsePct: null, asOfMs: NOW },
    ];
    const plan = buildPriorityPlan(basePlanInput(f, { activeSectors: sectors, sectorEnabled: true, sectorReservedSlots: 2, maxUniqueTier1: 5 }));
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
    const f = emptyFeeds();
    f['nse-oi'] = feed('nse-oi', [['SBIN', 2.0, 'PSU Bank']]);
    // Stale snapshot (older than max age) → no active sectors → no promotion.
    const stale = selectActiveSectors({
      snapshots: [{ sector: 'PSU Bank', direction: 'bullish', weightedPct: 1.2, totalTurnover: 9, turnoverRank: 1, advanceRatio: 0.8, stocks: 10, officialNsePct: null, asOfMs: NOW - 5 * 60 * 1000 }],
      topPerSide: 2,
      nowMs: NOW,
      maxAgeSec: 120,
    });
    check('sector: stale snapshot is dropped (no active sectors)', stale.bullish.length === 0 && stale.bearish.length === 0);
    const plan = buildPriorityPlan(basePlanInput(f, { activeSectors: [], sectorEnabled: true }));
    check('plan: no active sectors → ordinary selection, no promotions', plan.sectorPromotedSymbols.length === 0);
  }

  // ── Sector-signal (pure) ───────────────────────────────────────────────────
  check('sector: qualify bullish (weightedPct ≥ 0.5, advance ≥ 0.6)', qualifySectorDirection({ weightedPct: 0.7, advanceRatio: 0.65 }) === 'bullish');
  check('sector: qualify bearish (weightedPct ≤ -0.5, advance ≤ 0.4)', qualifySectorDirection({ weightedPct: -0.8, advanceRatio: 0.3 }) === 'bearish');
  check('sector: flat/mixed sector qualifies as neither', qualifySectorDirection({ weightedPct: 0.2, advanceRatio: 0.55 }) === null);
  check('sector: bullish % but weak breadth is not bullish', qualifySectorDirection({ weightedPct: 0.9, advanceRatio: 0.4 }) === null);
  {
    const sectors: ActiveSectorSignal[] = [
      { sector: 'PSU Bank', direction: 'bullish', weightedPct: 1, totalTurnover: 9, turnoverRank: 1, advanceRatio: 0.8, stocks: 5, officialNsePct: null, asOfMs: NOW },
    ];
    const promoted = selectSectorPromotions({
      remainingFeedCandidates: [
        { symbol: 'SBIN', sector: 'PSU Bank', source: 'nse-oi', eligibleRank: 1, retPct: 2.0 },
        { symbol: 'PNB', sector: 'PSU Bank', source: 'nse-oi', eligibleRank: 2, retPct: -1.0 }, // wrong direction
        { symbol: 'TCS', sector: 'IT', source: 'nse-oi', eligibleRank: 3, retPct: 3.0 }, // wrong sector
      ],
      activeSectors: sectors,
      existingSymbols: new Set(),
      maxPromotions: 10,
    });
    check('sector: bullish sector does NOT promote a negative-move stock', !promoted.includes('PNB'));
    check('sector: promotion requires stock in an ACTIVE sector', promoted.includes('SBIN') && !promoted.includes('TCS'));
  }
  {
    const sectors: ActiveSectorSignal[] = [
      { sector: 'Realty', direction: 'bearish', weightedPct: -1, totalTurnover: 9, turnoverRank: 1, advanceRatio: 0.2, stocks: 5, officialNsePct: null, asOfMs: NOW },
    ];
    const promoted = selectSectorPromotions({
      remainingFeedCandidates: [
        { symbol: 'DLF', sector: 'Realty', source: 'nse-losers', eligibleRank: 1, retPct: -2.0 },
        { symbol: 'GODREJPROP', sector: 'Realty', source: 'nse-gainers', eligibleRank: 2, retPct: 1.5 }, // positive → not promoted for a bearish sector
      ],
      activeSectors: sectors,
      existingSymbols: new Set(),
      maxPromotions: 10,
    });
    check('sector: bearish sector does NOT promote a positive-move stock', promoted.includes('DLF') && !promoted.includes('GODREJPROP'));
  }
  check(
    'sector: no active sectors → no promotions',
    selectSectorPromotions({ remainingFeedCandidates: [{ symbol: 'X', sector: 'Y', source: 'nse-oi', eligibleRank: 1, retPct: 1 }], activeSectors: [], existingSymbols: new Set(), maxPromotions: 10 }).length === 0
  );
}
