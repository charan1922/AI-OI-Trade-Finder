'use client';

import { Bot, LineChart, User, Wrench, Zap } from 'lucide-react';
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep } from '@/components/ai-elements/chain-of-thought';
import { Checkpoint } from '@/components/ai-elements/checkpoint';
import { CodeBlock } from '@/components/ai-elements/code-block';
import { Confirmation } from '@/components/ai-elements/confirmation';
import { Context } from '@/components/ai-elements/context';
import { Conversation, ConversationContent, ConversationEmptyState } from '@/components/ai-elements/conversation';
import { InlineCitation, InlineCitationCard } from '@/components/ai-elements/inline-citation';
import { Message, MessageContent, MessageHeader } from '@/components/ai-elements/message';
import { Plan, PlanStep } from '@/components/ai-elements/plan';
import { Question } from '@/components/ai-elements/question';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { Spinner } from '@/components/ai-elements/shimmer';
import { Source, Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources';
import { StackTrace } from '@/components/ai-elements/stack-trace';
import { Tool, ToolContent, ToolHeader, ToolOutput, ToolSummary } from '@/components/ai-elements/tool';
import { RichText } from '@/components/rich-text';
import { isActionExpired } from '@/lib/operator-chat/format';
import { fmtMs, fmtTokens, hhmm, type LiveTurn, sourcesOf, type ThreadItem, type V2Message } from '../_lib/v2-view';

const BODY = 'space-y-0.5 text-[10.5px] leading-snug text-foreground/90';
const HEADING = 'pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground';

/** "Thought for Xs": MiMo's OWN reasoning when the run had thinking on; else where the time went. */
function ReplyReasoning({ msg }: { msg: V2Message }) {
  const thoughts = msg.meta?.reasoning ?? [];
  if (thoughts.length === 0) return null; // nothing real to show — never a placeholder thought
  // Thinking runs on the first (planning) model call; its span is the honest "thought for".
  const thinkMs = msg.meta?.spans.find((s) => s.name.startsWith('model'))?.ms ?? 0;
  return (
    <Reasoning>
      <ReasoningTrigger seconds={thinkMs / 1000} />
      <ReasoningContent>
        <div className="flex flex-col gap-1 whitespace-pre-wrap">
          {thoughts.map((t, i) => (
            <p key={i}>{t}</p>
          ))}
        </div>
      </ReasoningContent>
    </Reasoning>
  );
}

/** Bookkeeping tools — shown elsewhere (plan, skill chip, notebook, memory), not as "work" steps. */
const HIDDEN_TOOLS = /^(update plan|write note|use skill|prepared an action card)/;
/** Summaries that are just an internal route ("scan_verdicts /api/tf/race") say nothing to a reader. */
const isPlumbing = (s: string | null | undefined) => !s || /\s\/api\//.test(s) || /^in-process:/.test(s);
/** IN as readable "key: value" pairs instead of raw JSON. */
function readableInput(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    const o = JSON.parse(input) as Record<string, unknown>;
    return Object.entries(o)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join('\n');
  } catch {
    return input;
  }
}

/** The turn's steps as a timeline, from its audit record — wake cause, skills, each tool (IN ⎿ OUT). */
function ReplySteps({ msg }: { msg: V2Message }) {
  const tools = (msg.tools ?? []).filter((t) => !HIDDEN_TOOLS.test(t.label));
  const wake = msg.wake;
  const skills = msg.meta?.skills ?? [];
  if (!wake && tools.length === 0) return null;
  const header = `${wake ? (wake.kind === 'heartbeat' ? 'Checked in on its own · ' : 'Woke on its own · ') : ''}Read ${tools.length} source${tools.length === 1 ? '' : 's'}${skills.length ? ` · using ${skills.map((s) => s.replace(/_/g, ' ')).join(', ')}` : ''}`;
  return (
    <ChainOfThought defaultOpen={tools.length <= 4}>
      <ChainOfThoughtHeader>{header}</ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {wake?.watches.map((w) => (
          <ChainOfThoughtStep key={`w${w.id}`} icon={<Zap className="mt-0.5 size-3 shrink-0 text-[var(--ai-accent)]" />} label={`Watch #${w.id} fired: ${w.label}`} description={w.note} />
        ))}
        {tools.map((t, i) => {
          const input = readableInput(t.input);
          return (
            <li key={`t${i}`}>
              <Tool>
                <ToolHeader name={t.label} state={t.ok ? 'ok' : 'error'} />
                {(!t.ok || !isPlumbing(t.summary)) && <ToolSummary error={!t.ok}>{t.summary ?? 'failed'}</ToolSummary>}
                {input && (
                  <ToolContent>
                    <CodeBlock language="in" code={input} />
                    {!isPlumbing(t.summary) && <ToolOutput output={t.summary} errorText={t.ok ? null : (t.summary ?? 'failed')} />}
                  </ToolContent>
                )}
              </Tool>
            </li>
          );
        })}
        {wake && (
          <ChainOfThoughtStep
            status={wake.outcome === 'ai' ? 'complete' : 'failed'}
            label={
              wake.outcome === 'ai'
                ? 'Posted here'
                : wake.outcome === 'capped'
                  ? 'Over the daily wake-up cap — code posted the note, no AI read'
                  : 'The AI call failed — code posted the note'
            }
          />
        )}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

/** The AI's own step plan (update_plan), exactly as it last left it. */
function ReplyPlan({ msg }: { msg: V2Message }) {
  const plan = msg.meta?.plan;
  if (!plan || plan.length === 0) return null;
  const done = plan.filter((s) => s.status === 'done').length;
  return (
    <Plan title={`Plan · ${done}/${plan.length} done`}>
      {plan.map((s, i) => (
        <PlanStep key={`${s.title}-${i}`} status={s.status === 'done' ? 'done' : s.status === 'in_progress' ? 'now' : 'next'} title={s.title} />
      ))}
    </Plan>
  );
}

function ChatRow({
  msg,
  canAct,
  onAct,
  onAnswer,
  isLatest,
}: {
  msg: V2Message;
  canAct: boolean;
  onAct: (id: number, d: 'confirm' | 'cancel') => void;
  onAnswer: (text: string) => void;
  isLatest: boolean;
}) {
  if (msg.action) {
    const expired = msg.action.status === 'pending' && isActionExpired(msg.at);
    return (
      <Message from="assistant">
        <div className="w-full pl-3">
          <Confirmation
            title={msg.content}
            status={expired ? 'expired' : msg.action.status}
            result={msg.action.result}
            canAct={canAct}
            onConfirm={() => onAct(msg.id, 'confirm')}
            onCancel={() => onAct(msg.id, 'cancel')}
          />
        </div>
      </Message>
    );
  }
  if (msg.role === 'user') {
    return (
      <Message from="user">
        <MessageContent>
          <MessageHeader icon={<User className="size-3" />} name="You" time={msg.at ? hhmm(msg.at) : undefined} />
          <p className="whitespace-pre-wrap text-[10.5px]">{msg.content}</p>
          {(msg.images ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {msg.images!.map((name) => {
                const src = `/api/trade-commentary/chat/image?name=${encodeURIComponent(name)}`;
                return (
                  <a key={name} href={src} target="_blank" rel="noreferrer">
                    {/* Stored screenshot served by our own admin-only route. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt="Attached screenshot" className="h-14 rounded border border-border object-cover" />
                  </a>
                );
              })}
            </div>
          )}
        </MessageContent>
      </Message>
    );
  }
  const tools = msg.tools ?? [];
  const meta = msg.meta;
  const question = meta?.question;
  return (
    <Message from="assistant">
      <MessageContent>
        <MessageHeader
          icon={msg.wake ? <Zap className="size-3 text-[var(--ai-accent)]" /> : <Bot className="size-3" />}
          name={msg.wake ? (msg.wake.kind === 'heartbeat' ? 'AI · checked in on its own' : 'AI · woke on its own') : 'AI'}
          time={hhmm(msg.at)}
        >
          {msg.model && <span className="rounded bg-muted px-1">{msg.model}</span>}
          {meta && (
            <Context
              label={fmtTokens((meta.promptTokens ?? 0) + (meta.completionTokens ?? 0))}
              used={(meta.promptTokens ?? 0) + (meta.completionTokens ?? 0)}
              rows={[
                { label: 'Prompt tokens', value: fmtTokens(meta.promptTokens) },
                ...(meta.cachedTokens != null ? [{ label: '…from cache (cheap)', value: fmtTokens(meta.cachedTokens) }] : []),
                { label: 'Reply tokens', value: fmtTokens(meta.completionTokens) },
                ...(meta.reasoningTokens != null ? [{ label: '…of which thinking', value: fmtTokens(meta.reasoningTokens) }] : []),
                { label: 'Thinking', value: meta.thinking === true ? 'on' : meta.thinking === false ? 'off' : 'not recorded' },
                { label: 'Took', value: fmtMs(meta.ms) },
                ...(meta.skills?.length ? [{ label: 'Skills', value: meta.skills.join(', ') }] : []),
                { label: 'Model rounds', value: String(meta.spans.filter((s) => s.name.startsWith('model')).length) },
              ]}
            />
          )}
        </MessageHeader>
        <div className="flex flex-col gap-1 border-l border-border/60 pl-2">
          <ReplyReasoning msg={msg} />
          <ReplySteps msg={msg} />
          <ReplyPlan msg={msg} />
          {(meta?.recovered ?? []).length > 0 && (
            <p className="text-[10px] text-amber-700 dark:text-amber-400">
              Self-healed: {meta!.recovered!.length} attempt{meta!.recovered!.length === 1 ? '' : 's'} failed first — {meta!.recovered!.join(' · ')}
            </p>
          )}
          {msg.wake && msg.wake.outcome === 'fallback' && (
            <StackTrace
              title="The AI could not reply to this wake-up"
              message={msg.content.split('\n')[0]}
              frames={msg.wake.watches.map((w) => `watch #${w.id} ${w.label}`)}
            />
          )}
          <div className="flex gap-1.5">
            <span className="mt-[5px] size-1.5 shrink-0 rounded-full bg-foreground/70" aria-hidden />
            <RichText content={msg.content} className={BODY} headingClass={HEADING} />
          </div>
          {question && (
            <Question
              title={question.text}
              disabled={!canAct || !isLatest}
              note={isLatest ? 'Tap one — it is sent as your reply.' : 'Answered or superseded by a later message.'}
              options={question.options.map((o) => ({ label: o, onSelect: () => onAnswer(o) }))}
            />
          )}
          {(meta?.memories ?? []).length > 0 && (
            <p className="text-[10px] text-sky-700 dark:text-sky-400">
              Proposed {meta!.memories!.length} thing{meta!.memories!.length === 1 ? '' : 's'} to remember — review in Memory (Background panel).
            </p>
          )}
          {tools.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <InlineCitation>
                <span className="text-[9px] text-muted-foreground">Read:</span>
                {tools.map((t, i) => (
                  <InlineCitationCard key={`${t.label}-${i}`} index={i + 1} title={t.label} detail={t.summary} ok={t.ok} />
                ))}
              </InlineCitation>
              <Sources>
                <SourcesTrigger count={sourcesOf(tools).length} />
                <SourcesContent>
                  {sourcesOf(tools).map((s) => (
                    <Source key={s} title={s} />
                  ))}
                </SourcesContent>
              </Sources>
            </div>
          )}
        </div>
      </MessageContent>
    </Message>
  );
}

/** The reply being written right now — the real steps from the progress feed, as they happen. */
function LiveReply({ live }: { live: LiveTurn | null }) {
  const all = live?.steps ?? [];
  // Model calls drive the spinner text ("Thinking"); only real work (reads, retries) is listed.
  const steps = all.filter((s) => !s.label.startsWith('Thinking'));
  const current = [...all].reverse().find((s) => s.state === 'running');
  const spinnerLabel = !current
    ? all.length
      ? 'Writing the answer'
      : 'Thinking'
    : current.label.startsWith('Thinking')
      ? 'Thinking'
      : current.label;
  return (
    <Message from="assistant">
      <MessageContent>
        <div className="flex flex-col gap-1 border-l border-border/60 pl-2">
          <Spinner label={spinnerLabel} elapsedMs={live?.elapsedMs} />
          {steps.length > 0 && (
            <ol className="flex flex-col gap-0.5 text-[10px]">
              {steps.map((s, i) => (
                <ChainOfThoughtStep
                  key={`${s.label}-${i}`}
                  status={s.state === 'ok' ? 'complete' : s.state === 'error' ? 'failed' : 'active'}
                  icon={s.label.startsWith('Self-healing') ? <Wrench className="mt-0.5 size-3 shrink-0 text-amber-600" /> : undefined}
                  label={s.label}
                  description={isPlumbing(s.detail) ? null : s.detail}
                />
              ))}
            </ol>
          )}
        </div>
      </MessageContent>
    </Message>
  );
}

export function Thread({
  items,
  pending,
  live,
  canAct,
  onAct,
  onAnswer,
}: {
  items: ThreadItem[];
  pending: number;
  live: LiveTurn | null;
  canAct: boolean;
  onAct: (id: number, d: 'confirm' | 'cancel') => void;
  onAnswer: (text: string) => void;
}) {
  const lastChatId = [...items].reverse().find((it) => it.kind === 'chat')?.msg.id;
  return (
    <Conversation contentKey={`${items.length}:${pending}:${live?.steps.length ?? 0}`}>
      <ConversationContent>
        {items.length === 0 && (
          <ConversationEmptyState
            icon={<Bot className="size-5" />}
            title="Nothing in today's thread yet"
            description="Ask anything below, paste a screenshot, or say “tell me when …” to start a background watch (checked on the trading server while Background is ON)."
          />
        )}
        {items.map((it) =>
          it.kind === 'day' ? (
            <Checkpoint key={`day-${it.ms}`} label={it.label} />
          ) : it.kind === 'checkpoint' ? (
            <Checkpoint key={`cp-${it.ms}`} label={it.label} time={it.time} />
          ) : it.kind === 'read' ? (
            <Message key={`r-${it.read.id}`} from="system">
              <MessageContent>
                <MessageHeader icon={<LineChart className="size-3" />} name="Trader read" time={hhmm(it.read.createdAt)}>
                  <span className="rounded bg-muted px-1">{it.read.model}</span>
                  <span>
                    {it.read.picksCount} pick{it.read.picksCount === 1 ? '' : 's'}
                  </span>
                </MessageHeader>
                <RichText content={it.read.text} className={BODY} headingClass={HEADING} />
              </MessageContent>
            </Message>
          ) : (
            <ChatRow
              key={`m-${it.msg.id}`}
              msg={it.msg}
              canAct={canAct}
              onAct={onAct}
              onAnswer={onAnswer}
              isLatest={it.msg.id === lastChatId && pending === 0}
            />
          )
        )}
        {pending > 0 && <LiveReply live={live} />}
      </ConversationContent>
    </Conversation>
  );
}
