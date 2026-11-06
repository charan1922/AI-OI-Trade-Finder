'use client';

import { Bot, LineChart, User, Zap } from 'lucide-react';
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
import { isActionExpired, type AnswerDetails, type PlanStep as PlanStepT, type StepRecord } from '@/lib/ai-analysis-v2/types';
import { fmtMs, fmtTokens, hhmm, type LiveTurn, sourcesOf, type ThreadItem, type V2Message } from '../_lib/v2-view';
import { Markdown } from './markdown';

const BODY = 'space-y-1 text-[11px] leading-relaxed text-foreground/90';

/** A tool result line that is only an internal route ("auto_trade_today /api/auto-trade") tells a reader nothing. */
const isPlumbing = (s: string | null | undefined) => !s || /\s\/api\//.test(s) || /^in-process:/.test(s);

function Thought({ text, ms, live }: { text: string; ms: number | null; live?: boolean }) {
  if (!text) return null;
  return (
    <Reasoning defaultOpen={live}>
      <ReasoningTrigger seconds={(ms ?? 0) / 1000} label={live ? 'Thinking…' : ms ? undefined : 'Thought'} />
      <ReasoningContent>
        <p className="whitespace-pre-wrap">{text}</p>
      </ReasoningContent>
    </Reasoning>
  );
}

function Steps({ steps, live }: { steps: (StepRecord & { running?: boolean })[]; live?: boolean }) {
  if (!steps.length) return null;
  const body = steps.map((s) => (
    <li key={s.id}>
      <Tool>
        <ToolHeader name={s.title} state={s.running ? 'running' : s.ok ? 'ok' : 'error'} />
        {!s.running && (!s.ok || !isPlumbing(s.detail)) && <ToolSummary error={!s.ok}>{s.detail ?? (s.ok ? 'done' : 'failed')}</ToolSummary>}
        {!s.running && s.input && (
          <ToolContent>
            <CodeBlock language="in" code={s.input.split(' · ').join('\n')} />
            {s.ms != null && <ToolOutput output={`took ${fmtMs(s.ms)}`} />}
          </ToolContent>
        )}
      </Tool>
    </li>
  ));
  if (live) return <ol className="flex flex-col gap-1">{body}</ol>;
  return (
    <ChainOfThought defaultOpen={steps.length <= 4}>
      <ChainOfThoughtHeader>
        Read {steps.length} source{steps.length === 1 ? '' : 's'}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent>{body}</ChainOfThoughtContent>
    </ChainOfThought>
  );
}

function PlanBox({ plan }: { plan: PlanStepT[] | null }) {
  if (!plan?.length) return null;
  const done = plan.filter((s) => s.status === 'done').length;
  return (
    <Plan title={`Plan · ${done}/${plan.length} done`}>
      {plan.map((s, i) => (
        <PlanStep key={`${s.title}-${i}`} status={s.status === 'done' ? 'done' : s.status === 'in_progress' ? 'now' : 'next'} title={s.title} />
      ))}
    </Plan>
  );
}

function tokenRows(d: AnswerDetails) {
  return [
    { label: 'Prompt tokens', value: fmtTokens(d.promptTokens) },
    { label: '…from cache (cheap)', value: fmtTokens(d.cachedTokens) },
    { label: 'Reply tokens', value: fmtTokens(d.completionTokens) },
    { label: '…of which thinking', value: fmtTokens(d.reasoningTokens) },
    { label: 'Model rounds', value: String(d.rounds) },
    { label: 'Took', value: fmtMs(d.ms) },
    ...(d.skills.length ? [{ label: 'Skills', value: d.skills.join(', ') }] : []),
  ];
}

function Answer({
  msg,
  canAct,
  isLatest,
  onAnswer,
}: {
  msg: V2Message;
  canAct: boolean;
  isLatest: boolean;
  onAnswer: (text: string) => void;
}) {
  const d = msg.details;
  const wake = d?.wake ?? null;
  const steps = d?.steps ?? [];
  return (
    <Message from="assistant">
      <MessageContent>
        <MessageHeader
          icon={wake ? <Zap className="size-3 text-[var(--ai-accent)]" /> : <Bot className="size-3" />}
          name={wake ? (wake.kind === 'heartbeat' ? 'AI · checked in on its own' : 'AI · woke on its own') : 'AI'}
          time={hhmm(msg.at)}
        >
          {msg.model && <span className="rounded bg-muted px-1">{msg.model.replace(/^mimo\//, '')}</span>}
          {d && d.promptTokens + d.completionTokens > 0 && (
            <Context label={fmtTokens(d.promptTokens + d.completionTokens)} used={d.promptTokens + d.completionTokens} rows={tokenRows(d)} />
          )}
        </MessageHeader>
        <div className="flex flex-col gap-1 border-l border-border/60 pl-2">
          {wake && wake.watches.length > 0 && (
            <ChainOfThoughtStep icon={<Zap className="mt-0.5 size-3 shrink-0 text-[var(--ai-accent)]" />} label={wake.watches.map((w) => `Watch #${w.id} fired: ${w.label}`).join(' · ')} />
          )}
          {d && <Thought text={d.reasoning.join('\n\n')} ms={d.thinkMs} />}
          {d && <Steps steps={steps} />}
          {d && <PlanBox plan={d.plan} />}
          {(d?.recovered ?? []).length > 0 && (
            <p className="text-[10px] text-amber-700 dark:text-amber-400">Self-healed: {d!.recovered.join(' · ')}</p>
          )}
          {msg.partial && (
            <StackTrace
              title={msg.failureReason === 'Stopped by you.' ? 'Stopped by you' : 'This answer did not finish'}
              message={msg.failureReason ?? 'unknown reason'}
            />
          )}
          {wake?.outcome && wake.outcome !== 'ai' && <StackTrace title="Code wrote this note" message={msg.content.split('\n')[0]} />}
          {msg.content && (
            <div className="flex gap-1.5">
              <span className="mt-[0.6em] size-1.5 shrink-0 rounded-full bg-foreground/70" aria-hidden />
              <Markdown content={msg.content} className={BODY} />
            </div>
          )}
          {d?.question && (
            <Question
              title={d.question.text}
              disabled={!canAct || !isLatest}
              note={isLatest ? 'Tap one — it is sent as your reply.' : 'Answered or superseded by a later message.'}
              options={d.question.options.map((o) => ({ label: o, onSelect: () => onAnswer(o) }))}
            />
          )}
          {(d?.memories ?? []).length > 0 && (
            <p className="text-[10px] text-sky-700 dark:text-sky-400">Proposed something to remember — review it under Memory.</p>
          )}
          {steps.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <InlineCitation>
                <span className="text-[9px] text-muted-foreground">Read:</span>
                {steps.map((s, i) => (
                  <InlineCitationCard key={s.id} index={i + 1} title={s.title} detail={s.detail} ok={s.ok} />
                ))}
              </InlineCitation>
              <Sources>
                <SourcesTrigger count={sourcesOf(steps).length} />
                <SourcesContent>
                  {sourcesOf(steps).map((s) => (
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

function Row({
  msg,
  canAct,
  isLatest,
  onAct,
  onAnswer,
}: {
  msg: V2Message;
  canAct: boolean;
  isLatest: boolean;
  onAct: (id: number, d: 'confirm' | 'cancel') => void;
  onAnswer: (text: string) => void;
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
          <p className="whitespace-pre-wrap text-[11px]">{msg.content}</p>
          {(msg.images ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {msg.images!.map((name) => {
                const src = `/api/ai-analysis-v2/image?name=${encodeURIComponent(name)}`;
                return (
                  <a key={name} href={src} target="_blank" rel="noreferrer">
                    {/* Stored screenshot served by v2's own admin-only route. */}
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
  return <Answer msg={msg} canAct={canAct} isLatest={isLatest} onAnswer={onAnswer} />;
}

/** The answer being written right now, from the run's live events. */
function LiveAnswer({ live }: { live: LiveTurn }) {
  const running = [...live.steps].reverse().find((s) => s.running);
  const label = running ? running.title : live.text ? 'Writing' : live.reasoning ? 'Thinking' : live.steps.length ? 'Reading the results' : 'Thinking';
  return (
    <Message from="assistant">
      <MessageContent>
        <div className="flex flex-col gap-1 border-l border-border/60 pl-2">
          <Spinner label={label} startedAt={live.startedAt} />
          <Thought text={live.reasoning} ms={null} live />
          <Steps steps={live.steps} live />
          <PlanBox plan={live.plan} />
          {live.notes.map((n, i) => (
            <p key={i} className="text-[10px] text-amber-700 dark:text-amber-400">
              {n}
            </p>
          ))}
          {live.text && (
            <div className="flex gap-1.5">
              <span className="mt-[0.6em] size-1.5 shrink-0 rounded-full bg-foreground/70" aria-hidden />
              <Markdown content={live.text} className={BODY} />
            </div>
          )}
        </div>
      </MessageContent>
    </Message>
  );
}

export function Thread({
  items,
  live,
  canAct,
  onAct,
  onAnswer,
}: {
  items: ThreadItem[];
  live: LiveTurn | null;
  canAct: boolean;
  onAct: (id: number, d: 'confirm' | 'cancel') => void;
  onAnswer: (text: string) => void;
}) {
  const lastChatId = [...items].reverse().find((it) => it.kind === 'chat')?.msg.id;
  return (
    <Conversation contentKey={`${items.length}:${live ? live.steps.length + live.text.length + live.reasoning.length : -1}`}>
      <ConversationContent>
        {items.length === 0 && !live && (
          <ConversationEmptyState
            icon={<Bot className="size-5" />}
            title="Nothing in today's thread yet"
            description="Ask anything below, paste a screenshot, or say “tell me when …” to start a background watch."
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
                <MessageHeader icon={<LineChart className="size-3" />} name="Auto-trader read" time={hhmm(it.read.createdAt)}>
                  <span className="rounded bg-muted px-1">{it.read.model}</span>
                  <span>
                    {it.read.picksCount} pick{it.read.picksCount === 1 ? '' : 's'}
                  </span>
                </MessageHeader>
                <Markdown content={it.read.text} className={BODY} />
              </MessageContent>
            </Message>
          ) : (
            <Row
              key={`m-${it.msg.id}`}
              msg={it.msg}
              canAct={canAct}
              isLatest={it.msg.id === lastChatId && !live}
              onAct={onAct}
              onAnswer={onAnswer}
            />
          )
        )}
        {live && <LiveAnswer live={live} />}
      </ConversationContent>
    </Conversation>
  );
}
