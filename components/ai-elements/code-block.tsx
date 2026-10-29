'use client';

/** AI Elements — Code Block: monospace text with a copy button (no syntax highlighter dependency). */

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative rounded-md border border-border bg-muted/40">
      {language && <span className="absolute left-2 top-1 text-[9px] uppercase text-muted-foreground">{language}</span>}
      <button
        type="button"
        aria-label="Copy"
        className="absolute right-1.5 top-1 text-muted-foreground hover:text-foreground"
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
      <pre className="overflow-x-auto px-2 pb-1.5 pt-4 font-mono text-[9px] leading-relaxed">{code}</pre>
    </div>
  );
}
