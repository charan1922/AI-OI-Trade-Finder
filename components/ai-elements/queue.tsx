'use client';

/** AI Elements — Queue: work waiting and done (here: the day's wake-ups). */

import { CheckCircle2, Clock, OctagonAlert, Zap } from 'lucide-react';
import type { ReactNode } from 'react';

export function Queue({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2 text-[10px]">{children}</div>;
}

export function QueueSection({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-0.5 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label} <span className="rounded bg-muted px-1 tabular-nums">{count}</span>
      </h4>
      <ul className="flex flex-col gap-1">{children}</ul>
    </section>
  );
}

export type QueueItemStatus = 'pending' | 'done' | 'fallback' | 'capped';

export function QueueItem({
  status,
  title,
  description,
  time,
}: {
  status: QueueItemStatus;
  title: string;
  description?: string | null;
  time?: string;
}) {
  const icon =
    status === 'pending' ? (
      <Clock className="size-3 text-amber-600" />
    ) : status === 'done' ? (
      <CheckCircle2 className="size-3 text-emerald-600" />
    ) : status === 'capped' ? (
      <Zap className="size-3 text-muted-foreground" />
    ) : (
      <OctagonAlert className="size-3 text-red-600" />
    );
  return (
    <li className="flex gap-1.5">
      <span className="mt-0.5">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        {description && <span className="block text-muted-foreground">{description}</span>}
      </span>
      {time && <span className="shrink-0 tabular-nums text-muted-foreground">{time}</span>}
    </li>
  );
}
