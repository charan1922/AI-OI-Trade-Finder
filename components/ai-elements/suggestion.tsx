'use client';

/** AI Elements — Suggestion: tappable prompts above the composer. */

import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Suggestions({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)} {...props} />;
}

export function Suggestion({
  suggestion,
  onClick,
  disabled,
}: {
  suggestion: string;
  onClick: (s: string) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onClick(suggestion)}
      className="shrink-0 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
    >
      {suggestion}
    </button>
  );
}
