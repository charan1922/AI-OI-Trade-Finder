'use client';

import { Brain, Eye, LineChart, Wallet } from 'lucide-react';
import { type ClipboardEvent, useMemo, useState } from 'react';
import { Attachment, AttachmentPicker, Attachments, type AttachmentItem } from '@/components/ai-elements/attachments';
import { Context } from '@/components/ai-elements/context';
import { ModelSelector } from '@/components/ai-elements/model-selector';
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input';
import { Suggestion, Suggestions } from '@/components/ai-elements/suggestion';
import { cn } from '@/lib/utils';
import { fileToDataUrl, MAX_IMAGES } from '../_lib/image';
import { type AutoTradeState, type BackgroundState, istMinuteNow, type RaceState } from '../_lib/v2-view';

/** Wording from the auto-trade settings registry's own description of the two tiers. */
const MODEL_COPY: Record<string, { label: string; description: string }> = {
  'mimo-v2.6-pro': { label: 'MiMo v2.6 Pro', description: 'Quality-first default.' },
  'mimo-v2.6-flash': { label: 'MiMo v2.6 Flash', description: 'Lower-cost tier.' },
};

/**
 * Suggestions built ONLY from what is true right now (open positions, pending approvals, the live TF
 * board, Background state). Nothing applies → no pills. Never a fixed list.
 */
function liveSuggestions(autoTrade: AutoTradeState | null, background: BackgroundState | null, race: RaceState | null): string[] {
  const out: string[] = [];
  const open = (autoTrade?.trades ?? []).filter((t) => t.status === 'open');
  for (const t of open) out.push(`How's my ${t.symbol} position?`);
  for (const p of autoTrade?.pending ?? []) out.push(`Should I approve ${p.symbol}?`);
  if (background?.enabled) {
    const watched = new Set(
      (background.watches ?? []).filter((w) => w.status === 'watching' && w.kind === 'near_stop').map((w) => String(w.params.symbol))
    );
    for (const t of open) if (!watched.has(t.symbol)) out.push(`Watch ${t.symbol} — tell me if it nears the stop`);
  }
  const board = race?.board ?? [];
  for (const b of board.filter((x) => x.tradeable).slice(0, 2)) out.push(`Review TF pick ${b.symbol}`);
  const topRejected = board.filter((x) => !x.tradeable).sort((a, b) => a.rankNow - b.rankNow)[0];
  if (topRejected) out.push(`Why was ${topRejected.symbol} rejected?`);
  if (istMinuteNow() >= 15 * 60 + 30 && (autoTrade?.trades.length ?? 0) > 0) out.push('How did today go?');
  return [...new Set(out)].slice(0, 6);
}

export function Composer({
  autoTrade,
  background,
  race,
  pending,
  readOnly,
  tokensToday,
  onSend,
  onModel,
  onError,
  onStop,
}: {
  autoTrade: AutoTradeState | null;
  background: BackgroundState | null;
  race: RaceState | null;
  pending: number;
  readOnly: boolean;
  /** Today's v2 token use, summed from each reply's audit record (shown so cost stays visible). */
  tokensToday: { prompt: number; reply: number; replies: number };
  onSend: (text: string, images: string[], think: boolean) => Promise<boolean>;
  onModel: (mimoModel: string) => void;
  onError: (msg: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const [attached, setAttached] = useState<AttachmentItem[]>([]);
  // Think ON = MiMo reasons before answering (better, slower, more reply tokens). OFF = cheaper and faster.
  const [think, setThink] = useState(true);

  // Context that can be pinned to a message right now — all real rows, sent as plain text.
  const options = useMemo<AttachmentItem[]>(() => {
    const out: AttachmentItem[] = [];
    for (const t of autoTrade?.trades ?? []) {
      if (t.status !== 'open') continue;
      out.push({
        id: `pos-${t.id}`,
        label: `${t.symbol} ${t.optionType} position`,
        text: `[Attached: my open ${t.symbol} ${t.strike} ${t.optionType} (${t.direction}) — entry spot ${t.entrySpot}, spot stop ${t.slSpot ?? 'none'}]`,
        icon: <Wallet className="size-3" />,
      });
    }
    for (const w of background?.watches ?? []) {
      if (w.status !== 'watching') continue;
      out.push({
        id: `watch-${w.id}`,
        label: `watch #${w.id}`,
        text: `[Attached: watch #${w.id} "${w.label}" — last check: ${w.lastCheckNote ?? 'not checked yet'}]`,
        icon: <Eye className="size-3" />,
      });
    }
    for (const r of (race?.board ?? []).filter((b) => b.tradeable).slice(0, 5)) {
      out.push({
        id: `tf-${r.symbol}`,
        label: `${r.symbol} TF pick`,
        text: `[Attached: TF board row ${r.symbol} ${r.side}, rank #${r.rankNow}, marked tradeable by the selector]`,
        icon: <LineChart className="size-3" />,
      });
    }
    return out.filter((o) => !attached.some((a) => a.id === o.id));
  }, [autoTrade, background, race, attached]);

  const suggestions = useMemo(() => liveSuggestions(autoTrade, background, race), [autoTrade, background, race]);

  const addImages = async (files: File[]) => {
    const room = MAX_IMAGES - attached.filter((a) => a.image).length;
    if (room <= 0) {
      onError(`At most ${MAX_IMAGES} images per message.`);
      return;
    }
    for (const [i, f] of files.slice(0, room).entries()) {
      try {
        const image = await fileToDataUrl(f);
        setAttached((x) => [...x, { id: `img-${Date.now()}-${i}`, label: f.name || 'screenshot', image }]);
      } catch (e) {
        onError(`Could not attach ${f.name || 'image'}: ${(e as Error).message}`);
      }
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f != null);
    if (files.length) {
      e.preventDefault();
      void addImages(files);
    }
  };

  const submit = async (raw = text) => {
    const body = raw.trim();
    if (!body || readOnly) return;
    const context = attached.filter((a) => a.text).map((a) => a.text);
    const images = attached.filter((a) => a.image).map((a) => a.image as string);
    const full = context.length ? `${body}\n\n${context.join('\n')}` : body;
    setText('');
    setAttached([]);
    await onSend(full, images, think);
  };

  const wakeCap = background?.limits.wakeCapPerDay ?? null;
  const active = (background?.watches ?? []).filter((w) => w.status === 'watching').length;
  const model = background?.model ?? null;

  return (
    <div className="flex flex-col gap-1 border-t border-border bg-background/95 p-1.5">
      {suggestions.length > 0 && (
        <Suggestions>
          {suggestions.map((s) => (
            <Suggestion key={s} suggestion={s} disabled={readOnly} onClick={(v) => void submit(v)} />
          ))}
        </Suggestions>
      )}
      <PromptInput onSubmit={() => void submit()}>
        {attached.length > 0 && (
          <Attachments>
            {attached.map((a) => (
              <Attachment key={a.id} item={a} onRemove={() => setAttached((x) => x.filter((y) => y.id !== a.id))} />
            ))}
          </Attachments>
        )}
        <PromptInputTextarea
          value={text}
          disabled={readOnly}
          placeholder="Ask anything · paste a screenshot · or “tell me when …” to start a background watch"
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onSubmitKey={() => void submit()}
        />
        <PromptInputToolbar>
          <PromptInputTools>
            <AttachmentPicker
              options={options}
              disabled={readOnly}
              onPick={(o) => setAttached((x) => [...x, o])}
              onImages={(files) => void addImages(files)}
            />
            <button
              type="button"
              onClick={() => setThink((t) => !t)}
              disabled={readOnly}
              aria-pressed={think}
              title={think ? 'Think ON: the AI reasons before answering (slower, more tokens). Click to turn off.' : 'Think OFF: cheaper and faster. Click to turn on.'}
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px]',
                think ? 'bg-[var(--ai-accent)]/15 text-[var(--ai-accent)]' : 'text-muted-foreground hover:bg-muted'
              )}
            >
              <Brain className="size-3" /> Think {think ? 'on' : 'off'}
            </button>
            {model && (
              <ModelSelector
                value={model.mimoModel}
                options={model.options.map((v) => ({
                  value: v,
                  label: `${MODEL_COPY[v]?.label ?? v}${v === model.defaultModel ? ' (default)' : ''}`,
                  description: `${MODEL_COPY[v]?.description ?? ''} v2 chat only — the auto-trader keeps its own model.`,
                }))}
                disabled={readOnly}
                onChange={(v) => onModel(v)}
              />
            )}
            <Context
              label={`${((tokensToday.prompt + tokensToday.reply) / 1000).toFixed(1)}k tokens today`}
              used={tokensToday.prompt + tokensToday.reply}
              rows={[
                { label: 'v2 replies today', value: String(tokensToday.replies) },
                { label: 'Prompt tokens', value: tokensToday.prompt.toLocaleString('en-IN') },
                { label: 'Reply tokens', value: tokensToday.reply.toLocaleString('en-IN') },
                { label: 'Avg per reply', value: tokensToday.replies ? Math.round((tokensToday.prompt + tokensToday.reply) / tokensToday.replies).toLocaleString('en-IN') : '—' },
              ]}
            />
            {background && wakeCap != null && (
              <Context
                label={`${background.budget.used}/${wakeCap} wake-ups`}
                used={background.budget.used}
                max={wakeCap}
                rows={[
                  { label: 'Wake-ups used today', value: `${background.budget.used} / ${wakeCap}` },
                  { label: 'Active watches', value: `${active} / ${background.limits.maxActiveWatches}` },
                  { label: 'Notebook notes', value: String(background.notes.length) },
                  { label: 'Background', value: background.enabled ? 'ON' : 'OFF' },
                ]}
              />
            )}
          </PromptInputTools>
          <PromptInputSubmit busy={pending > 0} disabled={readOnly || !text.trim()} onStop={onStop} />
        </PromptInputToolbar>
      </PromptInput>
    </div>
  );
}
