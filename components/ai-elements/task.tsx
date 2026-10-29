'use client';

/** AI Elements — Task: one unit of background work (here: a watch), collapsible to its details. */

import { CheckCircle2, ChevronDown, CircleDashed, CircleSlash, Eye, Zap } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type TaskStatus = 'watching' | 'fired' | 'cancelled' | 'expired' | 'done';

const ICON: Record<TaskStatus, ReactNode> = {
  watching: <Eye className="size-3 text-sky-600 dark:text-sky-400" />,
  fired: <Zap className="size-3 text-amber-600" />,
  cancelled: <CircleSlash className="size-3 text-muted-foreground" />,
  expired: <CircleDashed className="size-3 text-muted-foreground" />,
  done: <CheckCircle2 className="size-3 text-emerald-600" />,
};

export function Task({ id, children, defaultOpen = false }: { id?: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <Collapsible.Root id={id} defaultOpen={defaultOpen} className="group/task rounded-md border border-border/60 text-[10px]">
      {children}
    </Collapsible.Root>
  );
}

export function TaskTrigger({ title, status, aside }: { title: string; status: TaskStatus; aside?: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1">
      <Collapsible.Trigger className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        {ICON[status]}
        <span className={cn('min-w-0 flex-1 truncate', status !== 'watching' && 'text-muted-foreground')}>{title}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/task:rotate-180" />
      </Collapsible.Trigger>
      {aside}
    </div>
  );
}

export function TaskContent({ children }: { children: ReactNode }) {
  return (
    <Collapsible.Content className="flex flex-col gap-1 border-t border-border/60 px-2 py-1.5 text-muted-foreground">
      {children}
    </Collapsible.Content>
  );
}

export function TaskItem({ children }: { children: ReactNode }) {
  return <div className="break-words">{children}</div>;
}
