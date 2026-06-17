'use client';

import { Compass, GraduationCap, LineChart, Plus, Send, Sparkles, TrendingUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { MessageBubble } from './_components/message-bubble';
import { useChat } from './_hooks/use-chat';

const SUGGESTIONS = [
  { icon: LineChart, label: 'Explain a trade', text: 'Explain the PNBHOUSING trade on 29 May 2026.' },
  { icon: TrendingUp, label: 'Strongest OI buildup', text: 'Which 5 verified trades had the strongest option OI buildup?' },
  { icon: GraduationCap, label: 'Define a term', text: 'In simple terms, what is oi_level and why does it matter?' },
  { icon: Compass, label: 'Direction check', text: 'For the ONGC trade on 9 March 2026, did the data agree with the trade direction?' },
];

// One shared column keeps the header, transcript, and composer in a single clean,
// centered lane (what makes ChatGPT/Claude feel uncluttered). Width is set via
// inline style — arbitrary Tailwind values (max-w-[..]) don't generate reliably here.
const COL = 'mx-auto w-full px-4';
const COL_W = { maxWidth: '46rem' } as const;

export default function TradeAssistantPage() {
  const { messages, loading, send, reset } = useChat();
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const submit = (text: string) => {
    const t = text.trim();
    if (!t || loading) return;
    send(t);
    setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';
  };

  const empty = messages.length === 0;

  return (
    <div className="flex flex-col" style={{ height: 'calc(100dvh - 6rem)' }}>
      {/* Header */}
      <header className="border-b border-border">
        <div className={`${COL} flex items-center gap-2.5 py-2.5`} style={COL_W}>
          <div className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/70 text-primary-foreground">
            <Sparkles className="size-3.5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-[13px] font-semibold leading-tight text-foreground">Trade Coach</h1>
            <p className="text-[11px] leading-tight text-muted-foreground">Grounded trade analysis</p>
          </div>
          <span className="ml-auto hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:flex">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            data-grounded
          </span>
          {!empty && (
            <Button variant="ghost" size="sm" onClick={reset} title="New chat">
              <Plus data-icon="inline-start" />
              <span className="hidden sm:inline">New</span>
            </Button>
          )}
        </div>
      </header>

      {/* Transcript */}
      <div className="flex-1 overflow-y-auto">
        <div className={`${COL} py-6`} style={COL_W}>
          {empty ? (
            <EmptyState onPick={submit} />
          ) : (
            <div className="flex flex-col gap-6">
              {messages.map((m, i) => (
                <MessageBubble key={i} msg={m} />
              ))}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-border bg-background">
        <div className={`${COL} py-3`} style={COL_W}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit(input);
            }}
          >
            <div className="flex items-end gap-2 rounded-2xl border border-border bg-card px-3 py-2 shadow-sm transition-colors focus-within:border-primary/50">
              <textarea
                ref={taRef}
                value={input}
                rows={1}
                placeholder="Ask about a trade, an OI buildup, or a term…"
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submit(input);
                  }
                }}
                className="max-h-40 flex-1 resize-none bg-transparent py-1.5 text-[13.5px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
              />
              <Button type="submit" size="icon" disabled={!input.trim() || loading} className="mb-0.5 rounded-full" aria-label="Send">
                <Send />
              </Button>
            </div>
            <p className="mt-1.5 text-center text-[10.5px] text-muted-foreground/70">
              Trade Coach only states numbers it looks up. Enter to send · Shift+Enter for a new line.
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center pt-10 text-center">
      <div className="ta-rise grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-primary to-primary/55 text-primary-foreground shadow-md">
        <Sparkles className="size-6" />
      </div>
      <h2 className="ta-rise mt-4 text-[19px] font-semibold tracking-tight text-foreground" style={{ animationDelay: '60ms' }}>
        Understand any trade, in plain English
      </h2>
      <p
        className="ta-rise mt-2 max-w-sm text-[13px] leading-relaxed text-muted-foreground"
        style={{ animationDelay: '110ms' }}
      >
        Ask about any TradeFinder trade — I&apos;ll break down the direction, the option-OI buildup, and what it means,
        citing the real numbers and defining each term.
      </p>

      <div className="ta-rise mt-7 grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2" style={{ animationDelay: '170ms' }}>
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => onPick(s.text)}
            className="group flex items-start gap-3 rounded-xl bg-card p-3 text-left ring-1 ring-foreground/10 transition-all hover:ring-primary/40 hover:shadow-sm"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
              <s.icon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-[12.5px] font-semibold text-foreground">{s.label}</span>
              <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-snug text-muted-foreground">{s.text}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
