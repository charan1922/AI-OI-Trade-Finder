'use client';

/** AI Elements — Agent (shadcn "Subagent"): a background worker, its live status and what it is doing. */

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type AgentStatus = 'running' | 'idle' | 'waiting' | 'off' | 'error';

const DOT: Record<AgentStatus, string> = {
  running: 'bg-emerald-500 animate-pulse',
  idle: 'bg-emerald-500',
  waiting: 'bg-amber-500',
  off: 'bg-muted-foreground/50',
  error: 'bg-red-500',
};

export function Agent({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-md border border-border bg-card px-2 py-1.5 text-[10px]', className)}>{children}</div>;
}

export function AgentHeader({
  icon,
  name,
  status,
  statusLabel,
}: {
  icon?: ReactNode;
  name: string;
  status: AgentStatus;
  statusLabel: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {icon}
      <span className="font-semibold">{name}</span>
      <span className="ml-auto flex items-center gap-1 text-muted-foreground">
        <span className={cn('size-1.5 rounded-full', DOT[status])} />
        {statusLabel}
      </span>
    </div>
  );
}

export function AgentContent({ children }: { children: ReactNode }) {
  return <div className="mt-0.5 flex flex-col text-muted-foreground">{children}</div>;
}
