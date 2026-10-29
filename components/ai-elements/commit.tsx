'use client';

/** AI Elements — Trace (shadcn's name for commit.tsx): a timed run with its steps (here: one trader cycle). */

import { ChevronDown, GitCommitHorizontal } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Trace({ children }: { children: ReactNode }) {
  return <Collapsible.Root className="group/trace rounded-md border border-border/60 text-[10px]">{children}</Collapsible.Root>;
}

export function TraceHeader({ title, meta, bad }: { title: string; meta?: ReactNode; bad?: boolean }) {
  return (
    <Collapsible.Trigger className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-muted/40">
      <GitCommitHorizontal className={cn('size-3', bad ? 'text-red-600' : 'text-muted-foreground')} />
      <span className="font-medium tabular-nums">{title}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{meta}</span>
      <ChevronDown className="size-3 text-muted-foreground transition-transform group-data-[state=open]/trace:rotate-180" />
    </Collapsible.Trigger>
  );
}

export function TraceContent({ children }: { children: ReactNode }) {
  return <Collapsible.Content className="flex flex-col gap-1 border-t border-border/60 px-2 py-1.5">{children}</Collapsible.Content>;
}

export function TraceStep({
  name,
  ms,
  maxMs,
  ok,
  detail,
}: {
  name: string;
  ms: number;
  maxMs: number;
  ok: boolean;
  detail?: string;
}) {
  return (
    <div title={detail}>
      <div className="flex items-center gap-2">
        <span className={cn('min-w-0 flex-1 truncate', !ok && 'text-red-600 dark:text-red-400')}>{name}</span>
        <span className="tabular-nums text-muted-foreground">{ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}</span>
      </div>
      <div className="mt-0.5 h-1 rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full', ok ? 'bg-sky-500/70' : 'bg-red-500')}
          style={{ width: `${Math.max(2, Math.round((ms / Math.max(1, maxMs)) * 100))}%` }}
        />
      </div>
    </div>
  );
}
