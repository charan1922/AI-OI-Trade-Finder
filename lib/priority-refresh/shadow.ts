/**
 * Shadow orchestration for the poller (plan §20-22). Builds the reduced
 * priority plan each cycle and records what it WOULD have done — the proposed
 * Tier 0/Tier 1 membership + which of that cycle's suggestions fell OUTSIDE the
 * proposed cap (coverage). It does NOT reorder the download and does NOT measure
 * timing (that ships with the capped-live PR, where the reorder is the real
 * behaviour), so it NEVER changes what the poller waits for or how it trades.
 * Everything here is best-effort; a failure is swallowed so the poller/scan are
 * never affected.
 */
import { getNumberSetting, getToggle } from '@/lib/config/feature-toggles';
import type { CandidateSnapshot } from '@/lib/trade-suggest/candidates';
import type { TradeSuggestion } from '@/lib/trade-suggest/types';
import { buildPriorityPlan } from './build-plan';
import {
  BLOCK_STALE_AUTO_ENTRY,
  PRIORITY_ACTIVE_SECTORS_SHADOW,
  PRIORITY_MAX_UNIQUE,
  PRIORITY_PER_FEED,
  PRIORITY_REFRESH_SHADOW,
  PRIORITY_SECTOR_MAX_AGE_SEC,
  PRIORITY_SECTOR_RESERVED_SLOTS,
  PRIORITY_TOP_SECTORS_PER_SIDE,
} from './config';
import { selectActiveSectors } from './sector-signal';
import { getLatestSectorSnapshot } from './sector-snapshot-store';
import { recordPriorityCycle } from './telemetry-store';
import type { PriorityPlan } from './types';

export interface ShadowSettings {
  shadowEnabled: boolean;
  cappedLiveEnabled: boolean;
  blockStaleEntry: boolean;
  sectorShadowEnabled: boolean;
  sectorLiveEnabled: boolean;
  perFeedLimit: number;
  maxUniqueTier1: number;
  sectorReservedSlots: number;
  topSectorsPerSide: number;
  sectorMaxAgeSec: number;
}

export async function readShadowSettings(): Promise<ShadowSettings> {
  const [
    shadowEnabled,
    blockStaleEntry,
    sectorShadowEnabled,
    perFeedLimit,
    maxUniqueTier1,
    sectorReservedSlots,
    topSectorsPerSide,
    sectorMaxAgeSec,
  ] = await Promise.all([
    getToggle('PRIORITY_REFRESH_SHADOW', PRIORITY_REFRESH_SHADOW),
    getToggle('BLOCK_STALE_AUTO_ENTRY', BLOCK_STALE_AUTO_ENTRY),
    getToggle('PRIORITY_ACTIVE_SECTORS_SHADOW', PRIORITY_ACTIVE_SECTORS_SHADOW),
    getNumberSetting('PRIORITY_PER_FEED', PRIORITY_PER_FEED),
    getNumberSetting('PRIORITY_MAX_UNIQUE', PRIORITY_MAX_UNIQUE),
    getNumberSetting('PRIORITY_SECTOR_RESERVED_SLOTS', PRIORITY_SECTOR_RESERVED_SLOTS),
    getNumberSetting('PRIORITY_TOP_SECTORS_PER_SIDE', PRIORITY_TOP_SECTORS_PER_SIDE),
    getNumberSetting('PRIORITY_SECTOR_MAX_AGE_SEC', PRIORITY_SECTOR_MAX_AGE_SEC),
  ]);
  return {
    shadowEnabled,
    // Capped-live and sector-live are NOT implemented or registered in this
    // measurement PR — hardcode false so a stale hidden SQLite row can never make
    // the operator panel claim "LIVE mode on" (PR#11 re-review B1b). The future
    // live PRs register those toggles with their real behaviour + guard.
    cappedLiveEnabled: false,
    blockStaleEntry,
    sectorShadowEnabled,
    sectorLiveEnabled: false,
    perFeedLimit,
    maxUniqueTier1,
    sectorReservedSlots,
    topSectorsPerSide,
    sectorMaxAgeSec,
  };
}

/** Assembled shadow context for one cycle (membership + coverage only — this PR
 *  measures no timing; the reorder needed for a faithful timing read ships with
 *  the capped-live PR). Suggestions are supplied after the scan. */
export interface ShadowCycleContext {
  plan: PriorityPlan;
  settings: ShadowSettings;
  today: string;
  bucketTs: number;
  universeCount: number;
  scanPoolCount: number;
  fullPriorityCount: number;
  activeBullish: string[];
  activeBearish: string[];
}

/**
 * Build the reduced plan for this cycle from the candidate snapshot + positions
 * + earlier picks, using the stored (previous-cycle) sector snapshot. Returns
 * null when shadow is disabled or there is nothing to plan. Best-effort: any
 * failure logs and returns null so the poller proceeds exactly as today.
 */
export async function buildShadowCycleContext(input: {
  today: string;
  bucketTs: number;
  candidateSnapshot: CandidateSnapshot;
  riskBearing: string[];
  earlierSuggestions: string[];
  fullPriority: string[];
  universe: string[];
}): Promise<ShadowCycleContext | null> {
  try {
    const settings = await readShadowSettings();
    if (!settings.shadowEnabled) return null;

    let activeBullish: string[] = [];
    let activeBearish: string[] = [];
    let activeSectors: Awaited<ReturnType<typeof getLatestSectorSnapshot>> = [];
    if (settings.sectorShadowEnabled) {
      const snapshot = await getLatestSectorSnapshot(input.today);
      const sel = selectActiveSectors({
        snapshots: snapshot,
        topPerSide: settings.topSectorsPerSide,
        nowMs: Date.now(),
        maxAgeSec: settings.sectorMaxAgeSec,
      });
      activeSectors = [...sel.bullish, ...sel.bearish];
      activeBullish = sel.bullish.map((s) => s.sector);
      activeBearish = sel.bearish.map((s) => s.sector);
    }

    const plan = buildPriorityPlan({
      feedPicks: input.candidateSnapshot.feedPicks,
      riskBearingSymbols: input.riskBearing,
      earlierSuggestionSymbols: input.earlierSuggestions,
      fullPrioritySymbols: input.fullPriority,
      fullUniverseSymbols: input.universe,
      perFeedLimit: settings.perFeedLimit,
      maxUniqueTier1: settings.maxUniqueTier1,
      activeSectors,
      sectorEnabled: settings.sectorShadowEnabled,
      sectorReservedSlots: settings.sectorReservedSlots,
      nowMs: Date.now(),
    });

    return {
      plan,
      settings,
      today: input.today,
      bucketTs: input.bucketTs,
      universeCount: input.universe.length,
      scanPoolCount: input.candidateSnapshot.sectorEntries.length,
      fullPriorityCount: input.fullPriority.length,
      activeBullish,
      activeBearish,
    };
  } catch (err) {
    console.warn(`[priority-refresh] shadow plan build failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Record the cycle's shadow telemetry after the scan, including which of this
 * cycle's suggestions fell OUTSIDE the proposed cap (the coverage evidence).
 * Best-effort — never throws.
 */
export async function recordShadowCycle(ctx: ShadowCycleContext, suggestions: TradeSuggestion[]): Promise<void> {
  const cappedSet = new Set(ctx.plan.cappedWaitSymbols);
  const outside = suggestions.filter((s) => !cappedSet.has(s.symbol)).map((s) => s.symbol);
  await recordPriorityCycle({
    date: ctx.today,
    bucketTs: ctx.bucketTs,
    shadowEnabled: ctx.settings.shadowEnabled,
    cappedLiveEnabled: ctx.settings.cappedLiveEnabled,
    blockStaleEntry: ctx.settings.blockStaleEntry,
    sectorShadowEnabled: ctx.settings.sectorShadowEnabled,
    sectorLiveEnabled: ctx.settings.sectorLiveEnabled,
    perFeedLimit: ctx.settings.perFeedLimit,
    maxUniqueTier1: ctx.settings.maxUniqueTier1,
    sectorReservedSlots: ctx.settings.sectorReservedSlots,
    universeCount: ctx.universeCount,
    scanPoolCount: ctx.scanPoolCount,
    fullPriorityCount: ctx.fullPriorityCount,
    tier0Count: ctx.plan.tier0Symbols.length,
    baseTier1Count: ctx.plan.baseTier1Symbols.length,
    sectorPromotedCount: ctx.plan.sectorPromotedSymbols.length,
    cappedWaitCount: ctx.plan.cappedWaitSymbols.length,
    suggestionCount: suggestions.length,
    suggestionsOutsideCap: outside.length,
    outsideCapSymbols: outside,
    activeBullishSectors: ctx.activeBullish,
    activeBearishSectors: ctx.activeBearish,
  });
}
