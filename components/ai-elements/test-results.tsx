'use client';

/** AI Elements — Test Results: pass / fail per check (here: the TF selector's checks per stock, live). */

import { CheckCircle2, ChevronDown, CircleHelp, XCircle } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function TestResults({
  passed,
  failed,
  skipped,
  children,
}: {
  passed: number;
  failed: number;
  skipped: number;
  children: ReactNode;
}) {
  return (
    <div className="text-[10px]">
      <div className="mb-1.5 flex gap-2 tabular-nums">
        <span className="text-emerald-700 dark:text-emerald-400">{passed} picked</span>
        <span className="text-red-700 dark:text-red-400">{failed} rejected</span>
        {skipped > 0 && <span className="text-muted-foreground">{skipped} unknown</span>}
      </div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

export type TestStatus = 'passed' | 'failed' | 'skipped';

const ICON: Record<TestStatus, ReactNode> = {
  passed: <CheckCircle2 className="size-3 text-emerald-600" />,
  failed: <XCircle className="size-3 text-red-600" />,
  skipped: <CircleHelp className="size-3 text-muted-foreground" />,
};

export function TestSuite({ name, status, aside, children }: { name: string; status: TestStatus; aside?: ReactNode; children?: ReactNode }) {
  return (
    <Collapsible.Root className="group/suite rounded-md border border-border/60">
      <Collapsible.Trigger className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-muted/40">
        {ICON[status]}
        <span className="font-medium">{name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{aside}</span>
        {children && <ChevronDown className="size-3 text-muted-foreground transition-transform group-data-[state=open]/suite:rotate-180" />}
      </Collapsible.Trigger>
      {children && <Collapsible.Content className="flex flex-col gap-0.5 border-t border-border/60 px-2 py-1">{children}</Collapsible.Content>}
    </Collapsible.Root>
  );
}

export function Test({ name, status, error }: { name: string; status: TestStatus; error?: string | null }) {
  return (
    <div className="flex items-start gap-1.5">
      <span className="mt-0.5">{ICON[status]}</span>
      <span className={cn('min-w-0', status === 'failed' && 'text-red-700 dark:text-red-400')}>
        {name}
        {error && <span className="block text-muted-foreground">{error}</span>}
      </span>
    </div>
  );
}
