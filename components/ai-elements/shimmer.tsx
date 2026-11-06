'use client';

/**
 * AI Elements — Shimmer: animated text for "working on it" states (keyframes in app/globals.css), and
 * Spinner: the cycling asterisk + live status line shown while the AI works. The status is always the
 * REAL current step (from the progress feed), never a made-up word.
 */

import { type ComponentProps, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

export function Shimmer({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('ai-shimmer font-medium', className)} {...props} />;
}

const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

/** `startedAt` (epoch ms) shows the elapsed seconds; the clock is read inside the timer, never during render. */
export function Spinner({ label, startedAt }: { label: string; startedAt?: number }) {
  const [i, setI] = useState(0);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  useEffect(() => {
    const t = setInterval(() => {
      setI((n) => (n + 1) % GLYPHS.length);
      if (startedAt != null) setElapsedMs(Date.now() - startedAt);
    }, 120);
    return () => clearInterval(t);
  }, [startedAt]);
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px]">
      <span className="w-3 text-center text-[12px] leading-none text-[var(--ai-accent)]" aria-hidden>
        {GLYPHS[i]}
      </span>
      <Shimmer>{label}…</Shimmer>
      {elapsedMs != null && <span className="tabular-nums text-muted-foreground">{Math.round(elapsedMs / 1000)}s</span>}
    </span>
  );
}
