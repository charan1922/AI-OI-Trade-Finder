'use client';

/** AI Elements — Message: one row of the thread (operator, AI, or the trader's read). */

import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type MessageFrom = 'user' | 'assistant' | 'system';

export function Message({ from, className, ...props }: ComponentProps<'div'> & { from: MessageFrom }) {
  return (
    <div
      data-from={from}
      className={cn('group flex w-full', from === 'user' ? 'justify-end' : 'justify-start', className)}
      {...props}
    />
  );
}

export function MessageContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex max-w-[94%] flex-col gap-1 rounded-lg px-2.5 py-1.5 text-xs sm:max-w-[85%]',
        'group-data-[from=user]:border group-data-[from=user]:border-border group-data-[from=user]:bg-muted/60',
        'group-data-[from=assistant]:w-full group-data-[from=assistant]:max-w-full group-data-[from=assistant]:px-1',
        'group-data-[from=system]:w-full group-data-[from=system]:max-w-full group-data-[from=system]:border group-data-[from=system]:border-dashed group-data-[from=system]:bg-muted/30',
        className
      )}
      {...props}
    />
  );
}

export function MessageHeader({
  icon,
  name,
  time,
  children,
}: {
  icon?: ReactNode;
  name: string;
  time?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
      {icon}
      <span className="font-semibold">{name}</span>
      {time && <span>{time} IST</span>}
      {children}
    </div>
  );
}
