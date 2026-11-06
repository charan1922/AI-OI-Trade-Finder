'use client';

import { Radar, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PageHeaderPortal } from '@/components/page-header-portal';
import { useRole } from '@/lib/auth/use-role';
import { cn } from '@/lib/utils';
import { BackgroundPanel } from './_components/background-panel';
import { Composer } from './_components/composer';
import { Thread } from './_components/thread';
import { useV2Data } from './_hooks/use-v2-data';
import { buildThread, dayLabel, istToday, sessionMilestones } from './_lib/v2-view';

/**
 * /ai-analysis-v2 — AI Analysis v2: a standalone LangGraph agent (lib/ai-analysis-v2/graph.ts) with its own thread,
 * streamed thinking / steps / answer, skills, watches and self-paced check-ins. Independent of v1 (/trade-commentary).
 * Admin-only page. Spec: docs/superpowers/specs/2026-11-06-ai-analysis-v2-langgraph-design.md.
 */
export default function AiAnalysisV2Page() {
  const { readOnly } = useRole();
  const data = useV2Data();
  const milestones = useMemo(
    () => sessionMilestones(data.background?.session, data.autoTrade?.entryWindow),
    [data.background?.session, data.autoTrade?.entryWindow]
  );
  const items = useMemo(() => buildThread(data.reads, data.messages, milestones), [data.reads, data.messages, milestones]);
  // Phones get one pane at a time (Chat | Background); lg+ shows both side by side.
  const [pane, setPane] = useState<'chat' | 'background'>('chat');
  const activeWatches = (data.background?.watches ?? []).filter((w) => w.status === 'watching').length;
  const tokensToday = useMemo(() => {
    const answers = data.messages.filter((m) => m.role === 'assistant' && m.details);
    return {
      prompt: answers.reduce((a, m) => a + (m.details?.promptTokens ?? 0), 0),
      reply: answers.reduce((a, m) => a + (m.details?.completionTokens ?? 0), 0),
      replies: answers.length,
    };
  }, [data.messages]);

  return (
    <>
      <PageHeaderPortal>
        <Radar className="size-3.5 shrink-0 text-[var(--ai-accent)]" />
        <h1 className="hidden truncate text-sm font-semibold sm:block">AI Analysis v2</h1>
        {/* The thread, watches, notebook and check-ins are per IST day — a new thread starts each morning. */}
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground" title="The thread starts fresh each IST day">
          Today · {dayLabel(istToday())}
        </span>
        {!data.configured && <span className="hidden truncate text-[11px] text-amber-600 md:inline">MiMo not configured on this server</span>}
      </PageHeaderPortal>
      <div className="-m-1 flex h-[calc(100dvh-4.5rem)] flex-col overflow-hidden rounded-lg border border-border bg-background sm:-m-3">
        {data.notice && (
          <div className="flex items-start gap-2 border-b border-border bg-muted/40 px-3 py-1 text-[11px]">
            <span className="flex-1">{data.notice}</span>
            <button type="button" onClick={data.dismissNotice} aria-label="Dismiss">
              <X className="size-3.5" />
            </button>
          </div>
        )}
        <div className="flex border-b border-border text-[11px] font-medium lg:hidden" role="tablist">
          {(['chat', 'background'] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={pane === p}
              onClick={() => setPane(p)}
              className={cn('flex-1 py-1.5', pane === p ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground')}
            >
              {p === 'chat' ? 'Chat' : `Background${data.background?.enabled ? ` · ${activeWatches} watching` : ' · off'}`}
            </button>
          ))}
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className={cn('min-h-0 flex-col', pane === 'chat' ? 'flex' : 'hidden', 'lg:flex')}>
            <Thread
              items={items}
              live={data.live}
              canAct={!readOnly}
              onAct={(id, d) => void data.act(id, d)}
              onAnswer={(text) => void data.send(text)}
            />
            {!readOnly && (
              <Composer
                autoTrade={data.autoTrade}
                background={data.background}
                race={data.race}
                pending={data.pending}
                readOnly={readOnly}
                tokensToday={tokensToday}
                onSend={data.send}
                onModel={(m) => void data.setModel(m)}
                onError={data.showNotice}
                onStop={() => void data.stop()}
              />
            )}
          </div>
          <aside className={cn('min-h-0 overflow-y-auto lg:block lg:border-l lg:border-border', pane === 'background' ? 'block' : 'hidden')}>
            <BackgroundPanel
              background={data.background}
              autoTrade={data.autoTrade}
              race={data.race}
              timelines={data.timelines}
              logLines={data.logLines}
              milestones={milestones}
              readOnly={readOnly}
              onToggle={(on) => void data.setBackgroundOn(on)}
              onCancelWatch={(id) => void data.cancelWatch(id)}
              onDecide={(id, a) => void data.decideApproval(id, a)}
              onMemory={(id, a) => void data.decideMemory(id, a)}
              onAutoAction={(kind, auto) => void data.setAutoAction(kind, auto)}
            />
          </aside>
        </div>
      </div>
    </>
  );
}
