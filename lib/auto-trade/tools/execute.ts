teler/**
 * Tool executors — where the AI's requests meet the hard gates. Every mutating
 * tool re-validates EVERYTHING in code (risk/gates.ts) against fresh DB state
 * and fresh quotes; the model's arguments are treated as untrusted input.
 *
 * The executors close over a ToolRuntime (this cycle's scan + settings) built
 * once per engine pass — the model can only ever act on THIS cycle's picks.
 */

import { isMarketHours } from '@/lib/dhan/market-feed';
import { isAutoTradeLiveEnabled } from '@/lib/env';
import type { SuggestResponse, TradeSuggestion } from '@/lib/trade-suggest/types';
import { alerts } from '../alerts';
import { getExecutionAdapter } from '../brokers';
import { isEntryWindow, minuteOfDayIST, nowISTClock } from '../config';
import { exitTrade, placeEntryOrder } from '../execution';
import { fetchOptionQuote, latestSpot } from '../quotes';
import { checkEntryGates, checkStopMove, type EntryGateInput } from '../risk/gates';
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
    tfBreakout: s.tfBreakout && { grade: s.tfBreakout.grade, direction: s.tfBreakout.direction },
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

async function buildAccountState(rt: ToolRuntime): Promise<AccountState> {
  const [entriesToday, exposure, pnl, pending] = [
    await countEntriesToday(rt.date),
    await getExposure(rt.date),
    await dailyRealizedPnl(rt.date),
    await getPendingApprovals(rt.date),
  ];
  const s = rt.settings;
  let brokerFundsAvailable: number | null = null;
  if (s.mode === 'paper') {
    brokerFundsAvailable = Math.max(0, s.maxCapitalRupees - exposure.deployedRupees);
  } else if (s.mode === 'approval' || s.mode === 'live') {
    brokerFundsAvailable = (await getExecutionAdapter(s, s.mode).getFunds()).available;
  }
  return {
    mode: s.mode,
    broker: s.mode === 'paper' ? 'paper' : s.broker,
    aiProvider: s.aiProvider,
    killSwitch: s.killSwitch,
    liveEnvEnabled: isAutoTradeLiveEnabled(),
    marketOpen: isMarketHours(),
    entryWindowActive: isEntryWindow(),
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
  };
}

/** Assemble the gate input for one pick, with a FRESH premium quote (the
 *  slippage guard compares it to the scanner's quote from this cycle). */
async function buildGateInput(
  rt: ToolRuntime,
  pick: TradeSuggestion,
): Promise<{ input: EntryGateInput; freshPremium: number | null }> {
  const state = await buildAccountState(rt);
  const scanPremium = pick.option?.premium?.ltp ?? null;
  const fresh = pick.option ? await fetchOptionQuote(pick.option.optSecurityId) : null;
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
      entriesToday: state.entriesToday,
      openLots: state.openLots,
      deployedRupees: state.deployedRupees,
      dailyRealizedPnl: state.dailyRealizedPnlRupees,
      symbolTradedToday: await symbolTradedToday(rt.date, pick.symbol),
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
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    if (name === 'get_scan_picks') {
      if (!rt.scan) {
        const result = { note: 'no scan this cycle (out of scan window) — no entries possible, manage positions only' };
        return { result, trace: { name, args, ok: true, summary: 'no scan this cycle' } };
      }
      const picks = (rt.scan.suggestions ?? []).map(trimPick);
      const result = {
        window: rt.scan.window,
        scanned: rt.scan.scanned,
        gated: rt.scan.gated,
        tilt: rt.scan.tilt,
        picks,
      };
      return { result, trace: { name, args, ok: true, summary: `${picks.length} pick(s) from ${rt.scan.scanned} scanned` } };
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
      const result = { symbol, premium, spot, contract: open ? `${open.strike}${open.optionType}` : pick?.option ? `${pick.option.strike}${pick.option.optionType}` : null };
      return {
        result,
        trace: { name, args, ok: premium != null || spot != null, summary: `${symbol}: premium ${premium?.ltp ?? '—'}, spot ${spot ?? '—'}` },
      };
    }

    if (name === 'check_order') {
      const symbol = String(args.symbol ?? '').toUpperCase();
      const pick = findPick(rt, symbol);
      if (!pick) {
        const result = { allow: false, reasons: [`${symbol} is not in this cycle's scanner picks — only scanner picks are tradeable`] };
        return { result, trace: { name, args, ok: false, summary: `${symbol}: not a scanner pick` } };
      }
      const { input } = await buildGateInput(rt, pick);
      const verdict = checkEntryGates(input);
      return {
        result: verdict,
        trace: { name, args, ok: verdict.allow, summary: `${symbol}: ${verdict.allow ? 'ALLOW' : `REJECT (${verdict.reasons.length} gate(s))`}` },
      };
    }

    if (name === 'place_entry_order') {
      const symbol = String(args.symbol ?? '').toUpperCase();
      const reason = String(args.reason ?? '').slice(0, 500);
      const pick = findPick(rt, symbol);
      if (!pick) {
        const result = { placed: false, reasons: [`${symbol} is not in this cycle's scanner picks`] };
        return { result, trace: { name, args, ok: false, summary: `${symbol}: not a scanner pick` } };
      }
      if (!pick.option?.premium || pick.plan.slSpot == null) {
        const result = { placed: false, reasons: [`${symbol} is not eligible (missing contract, premium, or stop)`] };
        return { result, trace: { name, args, ok: false, summary: `${symbol}: ineligible pick` } };
      }
      const { input, freshPremium } = await buildGateInput(rt, pick);
      const verdict = checkEntryGates(input);
      if (!verdict.allow) {
        return {
          result: { placed: false, reasons: verdict.reasons },
          trace: { name, args, ok: false, summary: `${symbol}: gates rejected (${verdict.reasons[0]})` },
        };
      }
      const entryPremium = freshPremium ?? pick.option.premium.ltp;
      const status = rt.settings.mode === 'approval' ? 'pending_approval' : 'open';
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
      if (rt.settings.mode === 'approval') {
        // Push approval alert with Approve/Reject buttons to Telegram
        const { alerts } = await import('@/lib/auto-trade/alerts');
        alerts.approvalRequested(tradeId, pick.symbol, pick.option.optionType, pick.option.strike, entryPremium, reason);
        const result = {
          placed: false,
          queued: true,
          tradeId,
          message: `queued for human approval (expires in ${rt.settings.approvalTtlMin} min) — do not place again`,
        };
        return { result, trace: { name, args, ok: true, summary: `${symbol}: queued for approval (trade ${tradeId})` } };
      }
      const trade = await getTrade(tradeId);
      if (!trade) throw new Error(`trade ${tradeId} vanished after insert`);
      // Safety net: a live trade row is already 'open' at this point. If
      // placement throws unexpectedly, fail the trade so it can never linger
      // as a phantom 'open' position with no broker order behind it.
      let outcome: { ok: boolean; message: string };
      try {
        outcome = await placeEntryOrder(trade, rt.settings, rt.settings.mode);
      } catch (err) {
        const message = (err as Error).message;
        await updateTrade(tradeId, { status: 'failed', exitReason: `entry crashed: ${message}` });
        outcome = { ok: false, message: `entry crashed: ${message}` };
      }
      if (outcome.ok) alerts.tradePlaced(symbol, pick.option.optionType, entryPremium);
      const result = { placed: outcome.ok, tradeId, message: outcome.message };
      return { result, trace: { name, args, ok: outcome.ok, summary: `${symbol}: ${outcome.message}` } };
    }

    if (name === 'get_open_positions') {
      const open = await getOpenTrades();
      const positions = [];
      for (const t of open) {
        const premium = await fetchOptionQuote(t.optSecurityId);
        const spot = await latestSpot(t.symbol, rt.date);
        positions.push({
          tradeId: t.id,
          symbol: t.symbol,
          direction: t.direction,
          contract: `${t.strike}${t.optionType}`,
          lots: t.lots,
          entrySpot: t.entrySpot,
          slSpot: t.slSpot,
          targetSpot: t.targetSpot,
          entryFillPremium: t.entryFillPremium,
          slPremium: t.slPremium,
          targetPremium: t.targetPremium,
          livePremium: premium?.ltp ?? null,
          liveSpot: spot,
          spotPointsFromEntry: spot != null ? Math.round((spot - t.entrySpot) * 100) / 100 : null,
          openedAt: t.openedAt,
          entryReason: t.aiReasonEntry,
        });
      }
      return {
        result: { positions },
        trace: { name, args, ok: true, summary: `${positions.length} open position(s)` },
      };
    }

    if (name === 'modify_stop') {
      const tradeId = Number(args.tradeId);
      const newSlSpot = Number(args.newSlSpot);
      const trade = await getTrade(tradeId);
      if (!trade || trade.status !== 'open') {
        const result = { moved: false, reasons: [`trade ${tradeId} is not an open position`] };
        return { result, trace: { name, args, ok: false, summary: `trade ${tradeId}: not open` } };
      }
      const verdict = checkStopMove(trade.direction, trade.slSpot, newSlSpot);
      if (!verdict.allow) {
        return { result: { moved: false, reasons: verdict.reasons }, trace: { name, args, ok: false, summary: verdict.reasons[0] } };
      }
      await updateTrade(tradeId, { slSpot: newSlSpot });
      const result = { moved: true, message: `${trade.symbol} stop → ${newSlSpot}` };
      return { result, trace: { name, args, ok: true, summary: `${trade.symbol} stop → ${newSlSpot}` } };
    }

    if (name === 'exit_position') {
      const tradeId = Number(args.tradeId);
      const reason = String(args.reason ?? '').slice(0, 500);
      const trade = await getTrade(tradeId);
      if (!trade) {
        return { result: { exited: false, reasons: [`no trade ${tradeId}`] }, trace: { name, args, ok: false, summary: `no trade ${tradeId}` } };
      }
      const outcome = await exitTrade(trade, `AI exit: ${reason}`, reason);
      return { result: { exited: outcome.ok, message: outcome.message }, trace: { name, args, ok: outcome.ok, summary: `${trade.symbol}: ${outcome.message}` } };
    }

    if (name === 'record_note') {
      const note = String(args.note ?? '').slice(0, 500);
      return { result: { recorded: true }, trace: { name, args, ok: true, summary: note } };
    }

    return { result: { error: `Unknown tool: ${name}` }, trace: { name, args, ok: false, summary: `Unknown tool: ${name}` } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { result: { error: msg }, trace: { name, args, ok: false, summary: `Error: ${msg}` } };
  }
}
