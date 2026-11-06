'use client';

import { Loader2, SendHorizontal, Sparkles, X, Zap } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { RichText } from '@/components/rich-text';
import { type ActionStatus, type ActionView, isActionExpired } from '@/lib/operator-chat/format';
import type { ChatMessage, ChatNotice } from '../_hooks/use-operator-chat';

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
}

const STATUS_STYLE: Record<ActionStatus, string> = {
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300',
  running: 'bg-sky-100 text-sky-800 dark:bg-sky-500/10 dark:text-sky-300',
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-500/10 dark:text-red-300',
  cancelled: 'bg-muted text-muted-foreground',
};

/**
 * A proposed action. Nothing has happened until Confirm is tapped; the server
 * then runs it through the /auto-trade console's own gated code. An expired
 * card (ACTION_TTL_MS) cannot be confirmed — "exit X" means now, not later.
 */
function ActionCard({
  message,
  onAct,
}: {
  message: ChatMessage;
  onAct: (id: number, decision: 'confirm' | 'cancel') => Promise<void>;
}) {
  const action = message.action as ActionView;
  const expired = action.status === 'pending' && isActionExpired(message.at);
  const live = action.status === 'pending' && !expired;
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] rounded-2xl rounded-bl-sm border-2 border-primary/40 bg-card px-3 py-2 shadow-sm">
        <div className="mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Zap className="h-3 w-3 text-primary" />
          <span className="font-medium text-foreground">Action</span>
          <span>{clock(message.at)} IST</span>
          <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${STATUS_STYLE[action.status]}`}>
            {expired ? 'expired' : action.status === 'running' ? 'running…' : action.status}
          </span>
        </div>
        <div className="text-[13px] font-medium leading-relaxed text-foreground">{message.content}</div>
        {action.result && <div className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{action.result}</div>}
        {live && (
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => void onAct(message.id, 'confirm')}
              className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => void onAct(message.id, 'cancel')}
              className="rounded-md border px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        )}
        {expired && <div className="mt-1 text-[11px] text-muted-foreground">Over 10 minutes old — ask again for a fresh card.</div>}
      </div>
    </div>
  );
}

/** One chat line inside the commentary stream: the operator on the right, the AI's reply on the left. */
export function ChatItem({
  message,
  onAct,
}: {
  message: ChatMessage;
  onAct: (id: number, decision: 'confirm' | 'cancel') => Promise<void>;
}) {
  if (message.action) return <ActionCard message={message} onAct={onAct} />;
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-[13px] leading-relaxed text-primary-foreground shadow-sm">
          <div className="break-words whitespace-pre-wrap">{message.content}</div>
          <div className="mt-0.5 text-right text-[9px] opacity-70">you · {clock(message.at)} IST</div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] rounded-2xl rounded-bl-sm border bg-card px-3 py-2 shadow-sm">
        <div className="mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Sparkles className="h-3 w-3 text-primary" />
          <span className="font-medium text-foreground">AI</span>
          <span>{clock(message.at)} IST</span>
        </div>
        <RichText content={message.content} />
      </div>
    </div>
  );
}

/** One-tap questions. They send exactly as if typed — same thread, same rules, same Confirm cards. */
const SUGGESTIONS = [
  'Is the market sideways right now?',
  'Why no trade so far today?',
  "How's my open position?",
  'What is on TF’s board right now?',
  'Take the top pick',
];

/**
 * The input for the thread. It sits at the top of the stream (newest first), so
 * what you type lands right under it, between the AI's commentary reads. It is
 * never disabled while commentary is generating or a reply is pending.
 */
export function ChatComposer({
  onSend,
  pending,
  notices,
  onDismiss,
  configured,
}: {
  onSend: (text: string) => Promise<boolean>;
  pending: number;
  notices: ChatNotice[];
  onDismiss: (key: string) => void;
  configured: boolean;
}) {
  const [draft, setDraft] = useState('');

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    const ok = await onSend(text);
    // Not saved → give the text back so nothing the operator typed is lost.
    if (!ok) setDraft((d) => (d ? d : text));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="sticky top-0 z-20 -mx-1 space-y-1.5 bg-background/90 px-1 pt-1 pb-1.5 backdrop-blur">
      <div className="rounded-xl border bg-card p-2 shadow-sm">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            maxLength={2000}
            placeholder="Talk to the AI — suggest, ask, tell it what you think. It reads this on its next pass and decides according to you (inside the risk gates). Enter to send."
            className="min-h-[44px] flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!draft.trim()}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40"
            title="Send"
          >
            <SendHorizontal className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-1.5 flex gap-1.5 overflow-x-auto pb-0.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => void onSend(s)}
              className="shrink-0 rounded-full border bg-background px-2.5 py-0.5 text-[11px] text-muted-foreground hover:border-primary/50 hover:text-foreground"
            >
              {s}
            </button>
          ))}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>Same thread as the commentary below — you can keep talking while it generates.</span>
          {pending > 0 && (
            <span className="ml-auto flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> AI is replying…
            </span>
          )}
        </div>
      </div>

      {!configured && (
        <div className="rounded-md border border-amber-300/70 bg-amber-50/70 px-2.5 py-1.5 text-[11px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          The chat-reply model isn’t configured on this instance — your messages are still saved and the trader still
          reads them.
        </div>
      )}
      {notices.map((n) => (
        <div
          key={n.key}
          className="flex items-start gap-2 rounded-md border border-amber-300/70 bg-amber-50/70 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
        >
          <span className="flex-1">{n.text}</span>
          <button type="button" onClick={() => onDismiss(n.key)} className="shrink-0 opacity-60 hover:opacity-100">
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
