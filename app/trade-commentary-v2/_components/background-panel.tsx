'use client';

import { BookMarked, Bot, Brain, Eye, Radar } from 'lucide-react';
import Link from 'next/link';
import { Switch } from 'radix-ui';
import type { ReactNode } from 'react';
import { Agent, AgentContent, AgentHeader, type AgentStatus } from '@/components/ai-elements/agent';
import { CodeBlock } from '@/components/ai-elements/code-block';
import { Trace, TraceContent, TraceHeader, TraceStep } from '@/components/ai-elements/commit';
import { FileTree, FileTreeFile, FileTreeFolder } from '@/components/ai-elements/file-tree';
import { Plan, PlanStep } from '@/components/ai-elements/plan';
import { Question } from '@/components/ai-elements/question';
import { Queue, QueueItem, QueueSection } from '@/components/ai-elements/queue';
import { StackTrace } from '@/components/ai-elements/stack-trace';
import { Task, TaskContent, TaskItem, TaskTrigger } from '@/components/ai-elements/task';
import { Terminal } from '@/components/ai-elements/terminal';
import { Test, TestResults, TestSuite } from '@/components/ai-elements/test-results';
import { Button } from '@/components/ui/button';
import { GATE_LABEL, GATE_ORDER } from '@/lib/tf-live/board-view';
import {
  type AutoTradeState,
  type BackgroundState,
  clockOf,
  type CycleTimeline,
  fmtMs,
  hhmm,
  istMinuteNow,
  type Milestone,
  planStatus,
  type RaceState,
} from '../_lib/v2-view';

function Section({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-2 border-b border-border/60 px-2 py-1.5">
      <h3 className="mb-1 flex items-center gap-2 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
        <span className="ml-auto normal-case tracking-normal">{aside}</span>
      </h3>
      {children}
    </section>
  );
}

const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

/** The auto-trader's four modes, as /auto-trade describes them (lib/auto-trade/settings.ts). */
const MODE_LABEL: Record<string, string> = {
  off: 'off — dormant',
  paper: 'paper — simulated fills',
  approval: 'approval — real orders, you approve each',
  live: 'live — real orders, autonomous',
};

/** The chat's action kinds, in risk order, with a caution on the two not recommended for auto. */
const ACTION_ROWS: { kind: string; label: string; caution?: string }[] = [
  { kind: 'exit', label: 'Exit a position' },
  { kind: 'move_stop', label: 'Tighten a stop' },
  { kind: 'reject', label: 'Reject a pending order' },
  { kind: 'run_pass', label: 'Run the trader now' },
  { kind: 'take_trade', label: 'Take a scanner pick' },
  { kind: 'approve', label: 'Approve a pending order', caution: 'Not recommended on auto: in approval mode your tap is the second key for a real order.' },
  { kind: 'setting', label: 'Change a trader setting', caution: 'Not recommended on auto: it can loosen risk limits (live mode stays blocked).' },
];

const LOOP_STATUS: Record<string, { status: AgentStatus; label: string }> = {
  checked: { status: 'running', label: 'watching' },
  idle: { status: 'idle', label: 'idle — no watches' },
  woke: { status: 'running', label: 'just woke the AI' },
  'waiting-for-trader': { status: 'waiting', label: 'waiting for the trader' },
  spacing: { status: 'waiting', label: 'spacing wake-ups' },
  off: { status: 'off', label: 'Background OFF' },
  'v1-selected': { status: 'off', label: 'paused — v1 selected' },
  'market-closed': { status: 'off', label: 'market closed' },
  'not-leader': { status: 'idle', label: 'another process leads' },
  'not-autonomous-server': { status: 'off', label: 'not on this server' },
  error: { status: 'error', label: 'error' },
};

export function BackgroundPanel({
  background,
  autoTrade,
  race,
  timelines,
  logLines,
  milestones,
  readOnly,
  onToggle,
  onCancelWatch,
  onDecide,
  onMemory,
  onAutoAction,
}: {
  background: BackgroundState | null;
  autoTrade: AutoTradeState | null;
  race: RaceState | null;
  timelines: CycleTimeline[];
  logLines: string[];
  milestones: Milestone[];
  readOnly: boolean;
  onToggle: (on: boolean) => void;
  onCancelWatch: (id: number) => void;
  onDecide: (tradeId: number, action: 'approve' | 'reject') => void;
  onMemory: (id: number, action: 'memory_save' | 'memory_discard' | 'memory_delete') => void;
  onAutoAction: (kind: string, auto: boolean) => void;
}) {
  const nowMin = istMinuteNow();
  const watches = background?.watches ?? [];
  const active = watches.filter((w) => w.status === 'watching');
  const covered = new Set((background?.wakeups ?? []).flatMap((w) => w.watchIds));
  const watchWakeups = (background?.wakeups ?? []).filter((w) => w.kind !== 'heartbeat');
  const checkIns = (background?.wakeups ?? []).filter((w) => w.kind === 'heartbeat');
  const waiting = watches.filter((w) => w.status === 'fired' && !covered.has(w.id));
  const watchLabel = new Map(watches.map((w) => [w.id, w.label]));
  const loopInfo = background?.loop.lastTick ? (LOOP_STATUS[background.loop.lastTick.status] ?? { status: 'idle' as const, label: background.loop.lastTick.status }) : null;
  const board = race?.board ?? [];
  const picked = board.filter((b) => b.tradeable).length;
  const unknownOnly = board.filter((b) => !b.tradeable && !Object.values(b.gates ?? {}).some((g) => g === false)).length;
  const recentCycles = timelines.slice(-6).reverse();
  const failedCycles = timelines.filter((t) => t.status != null && t.status !== 'completed').slice(-3).reverse();

  return (
    <div className="flex flex-col">
      <Section
        id="bg-switch"
        title="Background"
        aside={
          background && (
            <label className="flex items-center gap-1.5 text-[10px]">
              {background.enabled ? 'ON' : 'OFF'}
              <Switch.Root
                checked={background.enabled}
                disabled={readOnly}
                onCheckedChange={(v) => onToggle(v)}
                className="relative h-4 w-7 rounded-full bg-muted data-[state=checked]:bg-emerald-500 disabled:opacity-50"
                aria-label="Background watches"
              >
                <Switch.Thumb className="block size-3 translate-x-0.5 rounded-full bg-background shadow transition-transform data-[state=checked]:translate-x-3.5" />
              </Switch.Root>
            </label>
          )
        }
      >
        <p className="text-[10px] leading-snug text-muted-foreground">
          {background && !background.v2Selected
            ? 'Paused — v1 is the selected AI Analysis page in Settings (Assistant). Only one version runs at a time; select v2 there to run watches.'
            : background?.enabled
              ? 'ON — the AI checks in by itself (every 5–30 min, its choice) and posts only when something matters; watches are checked every 60s on the trading server (prices update every 5 min).'
              : 'OFF — no watches are checked and the AI only answers when you ask.'}
        </p>
        <div className="mt-1.5 grid gap-1.5">
          <Agent>
            <AgentHeader
              icon={<Bot className="size-3.5" />}
              name="Auto-trader"
              status={!autoTrade ? 'off' : autoTrade.settings.killSwitch ? 'error' : autoTrade.settings.mode === 'off' ? 'off' : 'idle'}
              statusLabel={!autoTrade ? 'no data' : autoTrade.settings.killSwitch ? 'kill switch ON' : MODE_LABEL[autoTrade.settings.mode] ?? autoTrade.settings.mode}
            />
            {autoTrade && (
              <AgentContent>
                <span>
                  Entries {autoTrade.today.entriesUsed}/{autoTrade.settings.maxTradesPerDay} · open lots {autoTrade.today.openLots} · realised ₹
                  {Math.round(autoTrade.today.realizedPnlRupees).toLocaleString('en-IN')}
                </span>
                <span>
                  Entry window {autoTrade.entryWindow.opensAt}–{autoTrade.entryWindow.closesAt} {autoTrade.entryWindow.active ? '(open now)' : ''}
                </span>
                <span>
                  Broker {autoTrade.settings.broker} · live key {autoTrade.liveEnvEnabled ? 'ON' : 'OFF'} on this server ·{' '}
                  <Link href="/auto-trade" className="underline underline-offset-2 hover:text-foreground">
                    change mode
                  </Link>
                </span>
              </AgentContent>
            )}
          </Agent>
          <Agent>
            <AgentHeader icon={<Radar className="size-3.5" />} name="Watcher" status={loopInfo?.status ?? 'off'} statusLabel={loopInfo?.label ?? 'no check yet'} />
            <AgentContent>
              <span>
                {active.length} active watch{active.length === 1 ? '' : 'es'} · wake-ups {background?.budget.used ?? 0}/{background?.limits.wakeCapPerDay ?? 20}
              </span>
              {background?.enabled && background.v2Selected && (
                <span>
                  Self-paced check-ins {background.heartbeat.today}/{background.heartbeat.max} today
                  {background.heartbeat.nextCheckAt && !background.heartbeat.due
                    ? ` · next ${hhmm(background.heartbeat.nextCheckAt)} (the AI chose it)`
                    : ' · next: due (from 09:20, when the trader is idle)'}
                </span>
              )}
              {background?.loop.lastTick && (
                <span>
                  Last check {hhmm(background.loop.lastTick.at)}
                  {background.loop.lastTick.detail ? ` — ${background.loop.lastTick.detail}` : ''}
                </span>
              )}
              {background && !background.loop.autonomous && <span>This server does not run autonomous jobs — watches are checked on the trading box only.</span>}
            </AgentContent>
          </Agent>
        </div>
      </Section>

      <Section id="bg-actions" title="Actions the AI may do by itself">
        <ul className="flex flex-col gap-1 text-[10px]">
          {ACTION_ROWS.map((r) => {
            const on = background?.autoActions?.[r.kind] === true;
            return (
              <li key={r.kind} className="flex items-start gap-2">
                <Switch.Root
                  checked={on}
                  disabled={readOnly || !background}
                  onCheckedChange={(v) => onAutoAction(r.kind, v)}
                  className="relative mt-0.5 h-3.5 w-6 shrink-0 rounded-full bg-muted data-[state=checked]:bg-emerald-500 disabled:opacity-50"
                  aria-label={`${r.label}: ${on ? 'auto' : 'ask first'}`}
                >
                  <Switch.Thumb className="block size-2.5 translate-x-0.5 rounded-full bg-background shadow transition-transform data-[state=checked]:translate-x-3" />
                </Switch.Root>
                <span className="min-w-0">
                  <span className="font-medium">{r.label}</span>
                  <span className="text-muted-foreground"> · {on ? 'auto' : 'asks first (Confirm card)'}</span>
                  {r.caution && <span className="block text-amber-700 dark:text-amber-400">{r.caution}</span>}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-1 text-[10px] text-muted-foreground">
          Auto actions run through the same gated code as a Confirm tap: every risk gate re-checks, stops only tighten, and the mode can never become live from chat.
        </p>
      </Section>

      <Section id="bg-plan" title="Today's plan">
        <Plan title="Session times from the server's settings" description="A time the server has not sent is left out.">
          {milestones.map((m, i) => (
            <PlanStep key={m.label} status={planStatus(m, milestones[i + 1], nowMin)} time={clockOf(m.minute)} title={m.label} detail={m.detail} />
          ))}
        </Plan>
      </Section>

      {(autoTrade?.pending.length ?? 0) > 0 && (
        <Section id="bg-questions" title="Waiting on you">
          <div className="flex flex-col gap-2">
            {autoTrade!.pending.map((p) => (
              <Question
                key={p.id}
                title={`Approve ${p.symbol} ${p.strike} ${p.optionType}?`}
                description={p.aiReasonEntry ?? undefined}
                disabled={readOnly}
                note="Approve re-checks every gate against a fresh quote."
                options={[
                  { label: 'Approve', variant: 'default', onSelect: () => onDecide(p.id, 'approve') },
                  { label: 'Reject', variant: 'outline', onSelect: () => onDecide(p.id, 'reject') },
                ]}
              />
            ))}
          </div>
        </Section>
      )}

      <Section id="bg-watches" title="Watches" aside={`${active.length} / ${background?.limits.maxActiveWatches ?? 10} active`}>
        {watches.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">No watches today. Ask in the chat: &ldquo;tell me when …&rdquo;.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {[...watches].reverse().map((w) => (
              <Task key={w.id} id={`watch-${w.id}`}>
                <TaskTrigger
                  title={`#${w.id} ${w.label}`}
                  status={w.status}
                  aside={
                    w.status === 'watching' && !readOnly ? (
                      <Button size="xs" variant="ghost" onClick={() => onCancelWatch(w.id)}>
                        Cancel
                      </Button>
                    ) : undefined
                  }
                />
                <TaskContent>
                  <TaskItem>
                    Started by {w.createdBy === 'ai' ? 'the AI' : 'you'} at {hhmm(w.createdAt)} · {w.cadence}
                  </TaskItem>
                  {w.lastCheckNote && (
                    <TaskItem>
                      Last check {w.lastCheckedAt ? hhmm(w.lastCheckedAt) : ''}: {w.lastCheckNote}
                    </TaskItem>
                  )}
                  {w.firedDetail && (
                    <TaskItem>
                      {w.status === 'fired' ? 'Fired' : 'Closed'} {w.firedAt ? `at ${hhmm(w.firedAt)}` : ''}: {w.firedDetail}
                    </TaskItem>
                  )}
                  <CodeBlock language="watch" code={JSON.stringify({ kind: w.kind, ...w.params }, null, 2)} />
                </TaskContent>
              </Task>
            ))}
          </div>
        )}
      </Section>

      <Section id="bg-wakeups" title="Wake-ups">
        <Queue>
          <QueueSection label="Waiting" count={waiting.length}>
            {waiting.map((w) => (
              <QueueItem key={w.id} status="pending" title={w.label} description="fired — AI wakes when the trader is idle and spacing allows" time={w.firedAt ? hhmm(w.firedAt) : undefined} />
            ))}
          </QueueSection>
          <QueueSection label="Watch wake-ups today" count={watchWakeups.length}>
            {[...watchWakeups].reverse().map((w) => (
              <QueueItem
                key={w.id}
                status={w.outcome === 'ai' ? 'done' : w.outcome === 'quiet' ? 'capped' : w.outcome}
                title={w.watchIds.map((id) => watchLabel.get(id) ?? `#${id}`).join(' · ')}
                description={w.outcome === 'ai' ? 'AI messaged you' : w.detail}
                time={hhmm(w.at)}
              />
            ))}
          </QueueSection>
          <QueueSection label="Self-paced check-ins today" count={checkIns.length}>
            {[...checkIns].reverse().slice(0, 12).map((w) => (
              <QueueItem
                key={w.id}
                status={w.outcome === 'ai' ? 'done' : w.outcome === 'quiet' ? 'capped' : 'fallback'}
                title={w.outcome === 'ai' ? 'Posted a message' : w.outcome === 'quiet' ? 'Quiet — nothing worth raising' : 'Check-in failed'}
                description={w.detail}
                time={hhmm(w.at)}
              />
            ))}
          </QueueSection>
        </Queue>
      </Section>

      <Section
        id="bg-memory"
        title="Memory (all days)"
        aside={`${(background?.memories ?? []).filter((m) => m.status === 'saved').length} saved`}
      >
        {(background?.memories ?? []).length === 0 ? (
          <p className="text-[10px] text-muted-foreground">
            Nothing yet. When you correct the AI or state a lasting preference it proposes one line here; it is used from then on only if you Save it.
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-[10px]">
            {(background?.memories ?? []).map((m) => (
              <li key={m.id} className="flex items-start gap-1.5">
                <Brain className={m.status === 'pending' ? 'mt-0.5 size-3 shrink-0 text-[var(--ai-accent)]' : 'mt-0.5 size-3 shrink-0 text-muted-foreground'} />
                <span className="min-w-0 flex-1">
                  <span className="text-muted-foreground">[{m.kind}]</span> {m.text}
                  {m.status === 'pending' && <span className="ml-1 text-[var(--ai-accent)]">· waiting for you</span>}
                </span>
                {!readOnly &&
                  (m.status === 'pending' ? (
                    <span className="flex shrink-0 gap-0.5">
                      <Button size="xs" onClick={() => onMemory(m.id, 'memory_save')}>
                        Save
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => onMemory(m.id, 'memory_discard')}>
                        Discard
                      </Button>
                    </span>
                  ) : (
                    <Button size="xs" variant="ghost" onClick={() => onMemory(m.id, 'memory_delete')}>
                      Delete
                    </Button>
                  ))}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="bg-notebook" title="AI notebook">
        {(background?.notes.length ?? 0) === 0 ? (
          <p className="text-[10px] text-muted-foreground">Empty — the AI writes one line after each turn while Background is ON.</p>
        ) : (
          <ol className="flex flex-col gap-0.5 text-[10px]">
            {background!.notes.map((n) => (
              <li key={n.id} id={`note-${n.id}`} className="flex gap-2">
                <span className="shrink-0 tabular-nums text-muted-foreground">{hhmm(n.at)}</span>
                <span>{n.text}</span>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section id="bg-workspace" title="Workspace">
        <FileTree>
          <FileTreeFolder name="watches" count={watches.length} defaultOpen={false}>
            {watches.map((w) => (
              <FileTreeFile key={w.id} name={`#${w.id} ${w.label}`} badge={<Eye className="size-3 text-muted-foreground" />} onSelect={() => jump(`watch-${w.id}`)} />
            ))}
          </FileTreeFolder>
          <FileTreeFolder name="notebook" count={background?.notes.length ?? 0} defaultOpen={false}>
            {(background?.notes ?? []).map((n) => (
              <FileTreeFile key={n.id} name={`${hhmm(n.at)} ${n.text}`} onSelect={() => jump(`note-${n.id}`)} />
            ))}
          </FileTreeFolder>
          <FileTreeFolder name="wake-ups" count={background?.wakeups.length ?? 0} defaultOpen={false}>
            {(background?.wakeups ?? []).map((w) => (
              <FileTreeFile key={w.id} name={`${hhmm(w.at)} ${w.outcome}`} onSelect={() => jump('bg-wakeups')} />
            ))}
          </FileTreeFolder>
          <FileTreeFolder name="skills" count={background?.skills.length ?? 0} defaultOpen={false}>
            {(background?.skills ?? []).map((s) => (
              <FileTreeFile key={s} name={s} badge={<BookMarked className="size-3 text-muted-foreground" />} />
            ))}
          </FileTreeFolder>
          <FileTreeFile name="selector checks" onSelect={() => jump('bg-checks')} />
          <FileTreeFile name="trader cycles" onSelect={() => jump('bg-cycles')} />
          <FileTreeFile name="memory" onSelect={() => jump('bg-memory')} />
          {logLines.length > 0 && <FileTreeFile name="server log" onSelect={() => jump('bg-log')} />}
        </FileTree>
      </Section>

      <Section
        id="bg-checks"
        title="Selector checks (TF)"
        aside={race?.boardMinuteIST != null ? `board ${clockOf(race.boardMinuteIST)}${race.stale ? ' · stale' : ''}` : undefined}
      >
        {board.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">{race?.verdictNote ?? 'No TF board yet today.'}</p>
        ) : (
          <TestResults passed={picked} failed={board.length - picked - unknownOnly} skipped={unknownOnly}>
            {board.map((b) => {
              const anyFail = Object.values(b.gates ?? {}).some((g) => g === false);
              return (
                <TestSuite
                  key={b.symbol}
                  name={`#${b.rankNow} ${b.symbol} ${b.side}`}
                  status={b.tradeable ? 'passed' : anyFail ? 'failed' : 'skipped'}
                  aside={b.tradeable ? 'picked' : (b.blockedBy ?? (b.needs ? `needs ${b.needs}` : ''))}
                >
                  {GATE_ORDER.map((k) => {
                    const g = b.gates?.[k];
                    return <Test key={k} name={GATE_LABEL[k]} status={g === true ? 'passed' : g === false ? 'failed' : 'skipped'} />;
                  })}
                </TestSuite>
              );
            })}
          </TestResults>
        )}
      </Section>

      <Section id="bg-cycles" title="Trader cycles">
        <div className="flex flex-col gap-1.5">
          {failedCycles.map((t) => (
            <StackTrace
              key={`f${t.id}`}
              title={`Cycle ${hhmm(t.startedAt)} — ${t.status}`}
              message={t.steps.find((s) => !s.ok)?.detail ?? 'a step failed'}
              frames={t.steps.map((s) => `${s.name} (${fmtMs(s.ms)}${s.ok ? '' : ', FAILED'})`)}
            />
          ))}
          {recentCycles.length === 0 && <p className="text-[10px] text-muted-foreground">No cycles recorded yet.</p>}
          {recentCycles.map((t) => {
            const maxMs = Math.max(1, ...t.steps.map((s) => s.ms));
            const total = t.totalMs ?? t.steps.reduce((a, s) => a + s.ms, 0);
            return (
              <Trace key={t.id}>
                <TraceHeader title={hhmm(t.startedAt)} meta={`${fmtMs(total)} · ${t.steps.length} steps${t.status && t.status !== 'completed' ? ` · ${t.status}` : ''}`} bad={t.status != null && t.status !== 'completed'} />
                <TraceContent>
                  {t.steps.map((s, i) => (
                    <TraceStep key={`${s.name}-${i}`} name={s.name} ms={s.ms} maxMs={maxMs} ok={s.ok} detail={s.detail} />
                  ))}
                </TraceContent>
              </Trace>
            );
          })}
        </div>
      </Section>

      {/* Shown only when there is something to show — an empty log box is noise. */}
      {logLines.length > 0 && (
        <Section id="bg-log" title="Server log">
          <Terminal title="[chat-watch] · [operator-chat] · [auto-trade]" lines={logLines} />
        </Section>
      )}
    </div>
  );
}
