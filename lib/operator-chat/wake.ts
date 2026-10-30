/**
 * The v2 AI acting WITHOUT being asked (Commentary v2) — two kinds of turn, both in the shared thread
 * (no Telegram for now — operator 2026-10-29):
 *
 *   runWakeTurn      — background watches fired; the AI tells the operator first.
 *   runHeartbeatTurn — its own self-paced check-in (heartbeat.ts): it looks, then either posts or stays
 *                      quiet (logged, not posted), and picks its next check.
 *
 * Same provider/model, tools and per-action switches as a v2 chat reply. Over a cap, or when the AI fails,
 * code writes a plain note for watch wake-ups so the operator still hears that the watch fired.
 *
 * Prompt order follows the caching rule (reply.ts): the framing here is STATIC; everything that changes
 * (action switches, watches, notebook, the latest trader read) goes in `context`, which is placed last.
 */

import { getCommentary } from '@/lib/ai-commentary/store';
import { hasMimo } from '@/lib/env';
import { actionModeBlock, applyProposals } from './auto-act';
import { getAutoActions, getChatModel, listNotes, listWakeups, recordWakeup, setNextCheckAt } from './background-store';
import { backgroundFraming } from './background-tools';
import type { WakeInfo } from './format';
import { HEARTBEAT_DEFAULT_MIN, type HeartbeatDecision, heartbeatPrompt } from './heartbeat';
import { replyToOperator } from './reply';
import { addWakeMessage, listOperatorMessages, setMessageMeta } from './store';

const READ_CHARS = 1200;
const THREAD_TURNS = 8;

export interface FiredWatch {
  id: number;
  label: string;
  note: string;
}

const firedLines = (fired: readonly FiredWatch[]) => fired.map((f) => `- #${f.id} ${f.label} — ${f.note}`).join('\n');

/** Code-written message when the AI is not called (cap) or failed. */
async function postPlain(
  date: string,
  fired: readonly FiredWatch[],
  outcome: 'capped' | 'fallback',
  why: string
): Promise<void> {
  const body = [
    outcome === 'capped' ? `Watch fired — ${why}, so no AI read this time.` : `Watch fired — the AI couldn't reply: ${why}`,
    ...fired.map((f) => `• ${f.label}: ${f.note}`),
  ].join('\n');
  const wake: WakeInfo = { kind: 'watch', watches: [...fired], outcome };
  const msg = await addWakeMessage(date, body, wake, null);
  await recordWakeup({ date, kind: 'watch', watchIds: fired.map((f) => f.id), outcome, messageId: msg.id, detail: why });
}

/** STATIC rules for a turn nobody asked for (identical every call — cacheable). */
const UNPROMPTED_FRAMING = [
  '## Operator chat — you are acting WITHOUT being asked',
  "You write in the SAME thread as the operator's chat and the trader's reads. Nobody asked you anything:",
  'either a watch fired, or this is your own regular check-in.',
  '- Re-check with your tools before you speak — never restate a watch note or an old note as if you had',
  '  just looked. If a move already reversed, say so.',
  '- When you post: 60–150 words — what happened, what it means for the operator (an open position? a',
  '  pick?), what to do or watch next. Plain English, real numbers from THIS turn\'s tools, no metric soup.',
  '- Actions follow the operator\'s per-action switches (in Live context): AUTO kinds run by themselves right',
  '  after your message; ASK kinds become Confirm cards. Orders are placed only by the auto-trader.',
  '- Your final message IS what the operator reads — never "noted". Do NOT end with the "no order is placed" line.',
].join('\n');

/** Everything that changes per turn — goes LAST. */
async function liveContext(date: string): Promise<string> {
  const reads = await getCommentary({ date, limit: 1 }).catch(() => []);
  const latest = reads.length
    ? `--- trader read at ${reads[0].asOf} IST ---\n${reads[0].text.slice(0, READ_CHARS)}`
    : '(no trader read stored yet today)';
  return [
    actionModeBlock(await getAutoActions()),
    await backgroundFraming(date),
    `Latest trader read (context only):\n${latest}`,
  ].join('\n\n');
}

async function threadLines(date: string): Promise<string[]> {
  const prior = await listOperatorMessages(date, THREAD_TURNS);
  return prior.filter((m) => !m.action).map((m) => `${m.role === 'user' ? 'OPERATOR' : 'YOU'}: ${m.content.slice(0, 600)}`);
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
  // Wake-ups belong to v2: MiMo on v2's chat model (default Flash), whatever the trader's provider is.
  if (!hasMimo()) {
    await postPlain(date, fired, 'fallback', 'MiMo is not configured on this server');
    return;
  }
  const [mimoModel, autoActions] = await Promise.all([getChatModel(), getAutoActions()]);
  try {
    const thread = await threadLines(date);
    const user = [
      ...(thread.length ? ['The thread so far today (oldest first):', ...thread, ''] : []),
      'Your background watches just FIRED:',
      firedLines(fired),
      '',
      'Check it, then write your message to the operator.',
    ].join('\n');
    const result = await replyToOperator({
      message: '',
      prior: [],
      framing: UNPROMPTED_FRAMING,
      context: await liveContext(date),
      background: { date },
      agentic: true,
      model: { provider: 'mimo', mimoModel },
      autoActions,
      userOverride: user,
    });
    const wake: WakeInfo = { kind: 'watch', watches: [...fired], outcome: 'ai' };
    const msg = await addWakeMessage(date, result.text, wake, `${result.provider}/${result.model}`, result.tools);
    await setMessageMeta(msg.id, result.meta);
    await applyProposals(date, result.proposals, autoActions);
    await recordWakeup({ date, kind: 'watch', watchIds: fired.map((f) => f.id), outcome: 'ai', messageId: msg.id, detail: null });
  } catch (err) {
    await postPlain(date, fired, 'fallback', (err as Error).message.slice(0, 300));
  }
}

/**
 * One self-paced check-in. Posts only when the AI judged something worth the operator's attention; a quiet
 * check is logged (chat_wakeups, outcome 'quiet') and NOT posted. Always sets the next check time.
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
  const [mimoModel, autoActions, notes, wakeups] = await Promise.all([
    getChatModel(),
    getAutoActions(),
    listNotes(date, 4),
    listWakeups(date),
  ]);
  const lastQuiet = [...wakeups].reverse().find((w) => w.kind === 'heartbeat' && w.outcome === 'quiet')?.detail ?? null;
  try {
    const thread = await threadLines(date);
    const user = [
      ...(thread.length ? ['The thread so far today (oldest first):', ...thread, ''] : []),
      heartbeatPrompt(notes.map((n) => n.text), lastQuiet),
    ].join('\n');
    const result = await replyToOperator({
      message: '',
      prior: [],
      framing: UNPROMPTED_FRAMING,
      context: await liveContext(date),
      background: { date },
      agentic: true,
      model: { provider: 'mimo', mimoModel },
      autoActions,
      heartbeat: decision,
      userOverride: user,
    });
    await scheduleNext();
    // Quiet unless the AI explicitly chose to notify (or proposed an action, which must be visible).
    if (!decision.notify && result.proposals.length === 0) {
      const line = result.text.replace(/\s+/g, ' ').trim().slice(0, 200) || 'checked — nothing worth raising';
      await recordWakeup({ date, kind: 'heartbeat', watchIds: [], outcome: 'quiet', messageId: null, detail: line });
      return 'quiet';
    }
    const wake: WakeInfo = { kind: 'heartbeat', watches: [], outcome: 'ai', reason: decision.notify ?? decision.reason };
    const msg = await addWakeMessage(date, result.text, wake, `${result.provider}/${result.model}`, result.tools);
    await setMessageMeta(msg.id, result.meta);
    await applyProposals(date, result.proposals, autoActions);
    await recordWakeup({ date, kind: 'heartbeat', watchIds: [], outcome: 'ai', messageId: msg.id, detail: decision.reason || null });
    return 'posted';
  } catch (err) {
    // Self-healing: a failed check-in backs off to 10 min instead of retrying every minute.
    decision.nextMinutes = 10;
    await scheduleNext();
    await recordWakeup({ date, kind: 'heartbeat', watchIds: [], outcome: 'fallback', messageId: null, detail: (err as Error).message.slice(0, 300) });
    return 'failed';
  }
}
