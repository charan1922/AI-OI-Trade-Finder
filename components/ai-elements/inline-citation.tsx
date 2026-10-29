'use client';

/**
 * AI Elements — Inline Citation: numbered source chips with a hover card. The models don't emit citation
 * markers, so these sit at the END of a reply and point at the reads it actually made — never at text
 * the AI did not read.
 */

import { HoverCard } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function InlineCitation({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('inline-flex flex-wrap items-center gap-1', className)} {...props} />;
}

export function InlineCitationCard({
  index,
  title,
  detail,
  ok = true,
}: {
  index: number;
  title: string;
  detail?: string | null;
  ok?: boolean;
}) {
  return (
    <HoverCard.Root openDelay={100} closeDelay={50}>
      <HoverCard.Trigger asChild>
        <button
          type="button"
          className={cn(
            'rounded px-1 text-[10px] font-semibold tabular-nums',
            ok ? 'bg-muted text-muted-foreground hover:text-foreground' : 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400'
          )}
        >
          [{index}]
        </button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          sideOffset={4}
          className="z-50 w-72 rounded-lg border border-border bg-popover p-2.5 text-xs text-popover-foreground shadow-md"
        >
          <p className="font-medium">{title}</p>
          {detail && <p className="mt-1 text-muted-foreground">{detail}</p>}
          {!ok && <p className="mt-1 text-red-600 dark:text-red-400">This read failed.</p>}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
