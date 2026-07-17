'use client';

import { Bot, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { RichText } from '@/components/rich-text';
import { useRole } from '@/lib/auth/use-role';

type ChipTone = 'good' | 'warn' | 'info';
interface Chip {
  label: string;
  value: string;
  tone: ChipTone;
}
interface StoredPick {
  symbol: string;
  side: string;
  strike: number | null;
  expiry: string | null;
  lot: number | null;
  direction: 'bullish' | 'bearish';
  score: number;
  changePctOpen: number | null;
  extended: boolean;
  entrySpot: number | null;
  slSpot: number | null;
  targetSpot: number | null;
  slBasis: string;
  premium: number | null;
  perLotCost: number | null;
  chips: Chip[];
}
interface CommentaryRow {
  id: number;
  date: string;
  asOf: string;
  windowActive: boolean;
  picksCount: number;
  model: string;
  text: string;
  picks: StoredPick[];
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

// ── The app's pill (matches /trade-suggest), compact ─────────────────────────
function Pill({ label, value, tone }: Chip) {
  const toneCls =
    tone === 'good'
      ? 'border-emerald-500/60 bg-emerald-100 text-emerald-800 dark:border-emerald-500/50 dark:bg-emerald-500/25 dark:text-emerald-200'
      : tone === 'warn'
        ? 'border-amber-500/60 bg-amber-100 text-amber-800 dark:border-amber-500/50 dark:bg-amber-500/25 dark:text-amber-200'
        : 'border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-600 dark:bg-slate-700/60 dark:text-slate-200';
  return (
    <span className={`inline-flex items-baseline gap-1 rounded border px-1 py-px ${toneCls}`}>
      <span className="text-[8.5px] font-medium uppercase tracking-wide opacity-90">{label}</span>
      <span className="text-[10.5px] font-bold tabular-nums">{value}</span>
    </span>
  );
}

function Stat({ label, value, cls = '' }: { label: string; value: number | null; cls?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-[8.5px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`text-[11.5px] font-semibold tabular-nums ${cls || 'text-foreground'}`}>
        {value == null ? '—' : value.toLocaleString('en-IN')}
      </span>
    </span>
  );
}

// One pick: name + badge, its pills, and its plan — grouped as one unit.
function PickBlock({ p }: { p: StoredPick }) {
  const bull = p.direction === 'bullish';
  return (
    <div className="border-t border-border/50 pt-2 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span className="font-mono text-[12.5px] font-bold text-foreground">{p.symbol}</span>
        <span
          className={`rounded px-1 py-px text-[10px] font-bold ${bull ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'}`}
        >
          BUY {p.strike != null ? `${p.strike} ${p.side}` : p.side}
        </span>
        {p.expiry && <span className="text-[9px] text-muted-foreground">exp {p.expiry}{p.lot ? ` · lot ${p.lot}` : ''}</span>}
        <span className="ml-auto text-[9.5px] text-muted-foreground">
          score {p.score.toFixed(3)}
          {p.changePctOpen != null && (
            <span className={p.changePctOpen >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
              {' '}· {p.changePctOpen >= 0 ? '+' : ''}
              {p.changePctOpen.toFixed(1)}%
            </span>
          )}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {p.chips.map((c, i) => (
          <Pill key={`${c.label}-${i}`} {...c} />
        ))}
      </div>
      {p.entrySpot != null && (
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <Stat label="Entry" value={p.entrySpot} />
          <Stat label={`SL·${p.slBasis}`} value={p.slSpot} cls="text-red-600 dark:text-red-400" />
          <Stat label="Target" value={p.targetSpot} cls="text-emerald-600 dark:text-emerald-400" />
          {p.premium != null && <Stat label="Prem" value={p.premium} />}
          {p.perLotCost != null && (
            <span className="text-[10.5px] text-muted-foreground">₹{Math.round(p.perLotCost).toLocaleString('en-IN')}/lot</span>
          )}
        </div>
      )}
    </div>
  );
}

// Split the read into a market header (before the first per-stock heading), one
// section per suggested ticker, and a closing "Bottom line" section — so each
// stock's analysis renders directly under its own pick card. Falls back to one
// block (whole text as intro) for older rows that predate the structured prompt.
function splitByStock(text: string, symbols: string[]): { intro: string; perStock: Record<string, string>; closing: string } {
  const lines = text.split('\n');
  const headIdx: number[] = [];
  lines.forEach((l, i) => {
    if (/^#{1,4}\s+/.test(l.trim())) headIdx.push(i);
  });
  if (headIdx.length === 0) return { intro: text, perStock: {}, closing: '' };

  const intro = lines.slice(0, headIdx[0]).join('\n').trim();
  const perStock: Record<string, string> = {};
  const closingParts: string[] = [];
  for (let h = 0; h < headIdx.length; h++) {
    const start = headIdx[h];
    const end = headIdx[h + 1] ?? lines.length;
    const seg = lines.slice(start, end).join('\n').trim();
    const headText = lines[start].replace(/^#{1,4}\s+/, '').replace(/\*\*/g, '').toUpperCase();
    const match = symbols.find((s) => new RegExp(`\\b${s.toUpperCase()}\\b`).test(headText));
    if (match && !perStock[match]) perStock[match] = seg;
    else closingParts.push(seg);
  }
  return { intro, perStock, closing: closingParts.join('\n\n') };
}

// Drop the leading "### TICKER — " heading line from a per-stock section, keeping
// just the verdict text (the card above already shows the ticker) so it renders
// as a clean lead-in rather than a redundant uppercase heading.
function stripHeadingTicker(seg: string, symbol: string): string {
  const lines = seg.split('\n');
  if (lines.length && /^#{1,4}\s+/.test(lines[0].trim())) {
    let h = lines[0].replace(/^#{1,4}\s+/, '').replace(/\*\*/g, '').trim();
    // Prefer the verdict after the first dash ("BIOCON CE 420 — Losing conviction" → "Losing conviction");
    // else drop just the leading "TICKER CE/PE 420" token.
    const dash = h.match(/[—–]|\s-\s/);
    if (dash && dash.index !== undefined) {
      h = h.slice(dash.index + dash[0].length).trim();
    } else {
      h = h.replace(new RegExp(`^${symbol}\\b\\s*(?:CE|PE)?\\s*[\\d.]*\\s*`, 'i'), '').trim();
    }
    lines[0] = h ? `**${h}**` : '';
  }
  return lines.join('\n').trim();
}

export default function TradeCommentaryPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const { readOnly } = useRole();

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
      setLoading(false);
      setGenerating(false);
    }
  }, [load]);

  // Newest first (latest on top). API already returns newest-first; add subtle
  // day dividers when the date changes.
  const rows = data?.rows ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Bot className="h-5 w-5 shrink-0 text-primary" />
        <h1 className="text-base font-bold text-foreground sm:text-lg">Trade Commentary</h1>
        <span
          className="rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-[11px] font-medium text-primary"
          title="Powered exclusively by Xiaomi MiMo — no OpenAI/Azure. The picks are deterministic; MiMo only narrates them."
        >
          ⚡ Xiaomi MiMo · {data?.model ?? 'mimo-v2.5-pro'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {/* Viewers don't see operator actions at all (server 403s them anyway). */}
          {!readOnly && (
            <button
              type="button"
              onClick={generateNow}
              disabled={generating || data?.configured === false}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">Generate now</span>
              <span className="sm:hidden">Generate</span>
            </button>
          )}
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

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        A running per-day narration of the deterministic scan picks — each read builds on the day’s earlier ones (what
        broke out, what held, what’s new); each new day starts fresh. Generated in-process during market hours (per the
        /config window), so it fills even when the app isn’t open. Narration by <strong>Xiaomi MiMo</strong>; it only
        describes what the scanner computed and never places orders. Not financial advice.
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
          {rows.map((r, idx) => {
            const showDay = idx === 0 || rows[idx - 1].date !== r.date;
            const picks = r.picks ?? [];
            const split = splitByStock(r.text, picks.map((p) => p.symbol));
            const structured = Object.keys(split.perStock).length > 0;
            return (
              <Fragment key={r.id}>
                {showDay && (
                  <div className="sticky top-0 z-10 -mx-1 bg-background/85 px-1 py-1 text-xs font-semibold text-muted-foreground backdrop-blur">
                    {r.date}
                  </div>
                )}
                <div className="rounded-xl border bg-card p-2.5 shadow-sm">
                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted-foreground">
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-gradient-to-br from-primary to-primary/70 text-primary-foreground">
                      <Sparkles className="h-2.5 w-2.5" />
                    </span>
                    <span className="font-semibold text-foreground">{fmtTime(r.asOf)} IST</span>
                    {r.windowActive && (
                      <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
                        in window
                      </span>
                    )}
                    <span className="ml-auto">
                      {r.picksCount} pick{r.picksCount === 1 ? '' : 's'}
                    </span>
                  </div>

                  {structured ? (
                    <div className="space-y-2">
                      {/* Market header — the scan status, no ticker */}
                      {split.intro && (
                        <div className="rounded-lg bg-muted/30 px-2 py-1.5">
                          <RichText content={split.intro} />
                        </div>
                      )}
                      {/* Each stock: pills + plan, then its own analysis directly below */}
                      {picks.map((p, i) => (
                        <div key={`${p.symbol}-${i}`} className="rounded-lg border border-border/50 bg-muted/10 p-2">
                          <PickBlock p={p} />
                          {split.perStock[p.symbol] && (
                            <div className="mt-1.5 border-t border-border/40 pt-1.5">
                              <RichText content={stripHeadingTicker(split.perStock[p.symbol], p.symbol)} />
                            </div>
                          )}
                        </div>
                      ))}
                      {/* Bottom line — overall verdict / end-of-day retrospective */}
                      {split.closing && (
                        <div className="rounded-lg bg-primary/5 px-2 py-1.5">
                          <RichText content={split.closing} />
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      {picks.length > 0 && (
                        <div className="mb-2 space-y-2 rounded-lg bg-muted/20 p-2">
                          {picks.map((p, i) => (
                            <PickBlock key={`${p.symbol}-${i}`} p={p} />
                          ))}
                        </div>
                      )}
                      <div className="rounded-lg bg-muted/30 px-2 py-1.5">
                        <div className="mb-0.5 text-[8.5px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                          AI read
                        </div>
                        <RichText content={r.text} />
                      </div>
                    </>
                  )}
                </div>
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
