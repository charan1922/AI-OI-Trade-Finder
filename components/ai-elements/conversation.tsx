'use client';

/**
 * AI Elements — Conversation (shadcn "Chat"). A scrolling thread that sticks to the bottom while new
 * messages arrive, unless the reader has scrolled up — then a "jump to latest" button appears.
 * Hand-written on what this repo already has (no use-stick-to-bottom).
 */

import { ArrowDown } from 'lucide-react';
import { type ComponentProps, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const NEAR_BOTTOM_PX = 80;

export function Conversation({
  className,
  children,
  /** Changes whenever the content grows (e.g. message count) — triggers the stick-to-bottom. */
  contentKey,
  ...props
}: ComponentProps<'div'> & { contentKey?: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  useEffect(() => {
    if (atBottomRef.current) scrollToBottom(false);
  }, [contentKey, scrollToBottom]);

  return (
    <div className={cn('relative min-h-0 flex-1', className)} {...props}>
      <div
        ref={ref}
        role="log"
        className="h-full overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
          atBottomRef.current = near;
          setAtBottom(near);
        }}
      >
        {children}
      </div>
      {!atBottom && (
        <Button
          size="icon-sm"
          variant="outline"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow"
          onClick={() => scrollToBottom()}
          aria-label="Jump to latest"
        >
          <ArrowDown />
        </Button>
      )}
    </div>
  );
}

export function ConversationContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 p-2.5', className)} {...props} />;
}

export function ConversationEmptyState({
  title,
  description,
  icon,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
      {icon}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && <p className="max-w-sm text-xs">{description}</p>}
    </div>
  );
}
