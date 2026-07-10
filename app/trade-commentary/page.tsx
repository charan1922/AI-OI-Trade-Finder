'use client';

import { Bot, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

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

/** IST time-of-day from an ISO/"date HH:MM:SS" string, best-effort. */
function fmtTime(s: string): string {
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + '+05:30';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? s
    : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

export default function TradeCommentaryPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/trade-commentary?limit=50', { cache: 'no-store' });
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

  const rows = data?.rows ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Bot className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-bold text-foreground">Trade Commentary</h1>
        {data?.model && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {data.model}
          </span>
        )}
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
        AI narration of the deterministic scan picks — generated in-process during market hours (per the /config window),
        so this fills even when the app isn’t open. The model only describes numbers the scanner computed; it never places
        orders. Not financial advice.
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
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No commentary yet. It generates automatically during market hours, or hit “Generate now”.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.id} className="rounded-lg border bg-card p-3 shadow-sm">
              <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">{r.date}</span>
                <span>· {fmtTime(r.asOf)} IST</span>
                {r.windowActive && (
                  <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
                    in window
                  </span>
                )}
                <span className="ml-auto">
                  {r.picksCount} pick{r.picksCount === 1 ? '' : 's'}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-sm text-foreground">{r.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
