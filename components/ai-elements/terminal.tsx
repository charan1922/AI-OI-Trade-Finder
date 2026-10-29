'use client';

/** AI Elements — Terminal: a live, auto-scrolling log tail. */

import { SquareTerminal } from 'lucide-react';
import { useEffect, useRef } from 'react';

export function Terminal({ title, lines, empty }: { title: string; lines: string[]; empty?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-950 text-zinc-100">
      <div className="flex items-center gap-1.5 border-b border-zinc-800 px-2 py-1 text-[10px] text-zinc-400">
        <SquareTerminal className="size-3" />
        {title}
      </div>
      <pre ref={ref} className="max-h-32 overflow-auto px-2 py-1.5 font-mono text-[9px] leading-relaxed">
        {lines.length ? lines.join('\n') : (empty ?? 'No output yet.')}
      </pre>
    </div>
  );
}
