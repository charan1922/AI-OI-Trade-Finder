'use client';

/** AI Elements — Stack Trace: a failure with its message and the frames / steps around it. */

import { ChevronDown, OctagonAlert } from 'lucide-react';
import { Collapsible } from 'radix-ui';

export function StackTrace({ title, message, frames }: { title: string; message: string; frames?: string[] }) {
  return (
    <Collapsible.Root className="group/stack rounded-md border border-red-300 bg-red-50/50 text-[10px] dark:border-red-500/40 dark:bg-red-500/5">
      <Collapsible.Trigger className="flex w-full items-start gap-1.5 px-2 py-1 text-left">
        <OctagonAlert className="mt-0.5 size-3 shrink-0 text-red-600" />
        <span className="min-w-0 flex-1">
          <span className="font-medium text-red-700 dark:text-red-400">{title}</span>
          <span className="block break-words text-muted-foreground">{message}</span>
        </span>
        {frames && frames.length > 0 && (
          <ChevronDown className="mt-0.5 size-3 text-muted-foreground transition-transform group-data-[state=open]/stack:rotate-180" />
        )}
      </Collapsible.Trigger>
      {frames && frames.length > 0 && (
        <Collapsible.Content>
          <pre className="overflow-x-auto border-t border-red-300/60 px-2 py-1.5 font-mono text-[9px] leading-relaxed dark:border-red-500/30">
            {frames.map((f, i) => `  at ${f}${i < frames.length - 1 ? '\n' : ''}`)}
          </pre>
        </Collapsible.Content>
      )}
    </Collapsible.Root>
  );
}
