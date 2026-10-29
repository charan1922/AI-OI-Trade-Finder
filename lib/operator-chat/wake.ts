/**
 * One WOKEN turn (Commentary v2): background watches fired, so the chat AI speaks first — in the
 * shared thread (no Telegram for now — operator 2026-10-29). Same provider, same read-only tools and Confirm cards as a chat
 * reply (lib/operator-chat/reply.ts); no order tools, so a wake-up can never trade.
 *
 * Over the daily cap, or when the AI fails, code writes the message itself so the operator still
 * hears that the watch fired.
 */

import { getCommentary } from '@/lib/ai-commentary/store';
import { hasMimo } from '@/lib/env';
import { getChatModel, recordWakeup } from './background-store';
import { backgroundFraming } from './background-tools';
import type { WakeInfo } from './format';
import { replyToOperator } from './reply';
import { addOperatorAction, addWakeMessage, listOperatorMessages, setMessageMeta } from './store';

const READ_CHARS = 1500;
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
  const wake: WakeInfo = { watches: [...fired], outcome };
  const msg = await addWakeMessage(date, body, wake, null);
  await recordWakeup({ date, watchIds: fired.map((f) => f.id), outcome, messageId: msg.id, detail: why });
}

async function wokenFraming(date: string): Promise<string> {
  const reads = await getCommentary({ date, limit: 1 }).catch(() => []);
  const latest = reads.length
    ? `--- trader read at ${reads[0].asOf} IST ---\n${reads[0].text.slice(0, READ_CHARS)}`
    : '(no trader read stored yet today)';
  return [
    '## Operator chat — you were WOKEN by your background watches',
    "You are writing in the SAME thread as the operator's chat and the trader's reads. Nobody asked you",
    'anything this time: a watch fired and you are telling the operator first.',
    '- Re-check what fired with your tools before you speak — never restate the watch note as if you',
    '  had looked. If the move already reversed, say so.',
    '- 60–150 words: what happened, what it means for them (an open position? a pick?), and what to watch',
    '  next. Plain English, real numbers from your tools, no metric soup.',
    '- You cannot trade. If an action makes sense (exit, tighten a stop), use propose_action so a Confirm',
    '  card appears — never say it is done. Orders are placed only by the auto-trader.',
    '- If something is worth watching next, start_watch it and say so. Then write_note.',
    '- Do NOT end with the "no order is placed" line.',
    '',
    await backgroundFraming(date),
    '',
    'Latest trader read (context only):',
    latest,
  ].join('\n');
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
  const mimoModel = await getChatModel();
  try {
    const prior = await listOperatorMessages(date, THREAD_TURNS);
    const thread = prior
      .filter((m) => !m.action)
      .map((m) => `${m.role === 'user' ? 'OPERATOR' : 'YOU'}: ${m.content.slice(0, 600)}`);
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
      framing: await wokenFraming(date),
      background: { date },
      agentic: true,
      model: { provider: 'mimo', mimoModel },
      userOverride: user,
    });
    const wake: WakeInfo = { watches: [...fired], outcome: 'ai' };
    const msg = await addWakeMessage(date, result.text, wake, `${result.provider}/${result.model}`, result.tools);
    await setMessageMeta(msg.id, result.meta);
    for (const p of result.proposals) await addOperatorAction(date, p.description, p.action);
    await recordWakeup({ date, watchIds: fired.map((f) => f.id), outcome: 'ai', messageId: msg.id, detail: null });
  } catch (err) {
    await postPlain(date, fired, 'fallback', (err as Error).message.slice(0, 300));
  }
}
