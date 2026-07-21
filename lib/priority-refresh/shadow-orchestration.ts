import type { SectorAggregate } from '@/lib/sector/aggregate';
import type { CandidateSnapshot } from '@/lib/trade-suggest/candidates';
import type { TradeSuggestion } from '@/lib/trade-suggest/types';
import type { ActiveSectorSignal, PriorityPlan } from './types';

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

/** Frozen data carried through the live path. Creating it performs no I/O. */
export interface ShadowCycleInput {
  today: string;
  bucketTs: number;
  candidateSnapshot: CandidateSnapshot;
  riskBearing: string[];
  earlierSuggestions: string[];
  fullPriority: string[];
  universe: string[];
}

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

export interface ShadowScanResult {
  suggestions?: TradeSuggestion[];
  sectorAggregates?: SectorAggregate[];
  marketDataAsOfMs?: number;
}

export interface SectorSnapshotWrite {
  bucketTs: number;
  asOfMs: number;
  signals: ActiveSectorSignal[];
}

export interface ShadowOrchestrationDeps {
  readSettings: () => Promise<ShadowSettings | null>;
  readPreviousSectors: (date: string, beforeBucketTs: number) => Promise<ActiveSectorSignal[]>;
  selectSectors: (input: { snapshots: ActiveSectorSignal[]; topPerSide: number; nowMs: number; maxAgeSec: number }) => {
    bullish: ActiveSectorSignal[];
    bearish: ActiveSectorSignal[];
  };
  buildPlan: (input: {
    feedPicks: CandidateSnapshot['feedPicks'];
    riskBearingSymbols: string[];
    earlierSuggestionSymbols: string[];
    fullPrioritySymbols: string[];
    fullUniverseSymbols: string[];
    perFeedLimit: number;
    maxUniqueTier1: number;
    activeSectors: ActiveSectorSignal[];
    sectorEnabled: boolean;
    sectorReservedSlots: number;
    nowMs: number;
  }) => PriorityPlan;
  prepareSectorWrite: (input: {
    aggregates: SectorAggregate[];
    marketDataAsOfMs: number | undefined;
    currentCycleBucketTs: number;
    nowMs: number;
  }) => SectorSnapshotWrite;
  recordCycle: (ctx: ShadowCycleContext, suggestions: TradeSuggestion[]) => Promise<void>;
  recordSectors: (date: string, bucketTs: number, asOfMs: number, signals: ActiveSectorSignal[]) => Promise<void>;
  nowMs: () => number;
}

/**
 * Runs only from the post-decision hook. A disabled master toggle returns after
 * its single settings read, before sector reads, planning, or persistence.
 */
export async function runPostDecisionShadowCore(
  input: ShadowCycleInput,
  result: ShadowScanResult,
  deps: ShadowOrchestrationDeps
): Promise<void> {
  const settings = await deps.readSettings();
  if (!settings?.shadowEnabled) return;

  const nowMs = deps.nowMs();
  let activeBullish: ActiveSectorSignal[] = [];
  let activeBearish: ActiveSectorSignal[] = [];
  if (settings.sectorShadowEnabled) {
    const previous = await deps.readPreviousSectors(input.today, input.bucketTs);
    const selected = deps.selectSectors({
      snapshots: previous,
      topPerSide: settings.topSectorsPerSide,
      nowMs,
      maxAgeSec: settings.sectorMaxAgeSec,
    });
    activeBullish = selected.bullish;
    activeBearish = selected.bearish;
  }

  const plan = deps.buildPlan({
    feedPicks: input.candidateSnapshot.feedPicks,
    riskBearingSymbols: input.riskBearing,
    earlierSuggestionSymbols: input.earlierSuggestions,
    fullPrioritySymbols: input.fullPriority,
    fullUniverseSymbols: input.universe,
    perFeedLimit: settings.perFeedLimit,
    maxUniqueTier1: settings.maxUniqueTier1,
    activeSectors: [...activeBullish, ...activeBearish],
    sectorEnabled: settings.sectorShadowEnabled,
    sectorReservedSlots: settings.sectorReservedSlots,
    nowMs,
  });
  const ctx: ShadowCycleContext = {
    plan,
    settings,
    today: input.today,
    bucketTs: input.bucketTs,
    universeCount: input.universe.length,
    scanPoolCount: input.candidateSnapshot.sectorEntries.length,
    fullPriorityCount: input.fullPriority.length,
    activeBullish: activeBullish.map((s) => s.sector),
    activeBearish: activeBearish.map((s) => s.sector),
  };

  await deps.recordCycle(ctx, result.suggestions ?? []);
  if (!settings.sectorShadowEnabled) return;

  const write = deps.prepareSectorWrite({
    aggregates: result.sectorAggregates ?? [],
    marketDataAsOfMs: result.marketDataAsOfMs,
    currentCycleBucketTs: input.bucketTs,
    nowMs: deps.nowMs(),
  });
  await deps.recordSectors(input.today, write.bucketTs, write.asOfMs, write.signals);
}
