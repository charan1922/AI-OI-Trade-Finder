/**
 * What happens to the actions a v2 reply proposed (Commentary v2, operator 2026-10-30): ONE switch per
 * action kind, set on the v2 page.
 *
 *   auto — runs right AFTER the reply, through the SAME code a Confirm tap runs (executeAction): every risk
 *          gate re-runs, stops only tighten, the mode can never become live (lib/operator-chat/act.ts). The
 *          outcome is posted in the thread.
 *   ask  — the human-in-the-loop flow: a Confirm card that waits for the operator.
 *
 * Defaults: auto for everything EXCEPT approve (the operator's tap is the second key for real orders in
 * approval mode) and setting (can loosen risk limits) — those start as ask and are the operator's to switch.
 *
 * Actions run AFTER the reply, not inside the tool loop: take_trade / run_pass run a full scan + decision
 * pass and would eat the reply's time budget. v1 always uses Confirm cards and never calls this.
 */

import { executeAction } from './act';
import { ACTION_KINDS, type ActionKind, type ChatAction, type OperatorMessage } from './format';
import { addOperatorAction, addOperatorMessage, claimAction, finishAction, getOperatorMessage } from './store';

export type AutoActions = Record<ActionKind, boolean>;

export const DEFAULT_AUTO_ACTIONS: AutoActions = {
  exit: true,
  move_stop: true,
  run_pass: true,
  take_trade: true,
  reject: true,
  approve: false,
  setting: false,
};

/** Merge a stored map onto the defaults; unknown keys are ignored, missing kinds take the default. */
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

export async function applyProposals(
  date: string,
  proposals: readonly { action: ChatAction; description: string }[],
  auto: AutoActions,
  onStep?: (label: string, state: 'running' | 'ok' | 'error') => void
): Promise<OperatorMessage[]> {
  const rows: OperatorMessage[] = [];
  for (const p of proposals) {
    const row = await addOperatorAction(date, p.description, p.action);
    if (!auto[p.action.kind]) {
      rows.push(row);
      continue;
    }
    // Same atomic claim as a Confirm tap, so a stray tap on the page can never run it a second time.
    if (!(await claimAction(row.id, 'running'))) {
      rows.push(row);
      continue;
    }
    onStep?.(`Auto: ${p.description}`, 'running');
    let outcome: { ok: boolean; message: string };
    try {
      outcome = await executeAction(p.action);
    } catch (err) {
      outcome = { ok: false, message: (err as Error).message };
    }
    await finishAction(row.id, outcome.ok ? 'done' : 'failed', outcome.message);
    await addOperatorMessage(date, 'assistant', `⚡ Auto: ${outcome.ok ? '✅ Done' : '⚠️ Not done'} — ${outcome.message}`);
    onStep?.(`Auto: ${p.description}`, outcome.ok ? 'ok' : 'error');
    rows.push((await getOperatorMessage(row.id)) ?? row);
  }
  return rows;
}

const KIND_LABEL: Record<ActionKind, string> = {
  exit: 'exit',
  move_stop: 'move_stop',
  run_pass: 'run_pass',
  take_trade: 'take_trade',
  reject: 'reject',
  approve: 'approve',
  setting: 'setting',
};

/** Told to the AI (live context): which kinds run by themselves, so it never says "tap Confirm" for those,
 *  nor "done" before they ran. */
export function actionModeBlock(auto: AutoActions): string {
  const on = ACTION_KINDS.filter((k) => auto[k]).map((k) => KIND_LABEL[k]);
  const off = ACTION_KINDS.filter((k) => !auto[k]).map((k) => KIND_LABEL[k]);
  return [
    `ACTIONS (operator settings): AUTO — ${on.length ? on.join(', ') : 'none'}; ASK FIRST (Confirm card) — ${off.length ? off.join(', ') : 'none'}.`,
    '- An AUTO action you propose RUNS by itself right after your reply, through the same gated code as a Confirm',
    '  tap (every risk gate applies; mode can never become live). Say what you are doing ("exiting X now — the',
    '  result appears right below"); never say it is done. Propose it only when it is clearly what the operator',
    '  asked for or what an open position needs — it WILL happen.',
    '- An ASK FIRST action shows a Confirm card: tell them to tap Confirm.',
  ].join('\n');
}
