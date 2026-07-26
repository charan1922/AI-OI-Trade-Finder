/**
 * Pure policy for deciding what the AI may see on an entry-capable pass versus
 * a position-management-only pass. Kept free of DB/network imports so the
 * exact context contract can run in CI.
 */

import type { SuggestResponse, TradeSuggestion } from '@/lib/trade-suggest/types';
import type { AccountState } from '../types';

export interface DecisionOpenPosition {
  tradeId: number;
  symbol: string;
  direction: 'bullish' | 'bearish';
  contract: string;
  strike: number;
  optionType: 'CE' | 'PE';
  expiryDate: string;
  lotSize: number;
  lots: number;
  entrySpot: number;
  slSpot: number | null;
  targetSpot: number | null;
  entryFillPremium: number | null;
  slPremium: number;
  targetPremium: number;
  livePremium: number | null;
  liveBid: number | null;
  liveAsk: number | null;
  liveSpreadPct: number | null;
  quoteFreshThisPass: boolean;
  liveSpot: number | null;
  spotPointsFromEntry: number | null;
  openedAt: string | null;
  entryReason: string;
}

/** Full candidate view used only when a new entry can actually be considered. */
function trimEntryPick(s: TradeSuggestion): Record<string, unknown> {
  return {
    symbol: s.symbol,
    direction: s.direction,
    side: s.option?.optionType ?? (s.direction === 'bullish' ? 'CE' : 'PE'),
    strike: s.option?.strike ?? null,
    expiry: s.option?.expiryDate ?? null,
    score: s.score,
    rFactor: s.rFactor,
    confidence: s.rFactorConfidence,
    oiLevel: s.oiLevel,
    oiUrgency: s.oiUrgency,
    orBreakout: s.orBreakout,
    tfBreakout: s.tfBreakout && {
      grade: s.tfBreakout.grade,
      direction: s.tfBreakout.direction,
    },
    extended: s.extended,
    entrySpot: s.plan.entrySpot,
    slSpot: s.plan.slSpot,
    targetSpot: s.plan.targetSpot,
    premium: s.option?.premium?.ltp ?? null,
    perLotCost: s.option?.premium?.perLotCost ?? null,
    liquidityWarning: s.option?.premium?.liquidityWarning ?? null,
    factors: s.factors && {
      vwapAligned: s.factors.vwapAligned,
      supertrendAligned: s.factors.supertrendAligned,
      combinedOiSlope30m: s.factors.combinedOiSlope30m,
      sectorAligned: s.factors.sectorAligned,
    },
    reasons: s.reasons,
    eligible: Boolean(s.option?.premium && s.plan.slSpot != null),
  };
}

export function buildScanContext(
  scan: SuggestResponse | null,
  options: { entryEnabled?: boolean; managedSymbols?: readonly string[] } = {}
): Record<string, unknown> {
  if (!scan) return { note: 'no scan this cycle; manage open positions only', picks: [] };
  if (options.entryEnabled === false) {
    const managed = new Set((options.managedSymbols ?? []).map((symbol) => symbol.toUpperCase()));
    return {
      mode: 'position-management-only',
      window: scan.window,
      tilt: scan.tilt,
      signals: (scan.managedPositionSignals ?? []).filter((signal) =>
        managed.has(signal.symbol.toUpperCase())
      ),
    };
  }
  return {
    window: scan.window,
    scanned: scan.scanned,
    gated: scan.gated,
    tilt: scan.tilt,
    picks: (scan.suggestions ?? []).map(trimEntryPick),
  };
}

/**
 * A tracked scanner row may be the only current spot observation after a name
 * drops from suggestions. Merge only that live spot into the real held trade;
 * never copy the tracked row's original plan back over the mutable trade.
 */
export function mergeTrackedLiveSpots(
  openPositions: readonly DecisionOpenPosition[],
  scan: SuggestResponse | null
): DecisionOpenPosition[] {
  const trackedSpots = new Map(
    (scan?.tracked ?? []).map((tracked) => [tracked.symbol.toUpperCase(), tracked.ltp] as const)
  );
  return openPositions.map((position) => {
    if (position.liveSpot != null) return { ...position };
    const trackedSpot = trackedSpots.get(position.symbol.toUpperCase()) ?? null;
    if (trackedSpot == null) return { ...position };
    return {
      ...position,
      liveSpot: trackedSpot,
      spotPointsFromEntry: Math.round((trackedSpot - position.entrySpot) * 100) / 100,
    };
  });
}

export interface EntryConsiderationInput {
  accountState: Pick<
    AccountState,
    | 'mode'
    | 'killSwitch'
    | 'liveEnvEnabled'
    | 'marketOpen'
    | 'entryWindowActive'
    | 'entriesToday'
    | 'maxTradesPerDay'
    | 'openLots'
    | 'maxOpenLots'
    | 'deployedRupees'
    | 'maxCapitalRupees'
    | 'dailyRealizedPnlRupees'
    | 'dailyLossHaltRupees'
  >;
  hasEntryCandidate: boolean;
  exchangeSessionVerified: boolean;
  riskLatchReasons: readonly string[];
  staleEntryProtectionEnabled: boolean;
  freshCandidateAvailable: boolean;
}

export interface EntryConsideration {
  allowed: boolean;
  reasons: string[];
}

/** Cheap pass-wide gates only. Contract quote/spread/slippage remain check_order gates. */
export function evaluateEntryConsideration(input: EntryConsiderationInput): EntryConsideration {
  const { accountState: state } = input;
  const reasons: string[] = [];
  if (!input.hasEntryCandidate) reasons.push('no scanner candidate');
  if (state.mode === 'off') reasons.push('auto-trade mode is off');
  if (state.killSwitch) reasons.push('kill switch is on');
  if (state.mode === 'live' && !state.liveEnvEnabled) reasons.push('live two-key authorization is absent');
  if (!state.marketOpen) reasons.push('market is closed');
  if (!state.entryWindowActive) reasons.push('entry window is closed');
  if (!input.exchangeSessionVerified) reasons.push('exchange session is not verified');
  if (input.riskLatchReasons.length > 0) reasons.push(`risk latch: ${input.riskLatchReasons.join('; ')}`);
  if (state.entriesToday >= state.maxTradesPerDay) reasons.push('daily trade cap is reached');
  if (state.openLots + 1 > state.maxOpenLots) reasons.push('open-lot cap is reached');
  if (state.deployedRupees >= state.maxCapitalRupees) reasons.push('capital is fully reserved');
  if (state.dailyRealizedPnlRupees <= -state.dailyLossHaltRupees) reasons.push('daily-loss halt is active');
  if (input.staleEntryProtectionEnabled && !input.freshCandidateAvailable) {
    reasons.push('all scanner candidates have stale or missing completed candles');
  }
  return { allowed: reasons.length === 0, reasons };
}

export function composeDecisionContext(input: {
  accountState: AccountState;
  openPositions: readonly DecisionOpenPosition[];
  scan: SuggestResponse | null;
  entryEnabled: boolean;
  entryBlockReasons?: readonly string[];
}): {
  accountState: AccountState & { entryConsiderationAllowed: boolean; entryBlockReasons: readonly string[] };
  openPositions: DecisionOpenPosition[];
  scan: Record<string, unknown>;
} {
  const openPositions = mergeTrackedLiveSpots(input.openPositions, input.scan);
  const managedSymbols = openPositions.map((position) => position.symbol);
  return {
    accountState: {
      ...input.accountState,
      entryConsiderationAllowed: input.entryEnabled,
      entryBlockReasons: input.entryBlockReasons ?? [],
    },
    openPositions,
    scan: buildScanContext(input.scan, { entryEnabled: input.entryEnabled, managedSymbols }),
  };
}

/** Keep only the prior market header, held-symbol sections and Bottom line. */
export function filterPreviousReadForManagement(
  previousRead: string | null,
  managedSymbols: readonly string[]
): string | null {
  if (!previousRead) return null;
  const managed = new Set(managedSymbols.map((symbol) => symbol.toUpperCase()));
  const lines = previousRead.split('\n');
  const headingIndexes = lines.flatMap((line, index) => (/^#{1,4}\s+/.test(line.trim()) ? [index] : []));
  if (headingIndexes.length === 0) return null;

  const kept: string[] = [];
  const intro = lines.slice(0, headingIndexes[0]).join('\n').trim();
  if (intro) kept.push(intro);
  for (let i = 0; i < headingIndexes.length; i += 1) {
    const start = headingIndexes[i];
    const end = headingIndexes[i + 1] ?? lines.length;
    const heading = lines[start].replace(/^#{1,4}\s+/, '').replace(/\*\*/g, '').trim();
    const firstToken = heading.split(/\s|—|–/)[0]?.toUpperCase() ?? '';
    if (firstToken === 'BOTTOM' || managed.has(firstToken)) {
      kept.push(lines.slice(start, end).join('\n').trim());
    }
  }
  return kept.length > 0 ? kept.join('\n\n') : null;
}
