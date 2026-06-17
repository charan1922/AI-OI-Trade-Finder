'use client';

import { Check, ChevronRight, Database, X } from 'lucide-react';
import type { ToolTraceEntry } from '../_hooks/use-chat';

/**
 * Transparency panel: exactly which data tools the bot called for this answer.
 * Lets the user (and reviewers) confirm every claim is grounded in real lookups.
 * Native <details> — no extra dependency, fully keyboard-accessible.
 */
export function ToolTrace({ trace }: { trace: ToolTraceEntry[] }) {
  if (!trace || trace.length === 0) return null;
  return (
    <details className="group mt-2">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-[11px] text-muted-foreground/70 transition-colors hover:text-muted-foreground">
        <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
        <Database className="size-3" />
        Data sources ({trace.length})
      </summary>
      <div className="mt-1.5 flex flex-col gap-1 border-l border-border pl-3.5">
        {trace.map((t, i) => (
          <div key={`${i}:${t.name}`} className="flex items-start gap-1.5 font-mono text-[10.5px] text-muted-foreground">
            {t.ok ? (
              <Check className="mt-0.5 size-3 shrink-0 text-emerald-500" />
            ) : (
              <X className="mt-0.5 size-3 shrink-0 text-red-500" />
            )}
            <span className="min-w-0">
              <span className="text-foreground/80">{t.name}</span>
              <span className="text-muted-foreground/60">({fmtArgs(t.args)})</span> — {t.summary}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

function fmtArgs(args: Record<string, unknown>): string {
  const parts = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== '' && v !== false)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return parts.join(', ');
}
