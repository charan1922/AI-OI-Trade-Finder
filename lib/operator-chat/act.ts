/**
 * The operator chat's hands. A chat reply can only PROPOSE (proposeAction);
 * nothing runs until the operator taps Confirm on the card in the thread
 * (POST /api/trade-commentary/chat/action → executeAction).
 *
 * Every action goes through the code the /auto-trade console already uses —
 * setAutoTradeSetting (the settings registry: allowlist + ranges), exitTrade,
 * approveTrade / rejectTrade (re-runs every gate on a fresh quote),
 * checkStopMove (tighten-only + 0.35% noise band) and runAutoTradePass — so the
 * chat can never do anything the console could not. The chat has NO raw order
 * tool: a new entry still comes only from the trader's gated pass.
 */

import { approveTrade, rejectTrade } from '@/lib/auto-trade/approval';
import { runAutoTradePass } from '@/lib/auto-trade/engine';
import { exitTrade } from '@/lib/auto-trade/execution';
import { latestSpot } from '@/lib/auto-trade/quotes';
import { checkStopMove } from '@/lib/auto-trade/risk/gates';
import { getAutoTradeSettings, setAutoTradeSetting } from '@/lib/auto-trade/settings';
import {
  getOpenTrades,
  getPendingApprovals,
  getTrade,
  getTradesByDate,
  insertDecision,
  updateTrade,
} from '@/lib/auto-trade/store';
import type { AutoTrade } from '@/lib/auto-trade/types';
import { todayIST } from '@/lib/ist';
import { runTradeSuggest } from '@/lib/trade-suggest/engine';
import { internalOrigin } from '@/lib/trade-suggest/candidates';
import { describeAction, settingLabel, validateSettingChange } from './actions';
import { addOperatorMessage } from './store';
import { ACTION_KINDS, type ActionKind, type ChatAction } from './format';

type Proposal = { ok: true; action: ChatAction; description: string } | { ok: false; error: string };

const contractOf = (t: AutoTrade) => `${t.strike}${t.optionType} ${t.expiryDate}`;

function pickBySymbol(trades: AutoTrade[], symbol: unknown, what: string): AutoTrade | string {
  const sym = typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';
  if (!sym) return `Say which stock (symbol) — e.g. "${what} RELIANCE".`;
  const hits = trades.filter((t) => t.symbol.toUpperCase() === sym);
  if (hits.length === 0) {
    const have = trades.map((t) => t.symbol).join(', ');
    return `No ${what === 'approve' || what === 'reject' ? 'pending approval' : 'open position'} in ${sym} today${have ? ` (there is: ${have})` : ''}.`;
  }
  if (hits.length > 1) return `More than one ${sym} trade matches — use the /auto-trade page for this one.`;
  return hits[0];
}

/** Turn what the chat model asked for into a validated, fully-resolved proposal. Writes nothing. */
export async function proposeAction(args: Record<string, unknown>): Promise<Proposal> {
  const kind = (ACTION_KINDS as readonly string[]).includes(String(args.kind)) ? (args.kind as ActionKind) : null;
  if (!kind) return { ok: false, error: `kind must be one of ${ACTION_KINDS.join(', ')}` };
  const date = todayIST();
  let action: ChatAction;

  if (kind === 'setting') {
    const v = validateSettingChange(args.key, args.value);
    if (!v.ok) return v;
    const current = (await getAutoTradeSettings()) as unknown as Record<string, unknown>;
    const from = current[v.key] == null ? null : String(current[v.key]);
    if (from === v.value) return { ok: false, error: `${settingLabel(v.key)} is already ${v.value}.` };
    action = { kind, key: v.key, value: v.value, from };
  } else if (kind === 'exit' || kind === 'move_stop') {
    const t = pickBySymbol(await getOpenTrades(), args.symbol, kind === 'exit' ? 'exit' : 'move the stop on');
    if (typeof t === 'string') return { ok: false, error: t };
    if (kind === 'exit') {
      action = { kind, tradeId: t.id, symbol: t.symbol, contract: contractOf(t) };
    } else {
      const toSl = Number(args.newSlSpot);
      if (!Number.isFinite(toSl) || toSl <= 0) return { ok: false, error: 'newSlSpot must be a spot price, e.g. 7990.' };
      // Pre-check the SAME gate the trader uses, so a doomed request is refused now, not after a tap.
      const verdict = checkStopMove(t.direction, t.slSpot, toSl, await latestSpot(t.symbol, date));
      if (!verdict.allow) return { ok: false, error: `The stop gate refuses that: ${verdict.reasons.join('; ')}` };
      action = { kind, tradeId: t.id, symbol: t.symbol, contract: contractOf(t), fromSl: t.slSpot, toSl };
    }
  } else if (kind === 'take_trade') {
    const sym = typeof args.symbol === 'string' ? args.symbol.trim().toUpperCase() : '';
    if (!/^[A-Z0-9&-]{1,20}$/.test(sym)) return { ok: false, error: 'Say which stock to take, e.g. "take APOLLOHOSP".' };
    action = { kind, symbol: sym };
  } else if (kind === 'approve' || kind === 'reject') {
    const t = pickBySymbol(await getPendingApprovals(date), args.symbol, kind);
    if (typeof t === 'string') return { ok: false, error: t };
    action = { kind, tradeId: t.id, symbol: t.symbol, contract: contractOf(t) };
  } else {
    action = { kind: 'run_pass' };
  }
  return { ok: true, action, description: describeAction(action) };
}

/** Run a CONFIRMED action. Re-checks everything against current state — nothing is trusted from the proposal. */
export async function executeAction(action: ChatAction): Promise<{ ok: boolean; message: string }> {
  const description = describeAction(action);
  let outcome: { ok: boolean; message: string };
  try {
    outcome = await run(action);
  } catch (err) {
    outcome = { ok: false, message: (err as Error).message };
  }
  await insertDecision({
    date: todayIST(),
    pass: 'system',
    provider: null,
    model: null,
    summary: `Operator via chat (confirmed): ${description} → ${outcome.ok ? 'OK' : 'FAILED'}: ${outcome.message}`,
    toolTrace: [],
    promptTokens: null,
    completionTokens: null,
  }).catch(() => undefined);
  return outcome;
}

async function run(a: ChatAction): Promise<{ ok: boolean; message: string }> {
  switch (a.kind) {
    case 'setting': {
      const v = validateSettingChange(a.key, a.value); // the registry re-validates on write as well
      if (!v.ok) return { ok: false, message: v.error };
      await setAutoTradeSetting(v.key, v.value);
      return { ok: true, message: `${settingLabel(v.key)} is now ${v.value}. The trader uses it from its next pass.` };
    }
    case 'exit': {
      const t = a.tradeId == null ? null : await getTrade(a.tradeId);
      if (!t || t.status !== 'open') return { ok: false, message: `${a.symbol} is no longer an open position.` };
      const r = await exitTrade(t, 'operator exit via chat');
      return { ok: r.ok, message: r.message };
    }
    case 'move_stop': {
      const t = a.tradeId == null ? null : await getTrade(a.tradeId);
      if (!t || t.status !== 'open') return { ok: false, message: `${a.symbol} is no longer an open position.` };
      const toSl = Number(a.toSl);
      const verdict = checkStopMove(t.direction, t.slSpot, toSl, await latestSpot(t.symbol, todayIST()));
      if (!verdict.allow) return { ok: false, message: `Stop gate refused: ${verdict.reasons.join('; ')}` };
      await updateTrade(t.id, { slSpot: toSl });
      return { ok: true, message: `${t.symbol} stop is now ${toSl}.` };
    }
    case 'approve':
    case 'reject': {
      if (a.tradeId == null) return { ok: false, message: 'No trade id on this proposal.' };
      const r = a.kind === 'approve' ? await approveTrade(a.tradeId) : await rejectTrade(a.tradeId);
      return { ok: r.ok, message: r.message };
    }
    case 'take_trade': {
      // The confirmed order goes into the thread as the operator's own words, so this pass (and every
      // later one) reads it as `operatorChat` — the trader's prompt puts the operator's decision first.
      const date = todayIST();
      await addOperatorMessage(
        date,
        'user',
        `CONFIRMED ORDER: take ${a.symbol} now — enter it this pass if it is an eligible scanner pick and every gate allows.`
      );
      const before = new Set((await getTradesByDate(date)).map((t) => t.id));
      const pass = await runPassNow();
      const placed = (await getTradesByDate(date)).find(
        (t) => !before.has(t.id) && t.symbol.toUpperCase() === a.symbol && t.status !== 'failed' && t.status !== 'rejected'
      );
      if (placed) {
        const verb = placed.status === 'pending_approval' ? 'is waiting for your approval' : `is ${placed.status}`;
        return { ok: true, message: `${a.symbol} ${contractOf(placed)} ${verb}. ${pass}` };
      }
      // Not entered on THIS pass. The confirmed order stays in the thread, so the next pass (or one already
      // running — the engine lease blocks a second) still acts on it; say so rather than "failed".
      return {
        ok: false,
        message: `${a.symbol} not entered on this pass — the trader's read in this thread says why (usually a gate). Your order stays in the thread, so the next pass acts on it too. ${pass}`,
      };
    }
    case 'run_pass':
      return { ok: true, message: await runPassNow() };
  }
}

/** One full engine pass NOW — the console's run-pass button. The engine lease stops it overlapping a poller pass. */
async function runPassNow(): Promise<string> {
  const scan = await runTradeSuggest(internalOrigin());
  const r = await runAutoTradePass(scan);
  const did = r.guardActions.length > 0 ? ` Guard: ${r.guardActions.join('; ')}.` : '';
  return `${r.ran ? 'Pass ran' : 'Pass did not run'}${r.reason ? ` — ${r.reason}` : ''}. Scanned ${scan.scanned}.${did}`;
}
