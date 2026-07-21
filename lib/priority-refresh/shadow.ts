/**
 * Post-decision shadow orchestration. No settings, sector, planner, or store
 * work from this module is allowed on the live refresh/decision path.
 */
import { getNumberSetting, getToggle } from '@/lib/config/feature-toggles';
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
import { prepareSectorSnapshotWrite } from './sector-producer';
import { selectActiveSectors } from './sector-signal';
import { getLatestSectorSnapshotBefore, recordSectorSnapshot } from './sector-snapshot-store';
import {
  runPostDecisionShadowCore,
  type ShadowCycleContext,
  type ShadowCycleInput,
  type ShadowScanResult,
  type ShadowSettings,
} from './shadow-orchestration';
import { recordPriorityCycle } from './telemetry-store';

export type { ShadowCycleContext, ShadowCycleInput, ShadowSettings } from './shadow-orchestration';

/** Read the master toggle alone first so OFF performs no other shadow work. */
export async function readShadowSettings(): Promise<ShadowSettings | null> {
  const shadowEnabled = await getToggle('PRIORITY_REFRESH_SHADOW', PRIORITY_REFRESH_SHADOW);
  if (!shadowEnabled) return null;

  const [
    blockStaleEntry,
    sectorShadowEnabled,
    perFeedLimit,
    maxUniqueTier1,
    sectorReservedSlots,
    topSectorsPerSide,
    sectorMaxAgeSec,
  ] = await Promise.all([
    getToggle('BLOCK_STALE_AUTO_ENTRY', BLOCK_STALE_AUTO_ENTRY),
    getToggle('PRIORITY_ACTIVE_SECTORS_SHADOW', PRIORITY_ACTIVE_SECTORS_SHADOW),
    getNumberSetting('PRIORITY_PER_FEED', PRIORITY_PER_FEED),
    getNumberSetting('PRIORITY_MAX_UNIQUE', PRIORITY_MAX_UNIQUE),
    getNumberSetting('PRIORITY_SECTOR_RESERVED_SLOTS', PRIORITY_SECTOR_RESERVED_SLOTS),
    getNumberSetting('PRIORITY_TOP_SECTORS_PER_SIDE', PRIORITY_TOP_SECTORS_PER_SIDE),
    getNumberSetting('PRIORITY_SECTOR_MAX_AGE_SEC', PRIORITY_SECTOR_MAX_AGE_SEC),
  ]);

  return {
    shadowEnabled: true,
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

/** Record one cycle's membership and suggestion-coverage telemetry. */
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

/** Build and persist all shadow artifacts after the live decision. */
export async function runPostDecisionShadow(input: ShadowCycleInput, result: ShadowScanResult): Promise<void> {
  try {
    await runPostDecisionShadowCore(input, result, {
      readSettings: readShadowSettings,
      readPreviousSectors: getLatestSectorSnapshotBefore,
      selectSectors: selectActiveSectors,
      buildPlan: buildPriorityPlan,
      prepareSectorWrite: prepareSectorSnapshotWrite,
      recordCycle: recordShadowCycle,
      recordSectors: recordSectorSnapshot,
      nowMs: Date.now,
    });
  } catch (err) {
    console.warn(`[priority-refresh] post-decision shadow failed: ${(err as Error).message}`);
  }
}
