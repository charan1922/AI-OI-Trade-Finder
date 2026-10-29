'use client';

/**
 * AI Elements — Reasoning: the collapsed "Thought for Xs" row. Expanded, it shows the model's OWN
 * reasoning text when the run had thinking on (MiMo returns it as reasoning_content), else where the time
 * went. It never invents a thought.
 */

import { ChevronRight } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Reasoning({ children, defaultOpen = false }: { children: ReactNode; defaultOpen?: boolean }) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen} className="group/reasoning text-[10px]">
      {children}
    </Collapsible.Root>
  );
}

export function ReasoningTrigger({ seconds, label }: { seconds: number; label?: string }) {
  return (
    <Collapsible.Trigger className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
      <ChevronRight className="size-3 transition-transform group-data-[state=open]/reasoning:rotate-90" />
      <span className="italic">{label ?? `Thought for ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`}</span>
    </Collapsible.Trigger>
  );
}

export function ReasoningContent({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <Collapsible.Content className={cn('mt-1 border-l border-border/70 pl-2 italic text-muted-foreground', className)}>
      {children}
    </Collapsible.Content>
  );
}
