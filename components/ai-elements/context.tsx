'use client';

/** AI Elements — Context: a usage meter (tokens of a reply, wake-ups of the day) with a detail popover. */

import { Gauge } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export function Context({
  label,
  used,
  max,
  rows,
}: {
  label: string;
  used: number;
  /** When set, a bar shows used / max. */
  max?: number;
  rows: { label: string; value: string }[];
}) {
  const pct = max ? Math.min(100, Math.round((used / max) * 100)) : null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Gauge className="size-3.5" />
          <span className="tabular-nums">{label}</span>
          {pct != null && (
            <span className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
              <span
                className={cn('block h-full rounded-full', pct >= 90 ? 'bg-red-500' : pct >= 60 ? 'bg-amber-500' : 'bg-emerald-500')}
                style={{ width: `${pct}%` }}
              />
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-2.5 text-xs">
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
          {rows.map((r) => (
            <div key={r.label} className="contents">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd className="text-right tabular-nums">{r.value}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}
