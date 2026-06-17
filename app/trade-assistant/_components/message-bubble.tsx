'use client';

import { Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ChatMsg } from '../_hooks/use-chat';
import { SupportingData } from './supporting-data';
import { ToolTrace } from './tool-trace';

/** Inline: **bold**, and (parenthetical glosses) shown muted+italic so beginners
 *  can spot the plain-language explanations. */
function renderInline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  text.split(/(\*\*[^*]+\*\*)/g).forEach((bold, bi) => {
    if (bold.startsWith('**') && bold.endsWith('**')) {
      out.push(
        <strong key={`${key}-b${bi}`} className="font-semibold text-foreground">
          {bold.slice(2, -2)}
        </strong>,
      );
      return;
    }
    bold.split(/(\([^)]*\))/g).forEach((seg, si) => {
      if (!seg) return;
      if (seg.startsWith('(') && seg.endsWith(')')) {
        out.push(
          <span key={`${key}-b${bi}p${si}`} className="text-muted-foreground/80 italic">
            {seg}
          </span>,
        );
      } else {
        out.push(<span key={`${key}-b${bi}t${si}`}>{seg}</span>);
      }
    });
  });
  return out;
}

/** Lightweight markdown: paragraphs, • bullets, #/## headings — no deps. */
function RichText({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <div className="space-y-2 text-[14px] leading-relaxed text-foreground/90">
      {lines.map((raw, i) => {
        const t = raw.trim();
        if (!t) return null;
        if (/^[-•*]\s+/.test(t)) {
          return (
            <div key={i} className="flex gap-2.5 pl-1">
              <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-primary/60" />
              <span>{renderInline(t.replace(/^[-•*]\s+/, ''), `l${i}`)}</span>
            </div>
          );
        }
        if (/^#{1,4}\s+/.test(t)) {
          return (
            <div key={i} className="pt-1 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
              {renderInline(t.replace(/^#{1,4}\s+/, ''), `h${i}`)}
            </div>
          );
        }
        return <p key={i}>{renderInline(t, `p${i}`)}</p>;
      })}
    </div>
  );
}

export function MessageBubble({ msg }: { msg: ChatMsg }) {
  // User — a soft right-aligned bubble (clean, like ChatGPT/Claude).
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end ta-rise">
        <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-[14px] leading-relaxed text-foreground">
          {msg.content}
        </div>
      </div>
    );
  }

  // Assistant — avatar + plain text block (no boxy border), the Claude look.
  return (
    <div className="flex gap-3 ta-rise">
      <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/70 text-primary-foreground">
        <Sparkles className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        {msg.pending ? (
          <div className="flex items-center gap-1.5 pt-1.5">
            {[0, 1, 2].map((d) => (
              <span
                key={d}
                className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 ta-blink"
                style={{ animationDelay: `${d * 160}ms` }}
              />
            ))}
          </div>
        ) : msg.isError ? (
          <div className="rounded-xl border border-red-400/50 bg-red-500/5 px-3.5 py-2.5">
            <RichText content={msg.content} />
          </div>
        ) : (
          <RichText content={msg.content} />
        )}
        {msg.toolTrace && msg.toolTrace.length > 0 && (
          <>
            <SupportingData trace={msg.toolTrace} />
            <ToolTrace trace={msg.toolTrace} />
          </>
        )}
      </div>
    </div>
  );
}
