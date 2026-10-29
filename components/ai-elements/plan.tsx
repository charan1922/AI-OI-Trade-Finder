'use client';

/** AI Elements — Plan: an ordered plan with done / now / next steps. */

import { CheckCircle2, Circle, CircleDot } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Plan({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="text-[10px]">
      <p className="font-semibold">{title}</p>
      {description && <p className="text-muted-foreground">{description}</p>}
      <ol className="mt-1 flex flex-col gap-0.5">{children}</ol>
    </div>
  );
}

export type PlanStepStatus = 'done' | 'now' | 'next';

export function PlanStep({
  status,
  time,
  title,
  detail,
}: {
  status: PlanStepStatus;
  time?: string;
  title: string;
  detail?: string;
}) {
  const Icon = status === 'done' ? CheckCircle2 : status === 'now' ? CircleDot : Circle;
  return (
    <li className={cn('flex gap-1.5', status === 'done' && 'text-muted-foreground')}>
      <Icon
        className={cn(
          'mt-0.5 size-3 shrink-0',
          status === 'done' && 'text-emerald-600',
          status === 'now' && 'text-sky-600 dark:text-sky-400',
          status === 'next' && 'text-muted-foreground'
        )}
      />
      {time && <span className="w-9 shrink-0 tabular-nums">{time}</span>}
      <span className="min-w-0 truncate">
        <span className={cn(status === 'now' && 'font-semibold')}>{title}</span>
        {detail && <span className="text-muted-foreground"> · {detail}</span>}
      </span>
    </li>
  );
}
