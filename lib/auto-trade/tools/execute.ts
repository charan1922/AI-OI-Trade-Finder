/**
 * Tool executors — where the AI's requests meet the hard gates. Every mutating
 * tool re-validates EVERYTHING in code (risk/gates.ts) against fresh DB state
 * and fresh quotes; the model's arguments are treated as untrusted input.
 *
 * The executors close over a ToolRuntime (this cycle's scan + settings) built
 * once per engine pass — the model can only ever act on THIS cycle's picks.
 */

import { isMarketHours } from '@/lib/dhan/market-feed';
import { isAutoTradeLiveEnabled } from '@/lib/env';
import { getNumberSetting } from '@/lib/config/feature-toggles';
import { COMMENTARY_ENTRY_CUTOFF_MIN_DEFAULT } from '@/lib/ai-commentary/generate';
import type { SuggestResponse, TradeSuggestion } from '@/lib/trade-suggest/types';
import { alerts } from '../alerts';
import { getExecutionAdapter } from '../brokers';
import { isEntryWindow, istMinuteLabel, minuteOfDayIST, nowISTClock } from '../config';
import { exitTrade, placeEntryOrder, type ExecOutcome } from '../execution';
import { fetchOptionQuote, fetchOptionQuotes, latestSpot, type OptionQuote } from '../quotes';
import { checkEntryGates, checkStopMove, type EntryGateInput } from '../risk/gates';
import { getAutoTradeSettings } from '../settings';
import {
  countEntriesToday,
  dailyRealizedPnl,
  getExposure,
  getOpenTrades,
  getPendingApprovals,
  getTrade,
  insertTrade,
  symbolTradedToday,
  updateTrade,
} from '../store';
import type { AccountState, AutoTradeSettings, ToolTraceEntry } from '../types';

export interface ToolRuntime {
  scan: SuggestResponse | null;
  settings: AutoTradeSettings;
  date: string;
}

interface ToolResult {
  result: unknown;
  trace: ToolTraceEntry;
}

function findPick(rt: ToolRuntime, symbol: string): TradeSuggestion | null {
  const sym = symbol.toUpperCase();
  return rt.scan?.suggestions?.find((s) => s.symbol.toUpperCase() === sym) ?? null;
}

/** Compact, grounded view of one pick (mirrors the commentary trim). */
function trimPick(s: TradeSuggestion): Record<string, unknown> {
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
    /** Enterable at all: contract + live premium + a spot stop must exist. */
    eligible: Boolean(s.option?.premium && s.plan.slSpot != null),
  };
}

/** Scanner context small enough to include directly in the model's first turn. */
export function buildScanContext(scan: SuggestResponse | null): Record<string, unknown> {
  if (!scan) return { note: 'no scan this cycle; manage open positions only', picks: [] };
  return {
    window: scan.window,
    scanned: scan.scanned,
    gated: scan.gated,
    tilt: scan.tilt,
    picks: (scan.suggestions ?? []).map(trimPick),
  };
}

export async function buildAccountState(
  rt: ToolRuntime,
  options: { includeBrokerFunds?: boolean } = {}
): Promise<AccountState> {
  const s = rt.settings;
  const brokerFundsPromise =
    options.includeBrokerFunds && (s.mode === 'approval' || s.mode === 'live')
      ? getExecutionAdapter(s, s.mode).getFunds()
      : Promise.resolve({ available: null });
  const [entriesToday, exposure, pnl, pending, entryCutoffMin, brokerFunds] = await Promise.all([
    countEntriesToday(rt.date),
    getExposure(rt.date),
    dailyRealizedPnl(rt.date),
    getPendingApprovals(rt.date),
    getNumberSetting('COMMENTARY_ENTRY_CUTOFF_MIN', COMMENTARY_ENTRY_CUTOFF_MIN_DEFAULT).catch(
      () => COMMENTARY_ENTRY_CUTOFF_MIN_DEFAULT
    ),
    brokerFundsPromise,
  ]);
  let brokerFundsAvailable: number | null = null;
  if (s.mode === 'paper') {
    brokerFundsAvailable = Math.max(0, s.maxCapitalRupees - exposure.deployedRupees);
  } else if (options.includeBrokerFunds) {
    brokerFundsAvailable = brokerFunds.available;
  }
  const effectiveEntryEndMin = Math.min(s.entryEndMin, entryCutoffMin - 1, s.squareOffMin - 1);
  return {
    mode: s.mode,
    broker: s.mode === 'paper' ? 'paper' : s.broker,
    aiProvider: s.aiProvider,
    killSwitch: s.killSwitch,
    liveEnvEnabled: isAutoTradeLiveEnabled(),
    marketOpen: isMarketHours(),
    entryWindowActive: isEntryWindow(undefined, s.entryStartMin, effectiveEntryEndMin),
    entryWindowOpensAt: istMinuteLabel(s.entryStartMin),
    entryWindowClosesAt: istMinuteLabel(effectiveEntryEndMin),
    squareOffAt: istMinuteLabel(s.squareOffMin),
    nowIST: nowISTClock(),
    entriesToday,
    maxTradesPerDay: s.maxTradesPerDay,
    openLots: exposure.openLots,
    maxOpenLots: s.maxOpenLots,
    deployedRupees: exposure.deployedRupees,
    maxCapitalRupees: s.maxCapitalRupees,
    dailyRealizedPnlRupees: pnl,
    dailyLossHaltRupees: s.dailyLossHaltRupees,
    pendingApprovals: pending.length,
    brokerFundsAvailable,
    brokerFundsCheckedAtPlacement: true,
  };
}

export interface PositionMarketSeed {
  optionQuotes?: ReadonlyMap<string, OptionQuote>;
  attemptedOptionIds?: ReadonlySet<string>;
  spotBySymbol?: ReadonlyMap<string, number | null>;
}

/**
 * Every open position with one batched option quote. A guard snapshot can seed
 * this function so the first AI message reuses prices already fetched seconds
 * earlier instead of issuing another Dhan call.
 */
export async function buildOpenPositionsContext(
  rt: ToolRuntime,
  seed: PositionMarketSeed = {}
): Promise<Record<string, unknown>[]> {
  const open = await getOpenTrades();
  const quotes = new Map(seed.optionQuotes ?? []);
  const missingIds = open
    .map((trade) => trade.optSecurityId)
    .filter((id) => {
      const normalized = String(Number(id));
      return !quotes.has(normalized) && !seed.attemptedOptionIds?.has(normalized);
    });
  for (const [id, quote] of await fetchOptionQuotes(missingIds)) quotes.set(id, quote);

  return Promise.all(
    open.map(async (trade) => {
      const quote = quotes.get(String(Number(trade.optSecurityId))) ?? null;
      const spot = seed.spotBySymbol?.has(trade.symbol)
        ? (seed.spotBySymbol.get(trade.symbol) ?? null)
        : await latestSpot(trade.symbol, rt.date);
      return {
        tradeId: trade.id,
        symbol: trade.symbol,
        direction: trade.direction,
        contract: `${trade.strike}${trade.optionType}`,
        lots: trade.lots,
        entrySpot: trade.entrySpot,
        slSpot: trade.slSpot,
        targetSpot: trade.targetSpot,
        entryFillPremium: trade.entryFillPremium,
        slPremium: trade.slPremium,
        targetPremium: trade.targetPremium,
        livePremium: quote?.ltp ?? null,
        liveSpot: spot,
        spotPointsFromEntry: spot != null ? Math.round((spot - trade.entrySpot) * 100) / 100 : null,
        openedAt: trade.openedAt,
        entryReason: trade.aiReasonEntry,
      };
    })
  );
}

export async function buildInitialDecisionContext(
  rt: ToolRuntime,
  seed: PositionMarketSeed = {}
): Promise<{
  accountState: AccountState;
  openPositions: Record<string, unknown>[];
  scan: Record<string, unknown>;
}> {
  const [accountState, openPositions] = await Promise.all([buildAccountState(rt), buildOpenPositionsContext(rt, seed)]);
  return { accountState, openPositions, scan: buildScanContext(rt.scan) };
}

/** Assemble the gate input for one pick, with a FRESH premium quote (the
 *  slippage guard compares it to the scanner's quote from this cycle). */
async function buildGateInput(
  rt: ToolRuntime,
  pick: TradeSuggestion
): Promise<{ input: EntryGateInput; freshPremium: number | null }> {
  const scanPremium = pick.option?.premium?.ltp ?? null;
  const [state, fresh, tradedToday, entryCutoffMin] = await Promise.all([
    buildAccountState(rt, { includeBrokerFunds: true }),
    pick.option ? fetchOptionQuote(pick.option.optSecurityId) : null,
    symbolTradedToday(rt.date, pick.symbol),
    getNumberSetting('COMMENTARY_ENTRY_CUTOFF_MIN', COMMENTARY_ENTRY_CUTOFF_MIN_DEFAULT),
  ]);
  const freshPremium = fresh?.ltp ?? null;
  const slippagePct =
    scanPremium != null && scanPremium > 0 && freshPremium != null
      ? ((freshPremium - scanPremium) / scanPremium) * 100
      : null;
  const lotSize = pick.option?.lotSize ?? 0;
  return {
    input: {
      settings: rt.settings,
      liveEnvEnabled: state.liveEnvEnabled,
      marketOpen: state.marketOpen,
      minuteIST: minuteOfDayIST(),
      entryCutoffMin,
      entriesToday: state.entriesToday,
      openLots: state.openLots,
      deployedRupees: state.deployedRupees,
      dailyRealizedPnl: state.dailyRealizedPnlRupees,
      symbolTradedToday: tradedToday,
      lots: 1,
      perLotCost: freshPremium != null && lotSize > 0 ? Math.round(freshPremium * lotSize * 100) / 100 : null,
      slippagePct,
      spreadPct: fresh?.spreadPct ?? null,
      hasSlSpot: pick.plan.slSpot != null,
      brokerFundsAvailable: state.brokerFundsAvailable,
    },
    freshPremium,
  };
}

/** Run one tool by name. Returns the data plus an audit trace entry. */
export async function executeAutoTradeTool(
  rt: ToolRuntime,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  try {
    if (name === 'get_scan_picks') {
      const result = buildScanContext(rt.scan);
      const picks = rt.scan?.suggestions?.length ?? 0;
      return {
        result,
        trace: {
          name,
          args,
          ok: true,
          summary: rt.scan ? `${picks} pick(s) from ${rt.scan.scanned} scanned` : 'no scan this cycle',
        },
      };
    }

    if (name === 'get_account_state') {
      const state = await buildAccountState(rt);
      return {
        result: state,
        trace: {
          name,
          args,
          ok: true,
          summary: `mode ${state.mode} · entries ${state.entriesToday}/${state.maxTradesPerDay} · lots ${state.openLots}/${state.maxOpenLots} · deployed ₹${state.deployedRupees}`,
        },
      };
    }

    if (name === 'get_quote') {
      const symbol = String(args.symbol ?? '').toUpperCase();
      const pick = findPick(rt, symbol);
      const open = (await getOpenTrades()).find((t) => t.symbol === symbol);
      const optSecurityId = open?.optSecurityId ?? pick?.option?.optSecurityId ?? null;
      const premium = optSecurityId ? await fetchOptionQuote(optSecurityId) : null;
      const spot = await latestSpot(symbol, rt.date);
      const result = {
        symbol,
        premium,
        spot,
        contract: open
          ? `${open.strike}${open.optionType}`
          : pick?.option
            ? `${pick.option.strike}${pick.option.optionType}`
            : null,
      };
      return {
        result,
        trace: {
          name,
          args,
          ok: premium != null || spot != null,
          summary: `${symbol}: premium ${premium?.ltp ?? '—'}, spot ${spot ?? '—'}`,
        },
      };
    }

    if (name === 'check_order') {
      const symbol = String(args.symbol ?? '').toUpperCase();
      const pick = findPick(rt, symbol);
      if (!pick) {
        const result = {
          allow: false,
          reasons: [`${symbol} is not in this cycle's scanner picks — only scanner picks are tradeable`],
        };
        return {
          result,
          trace: {
            name,
            args,
            ok: false,
            summary: `${symbol}: not a scanner pick`,
          },
        };
      }
      const { input } = await buildGateInput(rt, pick);
      const verdict = checkEntryGates(input);
      return {
        result: verdict,
        trace: {
          name,
          args,
          ok: verdict.allow,
          summary: `${symbol}: ${verdict.allow ? 'ALLOW' : `REJECT (${verdict.reasons.length} gate(s))`}`,
        },
      };
    }

    if (name === 'place_entry_order') {
      // The pass captured settings at its start — an operator flipping the kill
      // switch (or turning the mode off) while the AI is mid-loop must stop THIS
      // order, not just the next pass. Re-read the live settings and let the
      // gates (which check killSwitch + mode) see the fresh truth.
      try {
        rt.settings = await getAutoTradeSettings();
      } catch {
        // settings unreadable → keep the pass snapshot (gates still enforce it)
      }
      if (rt.settings.killSwitch || rt.settings.mode === 'off') {
        const why = rt.settings.killSwitch ? 'kill switch is ON' : 'auto-trade mode is OFF';
        return {
          result: { placed: false, reasons: [`${why} — order refused`] },
          trace: { name, args, ok: false, summary: `entry refused: ${why} (re-checked mid-pass)` },
        };
      }
      const symbol = String(args.symbol ?? '').toUpperCase();
      const reason = String(args.reason ?? '').slice(0, 500);
      const pick = findPick(rt, symbol);
      if (!pick) {
        const result = {
          placed: false,
          reasons: [`${symbol} is not in this cycle's scanner picks`],
        };
        return {
          result,
          trace: {
            name,
            args,
            ok: false,
            summary: `${symbol}: not a scanner pick`,
          },
        };
      }
      if (!pick.option?.premium || pick.plan.slSpot == null) {
        const result = {
          placed: false,
          reasons: [`${symbol} is not eligible (missing contract, premium, or stop)`],
        };
        return {
          result,
          trace: {
            name,
            args,
            ok: false,
            summary: `${symbol}: ineligible pick`,
          },
        };
      }
      const { input, freshPremium } = await buildGateInput(rt, pick);
      const verdict = checkEntryGates(input);
      if (!verdict.allow) {
        return {
          result: { placed: false, reasons: verdict.reasons },
          trace: {
            name,
            args,
            ok: false,
            summary: `${symbol}: gates rejected (${verdict.reasons[0]})`,
          },
        };
      }
      const entryPremium = freshPremium ?? pick.option.premium.ltp;
      const status = rt.settings.mode === 'approval' ? 'pending_approval' : 'placing';
      const tradeId = await insertTrade({
        date: rt.date,
        symbol: pick.symbol,
        direction: pick.direction,
        optionType: pick.option.optionType,
        strike: pick.option.strike,
        expiryDate: pick.option.expiryDate,
        lotSize: pick.option.lotSize,
        lots: 1,
        optSecurityId: pick.option.optSecurityId,
        mode: rt.settings.mode,
        broker: rt.settings.mode === 'paper' ? 'paper' : rt.settings.broker,
        status,
        entrySpot: pick.plan.entrySpot,
        slSpot: pick.plan.slSpot,
        targetSpot: pick.plan.targetSpot,
        entryPremium,
        slPremium: pick.option.premium.slPremium,
        targetPremium: pick.option.premium.targetPremium,
        aiReasonEntry: reason,
      });
      if (tradeId == null) {
        const result = {
          placed: false,
          reasons: [`${symbol} was already claimed or attempted today by another pass`],
        };
        return {
          result,
          trace: {
            name,
            args,
            ok: false,
            summary: `${symbol}: concurrent or prior trade claim blocked`,
          },
        };
      }
      if (rt.settings.mode === 'approval') {
        // Push approval alert with Approve/Reject buttons to Telegram
        alerts.approvalRequested(
          tradeId,
          pick.symbol,
          pick.option.optionType,
          pick.option.strike,
          entryPremium,
          reason
        );
        const result = {
          placed: false,
          queued: true,
          tradeId,
          message: `queued for human approval (expires in ${rt.settings.approvalTtlMin} min) — do not place again`,
        };
        return {
          result,
          trace: {
            name,
            args,
            ok: true,
            summary: `${symbol}: queued for approval (trade ${tradeId})`,
          },
        };
      }
      const trade = await getTrade(tradeId);
      if (!trade) throw new Error(`trade ${tradeId} vanished after insert`);
      let outcome: ExecOutcome;
      try {
        outcome = await placeEntryOrder(trade, rt.settings, rt.settings.mode);
      } catch (err) {
        const message = (err as Error).message;
        // The broker may already have accepted the order. Never turn an
        // unexpected post-submit exception into a retryable local failure.
        outcome = {
          ok: true,
          state: 'unknown',
          message: `entry state uncertain after internal error; reconciliation required: ${message}`,
        };
      }
      const result = {
        placed: outcome.state === 'filled',
        pending: outcome.state === 'pending' || outcome.state === 'unknown',
        tradeId,
        message: outcome.message,
      };
      return {
        result,
        trace: {
          name,
          args,
          ok: outcome.ok,
          summary: `${symbol}: ${outcome.message}`,
        },
      };
    }

    if (name === 'get_open_positions') {
      const positions = await buildOpenPositionsContext(rt);
      return {
        result: { positions },
        trace: {
          name,
          args,
          ok: true,
          summary: `${positions.length} open position(s)`,
        },
      };
    }

    if (name === 'modify_stop') {
      const tradeId = Number(args.tradeId);
      const newSlSpot = Number(args.newSlSpot);
      const trade = await getTrade(tradeId);
      if (!trade || trade.status !== 'open') {
        const result = {
          moved: false,
          reasons: [`trade ${tradeId} is not an open position`],
        };
        return {
          result,
          trace: {
            name,
            args,
            ok: false,
            summary: `trade ${tradeId}: not open`,
          },
        };
      }
      const verdict = checkStopMove(trade.direction, trade.slSpot, newSlSpot);
      if (!verdict.allow) {
        return {
          result: { moved: false, reasons: verdict.reasons },
          trace: { name, args, ok: false, summary: verdict.reasons[0] },
        };
      }
      await updateTrade(tradeId, { slSpot: newSlSpot });
      const result = {
        moved: true,
        message: `${trade.symbol} stop → ${newSlSpot}`,
      };
      return {
        result,
        trace: {
          name,
          args,
          ok: true,
          summary: `${trade.symbol} stop → ${newSlSpot}`,
        },
      };
    }

    if (name === 'exit_position') {
      const tradeId = Number(args.tradeId);
      const reason = String(args.reason ?? '').slice(0, 500);
      const trade = await getTrade(tradeId);
      if (!trade) {
        return {
          result: { exited: false, reasons: [`no trade ${tradeId}`] },
          trace: { name, args, ok: false, summary: `no trade ${tradeId}` },
        };
      }
      const outcome = await exitTrade(trade, `AI exit: ${reason}`, reason);
      return {
        result: {
          exited: outcome.state === 'filled',
          pending: outcome.state === 'pending' || outcome.state === 'unknown',
          message: outcome.message,
        },
        trace: {
          name,
          args,
          ok: outcome.ok,
          summary: `${trade.symbol}: ${outcome.message}`,
        },
      };
    }

    if (name === 'record_note') {
      const note = String(args.note ?? '').slice(0, 500);
      return {
        result: { recorded: true },
        trace: { name, args, ok: true, summary: note },
      };
    }

    return {
      result: { error: `Unknown tool: ${name}` },
      trace: { name, args, ok: false, summary: `Unknown tool: ${name}` },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      result: { error: msg },
      trace: { name, args, ok: false, summary: `Error: ${msg}` },
    };
  }
}
