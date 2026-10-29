'use client';

/** AI Elements — Chain of Thought: the steps of one turn as a dot timeline (what woke it → reads → reply). */

import { ChevronRight } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function ChainOfThought({ children, defaultOpen = false }: { children: ReactNode; defaultOpen?: boolean }) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className="group/cot text-[10px]">
      {children}
    </Collapsible.Root>
  );
}

export function ChainOfThoughtHeader({ children }: { children: ReactNode }) {
  return (
    <Collapsible.Trigger className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
      <ChevronRight className="size-3 transition-transform group-data-[state=open]/cot:rotate-90" />
      <span>{children}</span>
    </Collapsible.Trigger>
  );
}

export function ChainOfThoughtContent({ children }: { children: ReactNode }) {
  return (
    <Collapsible.Content>
      <ol className="mt-1 flex flex-col gap-1 border-l border-border/70 pl-2">{children}</ol>
    </Collapsible.Content>
  );
}

export type StepStatus = 'complete' | 'active' | 'pending' | 'failed';

export function ChainOfThoughtStep({
  label,
  description,
  status = 'complete',
  icon,
}: {
  label: ReactNode;
  description?: ReactNode;
  status?: StepStatus;
  icon?: ReactNode;
}) {
  return (
    <li className="flex gap-1.5">
      {icon ?? (
        <span
          className={cn(
            'mt-[5px] size-1.5 shrink-0 rounded-full',
            status === 'complete' && 'bg-emerald-500',
            status === 'active' && 'animate-pulse bg-[var(--ai-accent)]',
            status === 'failed' && 'bg-red-500',
            status === 'pending' && 'bg-muted-foreground/40'
          )}
        />
      )}
      <span className="min-w-0">
        <span className="text-foreground">{label}</span>
        {description && (
          <span className="flex gap-1 text-muted-foreground">
            <span aria-hidden>⎿</span>
            <span className="min-w-0 break-words">{description}</span>
          </span>
        )}
      </span>
    </li>
  );
}
