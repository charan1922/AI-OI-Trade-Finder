/**
 * Approval-mode flow — the human-in-the-loop path. The AI's place_entry_order
 * creates a trade with status 'pending_approval'; nothing touches a broker
 * until the operator clicks Approve on /auto-trade. Approval RE-RUNS the full
 * gate set against a FRESH quote (the world moved since the proposal) and only
 * then places on the real broker. Pending proposals expire after the TTL.
 */

import { isMarketHours, todayIST } from '@/lib/dhan/market-feed';
import { isAutoTradeLiveEnabled } from '@/lib/env';
import { getNumberSetting } from '@/lib/config/feature-toggles';
import { COMMENTARY_ENTRY_CUTOFF_MIN_DEFAULT } from '@/lib/ai-commentary/generate';
import { getExecutionAdapter } from './brokers';
import { minuteOfDayIST } from './config';
import { placeEntryOrder, type ExecOutcome } from './execution';
import { fetchOptionQuote } from './quotes';
import { checkEntryGates } from './risk/gates';
import {
  countEntriesToday,
  dailyRealizedPnl,
  getExposure,
  getPendingApprovals,
  getTrade,
  insertDecision,
  transitionTradeStatus,
} from './store';
import { getAutoTradeSettings } from './settings';

/** Approve one pending proposal: re-gate with fresh numbers, then place. */
export async function approveTrade(tradeId: number): Promise<ExecOutcome> {
  const trade = await getTrade(tradeId);
  if (!trade) return { ok: false, message: `no trade ${tradeId}` };
  if (trade.status !== 'pending_approval') {
    return {
      ok: false,
      message: `trade ${tradeId} is ${trade.status}, not pending approval`,
    };
  }
  const date = todayIST();
  if (trade.date !== date) {
    await transitionTradeStatus(tradeId, 'pending_approval', 'expired', 'approval attempted on a later day');
    return { ok: false, message: 'proposal is from a previous day — expired' };
  }
  const settings = await getAutoTradeSettings();
  if (settings.mode !== 'approval') {
    return {
      ok: false,
      message: `approval blocked because runtime mode is ${settings.mode}; switch back to approval and re-evaluate the proposal`,
    };
  }

  // Fresh premium + slippage vs the proposal quote.
  const fresh = await fetchOptionQuote(trade.optSecurityId);
  const slippagePct =
    fresh != null && trade.entryPremium > 0 ? ((fresh.ltp - trade.entryPremium) / trade.entryPremium) * 100 : null;

  // Cap counts EXCLUDING this proposal (it already reserved its own slot).
  const adapter = getExecutionAdapter(settings, 'approval');
  const [entriesToday, exposure, pnl, brokerFunds, entryCutoffMin] = await Promise.all([
    countEntriesToday(date),
    getExposure(date),
    dailyRealizedPnl(date),
    adapter.getFunds(),
    getNumberSetting('COMMENTARY_ENTRY_CUTOFF_MIN', COMMENTARY_ENTRY_CUTOFF_MIN_DEFAULT),
  ]);
  const funds = brokerFunds.available;
  const verdict = checkEntryGates({
    settings,
    liveEnvEnabled: isAutoTradeLiveEnabled(),
    marketOpen: isMarketHours(),
    minuteIST: minuteOfDayIST(),
    entryCutoffMin,
    entriesToday: Math.max(0, entriesToday - 1),
    openLots: Math.max(0, exposure.openLots - trade.lots),
    deployedRupees: Math.max(0, exposure.deployedRupees - Math.round(trade.entryPremium * trade.lotSize * trade.lots)),
    dailyRealizedPnl: pnl,
    symbolTradedToday: false, // this trade IS the symbol's slot
    lots: trade.lots,
    perLotCost: fresh != null ? Math.round(fresh.ltp * trade.lotSize * 100) / 100 : null,
    slippagePct,
    spreadPct: fresh?.spreadPct ?? null,
    hasSlSpot: trade.slSpot != null,
    brokerFundsAvailable: funds,
  });
  if (!verdict.allow) {
    await insertDecision({
      date,
      pass: 'approval',
      provider: null,
      model: null,
      summary: `Approval of ${trade.symbol} REFUSED by gates: ${verdict.reasons.join('; ')}`,
      toolTrace: [],
      promptTokens: null,
      completionTokens: null,
    });
    return {
      ok: false,
      message: `gates refused at approval time: ${verdict.reasons.join('; ')}`,
    };
  }

  const claimed = await transitionTradeStatus(tradeId, 'pending_approval', 'placing');
  if (!claimed) {
    const current = await getTrade(tradeId);
    return {
      ok: false,
      message: `approval already claimed; trade is ${current?.status ?? 'missing'}`,
    };
  }
  const updated = await getTrade(tradeId);
  if (!updated) return { ok: false, message: `trade ${tradeId} vanished` };
  const outcome = await placeEntryOrder(updated, settings, 'approval');
  await insertDecision({
    date,
    pass: 'approval',
    provider: null,
    model: null,
    summary: `Human APPROVED ${trade.symbol} ${trade.strike}${trade.optionType} → ${outcome.message}`,
    toolTrace: [],
    promptTokens: null,
    completionTokens: null,
  });
  return outcome;
}

/** Reject one pending proposal (operator said no). */
export async function rejectTrade(tradeId: number): Promise<ExecOutcome> {
  const trade = await getTrade(tradeId);
  if (!trade) return { ok: false, message: `no trade ${tradeId}` };
  if (trade.status !== 'pending_approval') {
    return {
      ok: false,
      message: `trade ${tradeId} is ${trade.status}, not pending approval`,
    };
  }
  const rejected = await transitionTradeStatus(tradeId, 'pending_approval', 'rejected', 'rejected by operator');
  if (!rejected) {
    const current = await getTrade(tradeId);
    return {
      ok: false,
      message: `trade is already ${current?.status ?? 'missing'}`,
    };
  }
  await insertDecision({
    date: trade.date,
    pass: 'approval',
    provider: null,
    model: null,
    summary: `Human REJECTED ${trade.symbol} ${trade.strike}${trade.optionType}`,
    toolTrace: [],
    promptTokens: null,
    completionTokens: null,
  });
  return { ok: true, message: `rejected ${trade.symbol}` };
}

/** Expire pending proposals older than the TTL (their quotes are stale). */
export async function expireStaleApprovals(date: string, ttlMin: number): Promise<string[]> {
  const pending = await getPendingApprovals(date);
  const cutoff = Date.now() - ttlMin * 60_000;
  const expired: string[] = [];
  for (const t of pending) {
    if (new Date(t.proposedAt).getTime() < cutoff) {
      const didExpire = await transitionTradeStatus(
        t.id,
        'pending_approval',
        'expired',
        `approval TTL (${ttlMin} min) elapsed`
      );
      if (didExpire) expired.push(`${t.symbol} ${t.strike}${t.optionType}`);
    }
  }
  return expired;
}
