/**
 * The v2 agent acting WITHOUT being asked — two kinds of turn, both the same LangGraph agent (graph.ts) run headless
 * and posted in v2's own thread (no Telegram — operator 2026-10-29):
 *
 *   runWakeTurn      — background watches fired; the agent tells the operator first.
 *   runHeartbeatTurn — its own self-paced check-in (heartbeat.ts): it looks, then either posts (only after calling
 *                      notify_operator) or stays quiet (logged, not posted), and picks its next check.
 *
 * Proposed actions run inside the graph's `act` node per the operator's Auto / Ask switches. Over a cap, or when the
 * AI fails, code writes a plain note for a watch wake-up so the operator still hears that the watch fired.
 */

import { getOpenTrades } from '@/lib/auto-trade/store';
import { hasMimo } from '@/lib/env';
import {
  getAutoActions,
  getChatModel,
  isBackgroundActive,
  listNotes,
  listWakeups,
  recordWakeup,
  savedMemories,
  setNextCheckAt,
} from './background-store';
import { applyProposals } from './actions';
import { type RunContext, runAgent, type RunMode } from './graph';
import { HEARTBEAT_DEFAULT_MIN, HEARTBEAT_MIN_MIN, type HeartbeatDecision, heartbeatPrompt } from './heartbeat';
import { addAssistantMessage, listMessages } from './store';
import { newTurnState } from './tools';
import type { AnswerDetails, WakeInfo } from './types';

const THREAD_TURNS = 8;

export interface FiredWatch {
  id: number;
  label: string;
  note: string;
}

/** Today's open auto-trade positions (symbols). A read failure → none. */
export async function openPositionSymbols(date: string): Promise<string[]> {
  try {
    return (await getOpenTrades()).filter((t) => t.date === date).map((t) => t.symbol);
  } catch {
    return [];
  }
}

async function threadLines(date: string): Promise<string[]> {
  const prior = await listMessages(date, 40);
  return prior
    .filter((m) => !m.action && m.content.trim())
    .slice(-THREAD_TURNS)
    .map((m) => `${m.role === 'user' ? 'OPERATOR' : 'YOU'}: ${m.content.slice(0, 600)}`);
}

function emptyDetails(wake: WakeInfo): AnswerDetails {
  return {
    steps: [],
    reasoning: [],
    thinkMs: null,
    plan: null,
    skills: [],
    question: null,
    memories: [],
    recovered: [],
    reviews: [],
    wake,
    ms: 0,
    rounds: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
  };
}

/** Code-written note when the AI is not called (cap) or failed. */
async function postPlain(date: string, fired: readonly FiredWatch[], outcome: 'capped' | 'fallback', why: string): Promise<void> {
  const body = [
    outcome === 'capped' ? `Watch fired — ${why}, so no AI read this time.` : `Watch fired — the AI couldn't reply: ${why}`,
    ...fired.map((f) => `• ${f.label}: ${f.note}`),
  ].join('\n');
  const msg = await addAssistantMessage(date, body, emptyDetails({ kind: 'watch', watches: [...fired], outcome }), null);
  await recordWakeup({ date, kind: 'watch', watchIds: fired.map((f) => f.id), outcome, messageId: msg.id, detail: why });
}

/** Build the run context for a headless turn. */
async function headlessContext(date: string, mode: RunMode, heartbeat: HeartbeatDecision | null): Promise<RunContext> {
  const [model, autoActions, memories, background, openPositions] = await Promise.all([
    getChatModel(),
    getAutoActions(),
    savedMemories(),
    isBackgroundActive(),
    openPositionSymbols(date),
  ]);
  return {
    date,
    mode,
    model,
    // Background turns think on the first round too: a check-in decides on positions.
    thinking: true,
    background,
    autoActions,
    memories,
    openPositions,
    turn: newTurnState(heartbeat),
    actions: [],
  };
}

async function runHeadless(
  ctx: RunContext,
  userText: string,
  wake: WakeInfo
): Promise<{ text: string; details: AnswerDetails; model: string }> {
  const started = Date.now();
  const r = await runAgent(ctx, [{ role: 'user', content: userText }]);
  const s = r.state;
  return {
    text: r.answer,
    model: `mimo/${r.model}`,
    details: {
      steps: s.steps,
      reasoning: s.reasoning,
      thinkMs: s.thinkMs,
      plan: ctx.turn.plan,
      skills: ctx.turn.skills,
      question: ctx.turn.question,
      memories: ctx.turn.memories,
      recovered: s.recovered,
      reviews: s.reviews,
      wake,
      ms: Date.now() - started,
      rounds: s.round,
      promptTokens: s.promptTokens,
      completionTokens: s.completionTokens,
      cachedTokens: s.cachedTokens,
      reasoningTokens: s.reasoningTokens,
    },
  };
}

/** A headless turn's actions run only once its message is in the thread, so each result sits under its reason. */
async function applyAfterPost(ctx: RunContext): Promise<void> {
  if (!ctx.turn.proposals.length) return;
  try {
    await applyProposals(ctx.date, ctx.turn.proposals, ctx.autoActions);
  } catch (err) {
    console.error('[ai-analysis-v2] applying the actions of a background turn failed:', (err as Error).message);
  }
}

export async function runWakeTurn(
  date: string,
  fired: readonly FiredWatch[],
  budget: { allowed: boolean; reason: string | null }
): Promise<void> {
  if (fired.length === 0) return;
  if (!budget.allowed) {
    await postPlain(date, fired, 'capped', budget.reason ?? 'wake-up cap reached');
    return;
  }
  if (!hasMimo()) {
    await postPlain(date, fired, 'fallback', 'MiMo is not configured on this server');
    return;
  }
  try {
    const ctx = await headlessContext(date, 'wake', null);
    const thread = await threadLines(date);
    const user = [
      ...(thread.length ? ["Earlier in today's thread (oldest first):", ...thread, ''] : []),
      'Your background watches just FIRED:',
      ...fired.map((f) => `- #${f.id} ${f.label} — ${f.note}`),
      '',
      'Check it with your tools, then write your message to the operator.',
    ].join('\n');
    const wake: WakeInfo = { kind: 'watch', watches: [...fired], outcome: 'ai' };
    const out = await runHeadless(ctx, user, wake);
    const msg = await addAssistantMessage(date, out.text, out.details, out.model);
    await recordWakeup({ date, kind: 'watch', watchIds: fired.map((f) => f.id), outcome: 'ai', messageId: msg.id, detail: null });
    await applyAfterPost(ctx);
  } catch (err) {
    await postPlain(date, fired, 'fallback', (err as Error).message.slice(0, 300));
  }
}

/**
 * One self-paced check-in. Posts only when the agent called notify_operator (or proposed an action, which must be
 * visible); a quiet check is logged in chat_wakeups (outcome 'quiet') and NOT posted. Always sets the next check.
 */
export async function runHeartbeatTurn(date: string): Promise<'posted' | 'quiet' | 'failed'> {
  const decision: HeartbeatDecision = { notify: null, nextMinutes: HEARTBEAT_DEFAULT_MIN, reason: '' };
  const scheduleNext = () => setNextCheckAt(new Date(Date.now() + decision.nextMinutes * 60_000).toISOString());
  if (!hasMimo()) {
    decision.nextMinutes = 30;
    await scheduleNext();
    await recordWakeup({ date, kind: 'heartbeat', watchIds: [], outcome: 'fallback', messageId: null, detail: 'MiMo is not configured on this server' });
    return 'failed';
  }
  try {
    const [ctx, notes, wakeups] = await Promise.all([headlessContext(date, 'checkin', decision), listNotes(date, 4), listWakeups(date)]);
    const lastQuiet = [...wakeups].reverse().find((w) => w.kind === 'heartbeat' && w.outcome === 'quiet')?.detail ?? null;
    const thread = await threadLines(date);
    const user = [
      ...(thread.length ? ["Earlier in today's thread (oldest first):", ...thread, ''] : []),
      heartbeatPrompt(notes.map((n) => n.text), lastQuiet, ctx.openPositions),
    ].join('\n');
    const wake: WakeInfo = { kind: 'heartbeat', watches: [], outcome: 'ai' };
    const out = await runHeadless(ctx, user, wake);
    // A position is open → back in 5 min, whatever the agent chose (code, not prompt).
    if ((await openPositionSymbols(date)).length > 0) decision.nextMinutes = HEARTBEAT_MIN_MIN;
    await scheduleNext();
    if (!decision.notify && ctx.turn.proposals.length === 0) {
      const line = out.text.replace(/\s+/g, ' ').trim().slice(0, 200) || 'checked — nothing worth raising';
      await recordWakeup({ date, kind: 'heartbeat', watchIds: [], outcome: 'quiet', messageId: null, detail: line });
      return 'quiet';
    }
    out.details.wake = { ...wake, reason: decision.notify ?? decision.reason };
    const msg = await addAssistantMessage(date, out.text, out.details, out.model);
    await recordWakeup({ date, kind: 'heartbeat', watchIds: [], outcome: 'ai', messageId: msg.id, detail: decision.notify ?? (decision.reason || null) });
    await applyAfterPost(ctx);
    return 'posted';
  } catch (err) {
    // Self-healing: a failed check-in backs off 10 min instead of retrying every minute.
    decision.nextMinutes = 10;
    await scheduleNext();
    await recordWakeup({ date, kind: 'heartbeat', watchIds: [], outcome: 'fallback', messageId: null, detail: (err as Error).message.slice(0, 300) });
    return 'failed';
  }
}
