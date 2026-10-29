'use client';

/**
 * AI Elements — Tool: one tool call, in the timeline style — a status dot, the tool and what it asked
 * for, then "⎿ result". Expanding shows the full IN / OUT.
 */

import { Collapsible } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type ToolState = 'running' | 'ok' | 'error';

export function Tool({ children, defaultOpen = false }: { children: ReactNode; defaultOpen?: boolean }) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className="group/tool text-[10px]">
      {children}
    </Collapsible.Root>
  );
}

export function ToolDot({ state }: { state: ToolState }) {
  return (
    <span
      className={cn(
        'mt-[5px] size-1.5 shrink-0 rounded-full',
        state === 'ok' && 'bg-emerald-500',
        state === 'error' && 'bg-red-500',
        state === 'running' && 'animate-pulse bg-[var(--ai-accent)]'
      )}
    />
  );
}

export function ToolHeader({ name, state, input }: { name: string; state: ToolState; input?: string | null }) {
  return (
    <Collapsible.Trigger className="flex w-full items-start gap-1.5 text-left">
      <ToolDot state={state} />
      <span className="min-w-0 flex-1">
        <span className="font-semibold text-foreground">{name}</span>
        {input && <span className="ml-1 break-all font-mono text-[9px] text-muted-foreground">{input}</span>}
      </span>
    </Collapsible.Trigger>
  );
}

/** The always-visible "⎿ result" line under a tool. */
export function ToolSummary({ children, error }: { children: ReactNode; error?: boolean }) {
  return (
    <div className={cn('flex gap-1 pl-3 text-muted-foreground', error && 'text-red-600 dark:text-red-400')}>
      <span aria-hidden>⎿</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

export function ToolContent({ children }: { children: ReactNode }) {
  return <Collapsible.Content className="mt-0.5 pl-3">{children}</Collapsible.Content>;
}

export function ToolOutput({ output, errorText }: { output?: ReactNode; errorText?: string | null }) {
  return (
    <div className={cn('whitespace-pre-wrap break-words', errorText ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')}>
      {errorText ?? output ?? 'No summary recorded.'}
    </div>
  );
}
