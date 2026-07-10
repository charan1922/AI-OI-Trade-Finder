'use client';

import { Bot, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { Fragment, type ReactNode, useCallback, useEffect, useState } from 'react';

interface CommentaryRow {
  id: number;
  date: string;
  asOf: string;
  windowActive: boolean;
  picksCount: number;
  model: string;
  text: string;
  createdAt: string;
}

interface ApiResponse {
  success: boolean;
  configured?: boolean;
  model?: string;
  rows?: CommentaryRow[];
  error?: string;
}

const POLL_MS = 60_000;

function fmtTime(s: string): string {
  const iso = s.includes('T') ? s : `${s.replace(' ', 'T')}+05:30`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? s
    : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

// ── Lightweight markdown (no deps): **bold**, - bullets, # headings, --- rule.
function renderInline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  text.split(/(\*\*[^*]+\*\*)/g).forEach((seg, i) => {
    if (seg.startsWith('**') && seg.endsWith('**')) {
      out.push(
        <strong key={`${key}-b${i}`} className="font-semibold text-foreground">
          {seg.slice(2, -2)}
        </strong>,
      );
    } else if (seg) {
      out.push(<span key={`${key}-t${i}`}>{seg}</span>);
    }
  });
  return out;
}

function RichText({ content }: { content: string }) {
  return (
    <div className="space-y-1.5 text-[13.5px] leading-relaxed text-foreground/90">
      {content.split('\n').map((raw, i) => {
        const t = raw.trim();
        if (!t) return null;
        if (/^(---|___|\*\*\*)$/.test(t)) return <hr key={i} className="my-2 border-border/60" />;
        if (/^[-•*]\s+/.test(t)) {
          return (
            <div key={i} className="flex gap-2 pl-1">
              <span className="mt-[8px] h-1 w-1 shrink-0 rounded-full bg-primary/60" />
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

export default function TradeCommentaryPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/trade-commentary?limit=100', { cache: 'no-store' });
      setData((await res.json()) as ApiResponse);
    } catch (e) {
      setData({ success: false, error: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    const kick = setTimeout(() => {
      if (!stopped) void load();
    }, 0);
    const t = setInterval(() => {
      if (!stopped) void load();
    }, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(kick);
      clearInterval(t);
    };
  }, [load]);

  const generateNow = useCallback(async () => {
    setGenerating(true);
    setGenError(null);
    try {
      const res = await fetch('/api/trade-commentary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      const j = (await res.json()) as { success: boolean; generated?: boolean; reason?: string; error?: string };
      if (!j.success) setGenError(j.error ?? 'Generation failed');
      else if (!j.generated) setGenError(j.reason ?? 'Nothing to narrate right now');
      await load();
    } catch (e) {
      setGenError((e as Error).message);
    } finally {
      setGenerating(false);
    }
  }, [load]);

  // Group by day (newest day first); within a day oldest→newest so it reads as a
  // running conversation. The API returns newest-first.
  const rows = data?.rows ?? [];
  const byDay = new Map<string, CommentaryRow[]>();
  for (const r of rows) {
    const arr = byDay.get(r.date) ?? [];
    arr.push(r);
    byDay.set(r.date, arr);
  }
  const days = [...byDay.entries()].map(([date, list]) => ({
    date,
    turns: [...list].sort((a, b) => a.id - b.id),
  }));

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Bot className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-bold text-foreground">Trade Commentary</h1>
        <span
          className="rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-[11px] font-medium text-primary"
          title="This page is powered exclusively by Xiaomi MiMo — no OpenAI/Azure. The picks themselves are deterministic; MiMo only narrates them."
        >
          ⚡ Xiaomi MiMo · {data?.model ?? 'mimo-v2.5-pro'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={generateNow}
            disabled={generating || data?.configured === false}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Generate now
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md border px-2 py-1.5 text-muted-foreground hover:text-foreground"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        A running per-day narration of the deterministic scan picks — each read builds on the day’s earlier ones (what
        broke out, what held, what’s new), and each new day starts fresh. Generated in-process during market hours (per
        the /config window), so it fills even when the app isn’t open. Narration by <strong>Xiaomi MiMo</strong> (
        {data?.model ?? 'mimo-v2.5-pro'}); it only describes numbers the scanner computed and never places orders. Not
        financial advice.
      </p>

      {data?.configured === false && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          MiMo isn’t configured on this instance. Set <code>MIMO_API_KEY</code> and <code>MIMO_BASE_URL</code>.
        </div>
      )}
      {genError && <div className="rounded-md border border-muted bg-muted/40 p-2 text-xs text-muted-foreground">{genError}</div>}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : days.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No commentary yet. It generates automatically during market hours, or hit “Generate now”.
        </div>
      ) : (
        <div className="space-y-6">
          {days.map((day) => (
            <Fragment key={day.date}>
              <div className="sticky top-0 z-10 -mx-1 bg-background/80 px-1 py-1 text-xs font-semibold text-muted-foreground backdrop-blur">
                {day.date}
              </div>
              <div className="space-y-3">
                {day.turns.map((r) => (
                  <div key={r.id} className="flex gap-2.5">
                    <div className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/70 text-primary-foreground">
                      <Sparkles className="h-3 w-3" />
                    </div>
                    <div className="min-w-0 flex-1 rounded-lg border bg-card p-3 shadow-sm">
                      <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="font-medium text-foreground">{fmtTime(r.asOf)} IST</span>
                        {r.windowActive && (
                          <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
                            in window
                          </span>
                        )}
                        <span className="ml-auto">
                          {r.picksCount} pick{r.picksCount === 1 ? '' : 's'}
                        </span>
                      </div>
                      <RichText content={r.text} />
                    </div>
                  </div>
                ))}
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
