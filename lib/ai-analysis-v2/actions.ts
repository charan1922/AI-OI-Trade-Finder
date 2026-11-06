/**
 * AI Analysis v2 — what the agent may DO, through the same gated auto-trade code the /auto-trade console uses
 * (settings registry with allowlist + ranges, exitTrade, approveTrade / rejectTrade which re-run every gate on a
 * fresh quote, checkStopMove tighten-only + 0.35% noise band, runAutoTradePass). v2's own module: it imports
 * lib/auto-trade directly, never v1's chat code.
 *
 * Per action kind the operator chooses AUTO (runs right after the reply) or ASK (a Confirm card). Mode can never be
 * switched to live from here (two-key rule); `broker` is never changed from here.
 */

import { approveTrade, rejectTrade } from '@/lib/auto-trade/approval';
import { runAutoTradePass } from '@/lib/auto-trade/engine';
import { exitTrade } from '@/lib/auto-trade/execution';
import { latestSpot } from '@/lib/auto-trade/quotes';
import { checkStopMove } from '@/lib/auto-trade/risk/gates';
import { getAutoTradeSettings, SETTING_DEFS, setAutoTradeSetting } from '@/lib/auto-trade/settings';
import { getOpenTrades, getPendingApprovals, getTrade, insertDecision, updateTrade } from '@/lib/auto-trade/store';
import type { NeutralToolDef } from '@/lib/auto-trade/tools/defs';
import type { AutoTrade } from '@/lib/auto-trade/types';
import { todayIST } from '@/lib/ist';
import { runTradeSuggest } from '@/lib/trade-suggest/engine';
import { internalOrigin } from '@/lib/trade-suggest/candidates';
import { addActionRow, claimAction, finishAction, getMessage } from './store';
import { ACTION_KINDS, type ActionKind, type V2Action, type V2Message } from './types';

export type AutoActions = Record<ActionKind, boolean>;

/** Defaults: auto for everything that reduces risk or only reads/re-runs the gated pass; ASK for approve (the
 *  operator's tap is the second key for a real order in approval mode) and setting (can loosen risk limits). */
export const DEFAULT_AUTO_ACTIONS: AutoActions = {
  exit: true,
  move_stop: true,
  reject: true,
  run_pass: true,
  approve: false,
  setting: false,
};

export function normaliseAutoActions(raw: unknown): AutoActions {
  const out: AutoActions = { ...DEFAULT_AUTO_ACTIONS };
  if (raw && typeof raw === 'object') {
    for (const k of ACTION_KINDS) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === 'boolean') out[k] = v;
    }
  }
  return out;
}

const BLOCKED_SETTINGS: ReadonlySet<string> = new Set(['broker']);

export function settingLabel(key: string): string {
  return SETTING_DEFS.find((d) => d.key === key)?.label ?? key;
}

/** Validate a setting change exactly as the registry would (same parse, same ranges) WITHOUT writing it. */
function validateSettingChange(
  key: unknown,
  rawValue: unknown
): { ok: true; key: string; value: string } | { ok: false; error: string } {
  const k = typeof key === 'string' ? key : '';
  const def = SETTING_DEFS.find((d) => d.key === k);
  if (!def) {
    const keys = SETTING_DEFS.map((d) => d.key).filter((x) => !BLOCKED_SETTINGS.has(x));
    return { ok: false, error: `Unknown setting "${k}". Settable here: ${keys.join(', ')}` };
  }
  if (BLOCKED_SETTINGS.has(k)) return { ok: false, error: `"${k}" is changed only on the /auto-trade page.` };
  let parsed: ReturnType<typeof def.parse>;
  try {
    parsed = def.parse(String(rawValue ?? ''));
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  if (k === 'mode' && parsed === 'live') {
    return {
      ok: false,
      error: 'Live mode is never switched on from here — it keeps its two-key rule (AUTO_TRADE_LIVE_ENABLED + /auto-trade).',
    };
  }
  return { ok: true, key: k, value: def.serialize(parsed) };
}

export function describeAction(a: V2Action): string {
  switch (a.kind) {
    case 'setting':
      return `Change ${settingLabel(a.key ?? '')} (${a.key}): ${a.from ?? '—'} → ${a.value}`;
    case 'exit':
      return `Exit ${a.symbol} ${a.contract ?? ''} now, at market`.replace(/\s+/g, ' ').trim();
    case 'move_stop':
      return `Move ${a.symbol} stop ${a.fromSl ?? '—'} → ${a.toSl} (tighten only)`;
    case 'approve':
      return `Approve the pending ${a.symbol} ${a.contract ?? ''} order (every gate re-checked on a fresh quote)`
        .replace(/\s+/g, ' ')
        .trim();
    case 'reject':
      return `Reject the pending ${a.symbol} ${a.contract ?? ''} order`.replace(/\s+/g, ' ').trim();
    case 'run_pass':
      return 'Run the trader now — fresh scan + full decision pass, every gate applies';
  }
}

const contractOf = (t: AutoTrade) => `${t.strike}${t.optionType} ${t.expiryDate}`;

function pickBySymbol(trades: AutoTrade[], symbol: unknown, what: string): AutoTrade | string {
  const sym = typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';
  if (!sym) return `Say which stock (symbol), e.g. "${what} RELIANCE".`;
  const hits = trades.filter((t) => t.symbol.toUpperCase() === sym);
  if (hits.length === 0) {
    const have = trades.map((t) => t.symbol).join(', ');
    return `No ${what === 'approve' || what === 'reject' ? 'pending approval' : 'open position'} in ${sym} today${have ? ` (there is: ${have})` : ''}.`;
  }
  if (hits.length > 1) return `More than one ${sym} trade matches — use the /auto-trade page for this one.`;
  return hits[0];
}

/** Turn what the model asked for into a validated, fully-resolved proposal. Writes nothing. */
export async function proposeAction(
  args: Record<string, unknown>
): Promise<{ ok: true; action: V2Action; description: string } | { ok: false; error: string }> {
  const kind = (ACTION_KINDS as readonly string[]).includes(String(args.kind)) ? (args.kind as ActionKind) : null;
  if (!kind) {
    return {
      ok: false,
      error: `kind must be one of ${ACTION_KINDS.join(', ')}. v2 cannot enter a specific stock — run_pass runs the trader, which picks by its own gates.`,
    };
  }
  const date = todayIST();
  let action: V2Action;
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
      const verdict = checkStopMove(t.direction, t.slSpot, toSl, await latestSpot(t.symbol, date));
      if (!verdict.allow) return { ok: false, error: `The stop gate refuses that: ${verdict.reasons.join('; ')}` };
      action = { kind, tradeId: t.id, symbol: t.symbol, contract: contractOf(t), fromSl: t.slSpot, toSl };
    }
  } else if (kind === 'approve' || kind === 'reject') {
    const t = pickBySymbol(await getPendingApprovals(date), args.symbol, kind);
    if (typeof t === 'string') return { ok: false, error: t };
    action = { kind, tradeId: t.id, symbol: t.symbol, contract: contractOf(t) };
  } else {
    action = { kind: 'run_pass' };
  }
  return { ok: true, action, description: describeAction(action) };
}

/** Run an action. Re-checks everything against the current state — nothing is trusted from the proposal. */
export async function executeAction(action: V2Action, how: 'auto' | 'confirmed'): Promise<{ ok: boolean; message: string }> {
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
    summary: `AI Analysis v2 (${how}): ${description} → ${outcome.ok ? 'OK' : 'FAILED'}: ${outcome.message}`,
    toolTrace: [],
    promptTokens: null,
    completionTokens: null,
  }).catch(() => undefined);
  return outcome;
}

async function run(a: V2Action): Promise<{ ok: boolean; message: string }> {
  switch (a.kind) {
    case 'setting': {
      const v = validateSettingChange(a.key, a.value);
      if (!v.ok) return { ok: false, message: v.error };
      await setAutoTradeSetting(v.key, v.value);
      return { ok: true, message: `${settingLabel(v.key)} is now ${v.value}. The trader uses it from its next pass.` };
    }
    case 'exit': {
      const t = a.tradeId == null ? null : await getTrade(a.tradeId);
      if (!t || t.status !== 'open') return { ok: false, message: `${a.symbol} is no longer an open position.` };
      const r = await exitTrade(t, 'AI Analysis v2 exit');
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
    case 'run_pass': {
      const scan = await runTradeSuggest(internalOrigin());
      const r = await runAutoTradePass(scan);
      const did = r.guardActions.length > 0 ? ` Guard: ${r.guardActions.join('; ')}.` : '';
      return { ok: r.ran, message: `${r.ran ? 'Pass ran' : 'Pass did not run'}${r.reason ? ` — ${r.reason}` : ''}. Scanned ${scan.scanned}.${did}` };
    }
  }
}

/**
 * After a reply: each proposal becomes an action row. An AUTO kind runs right now (atomic claim first, so a stray
 * tap can never run it twice); an ASK kind stays a Confirm card.
 */
export async function applyProposals(
  date: string,
  proposals: readonly { action: V2Action; description: string }[],
  auto: AutoActions
): Promise<V2Message[]> {
  const rows: V2Message[] = [];
  for (const p of proposals) {
    const row = await addActionRow(date, p.description, p.action);
    if (!auto[p.action.kind] || !(await claimAction(row.id, 'running'))) {
      rows.push(row);
      continue;
    }
    const outcome = await executeAction(p.action, 'auto');
    await finishAction(row.id, outcome.ok ? 'done' : 'failed', outcome.message);
    rows.push((await getMessage(row.id)) ?? row);
  }
  return rows;
}

export const PROPOSE_ACTION_TOOL: NeutralToolDef = {
  name: 'propose_action',
  description: [
    'Act on the trader. Whether it runs by itself or shows a Confirm card is the operator\'s per-kind switch (Live',
    'context says which). Every action goes through the auto-trader\'s own gates. kinds:',
    '- exit {symbol}: exit an open position now at market.',
    '- move_stop {symbol, newSlSpot}: tighten the spot stop (tighten-only; inside the 0.35% noise band is refused).',
    '- approve / reject {symbol}: decide a pending approval (approve re-checks every gate on a fresh quote).',
    '- run_pass: run the trader now (fresh scan + full pass). The trader picks entries by its own gates; you cannot',
    '  make it enter a specific stock.',
    '- setting {key, value}: change a trader setting (same registry + limits as /auto-trade; never mode live, never broker).',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: [...ACTION_KINDS] },
      symbol: { type: 'string' },
      key: { type: 'string' },
      value: { type: 'string' },
      newSlSpot: { type: 'number' },
    },
    required: ['kind'],
  },
};

/** At most this many actions per reply — a fix + the action, not a menu. */
export const MAX_PROPOSALS = 3;
