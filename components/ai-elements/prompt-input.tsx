'use client';

/** AI Elements — Prompt Input: the composer. Enter sends, Shift+Enter adds a line. */

import { ArrowUp, Loader2 } from 'lucide-react';
import type { ComponentProps, FormEvent, KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function PromptInput({
  className,
  onSubmit,
  ...props
}: Omit<ComponentProps<'form'>, 'onSubmit'> & { onSubmit: () => void }) {
  return (
    <form
      className={cn('flex flex-col gap-1 rounded-lg border border-border bg-background p-1.5 shadow-sm', className)}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
      }}
      {...props}
    />
  );
}

export function PromptInputTextarea({
  className,
  onSubmitKey,
  ...props
}: ComponentProps<'textarea'> & { onSubmitKey: () => void }) {
  return (
    <textarea
      rows={1}
      className={cn(
        'max-h-32 min-h-8 w-full resize-none bg-transparent px-1.5 py-1 text-xs outline-none placeholder:text-muted-foreground',
        className
      )}
      onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onSubmitKey();
        }
      }}
      {...props}
    />
  );
}

export function PromptInputToolbar({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex items-center justify-between gap-2', className)} {...props} />;
}

export function PromptInputTools({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex min-w-0 flex-wrap items-center gap-1', className)} {...props} />;
}

export function PromptInputSubmit({ busy, disabled }: { busy?: boolean; disabled?: boolean }) {
  return (
    <Button type="submit" size="icon-xs" className="rounded-full" disabled={disabled} aria-label="Send">
      {busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}
    </Button>
  );
}
