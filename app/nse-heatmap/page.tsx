'use client';

import { LayoutGrid, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

interface NseIndex {
  symbol: string;
  name: string;
  category: string;
  last: number;
  previousClose: number;
  percentChange: number;
  variation: number;
  advances: number | null;
  declines: number | null;
  unchanged: number | null;
}

interface NseHeatmapResponse {
  success: boolean;
  asOf?: string | null;
  count?: number;
  indices?: NseIndex[];
  error?: string;
}

const POLL_MS = 60_000;

/** Categories ordered most-relevant first; anything else falls to the end. */
const CATEGORY_ORDER = [
  'SECTORAL INDICES',
  'BROAD MARKET INDICES',
  'INDICES ELIGIBLE IN DERIVATIVES',
  'THEMATIC INDICES',
  'STRATEGY INDICES',
  'FIXED INCOME INDICES',
];

/**
 * Finviz-style scale: deep neutral at 0%, saturated green/red at ±3%.
 * (Replicated locally so this page stays fully independent of /heatmap.)
 */
const COLOR_STOPS: [number, [number, number, number]][] = [
  [-3, [246, 53, 56]],
  [-2, [191, 64, 69]],
  [-1, [139, 68, 78]],
  [0, [65, 69, 84]],
  [1, [53, 118, 78]],
  [2, [47, 158, 79]],
  [3, [48, 204, 90]],
];

function heatColor(pct: number): string {
  const v = Math.max(-3, Math.min(3, pct));
  for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
    const [p0, c0] = COLOR_STOPS[i];
    const [p1, c1] = COLOR_STOPS[i + 1];
    if (v <= p1) {
      const k = (v - p0) / (p1 - p0);
      const c = c0.map((f, j) => Math.round(f + (c1[j] - f) * k));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  const last = COLOR_STOPS[COLOR_STOPS.length - 1][1];
  return `rgb(${last[0]},${last[1]},${last[2]})`;
}

const LEGEND_GRADIENT = `linear-gradient(to right, ${COLOR_STOPS.map(
  ([p, c]) => `rgb(${c[0]},${c[1]},${c[2]}) ${((p + 3) / 6) * 100}%`,
).join(', ')})`;

const fmtNum = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 2 });

export default function NseHeatmapPage() {
  const [data, setData] = useState<NseHeatmapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOnce = useCallback(async () => {
    try {
      const res = await fetch('/api/nse-heatmap');
      const d = (await res.json()) as NseHeatmapResponse;
      if (d.success) {
        setData(d);
        setError(null);
      } else {
        setError(d.error ?? 'Failed to load NSE indices');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (stopped) return;
      await fetchOnce();
      if (stopped) return;
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchOnce]);

  // Group indices by category, ordered, each group sorted by % change (desc).
  const groups = useMemo(() => {
    const indices = data?.indices ?? [];
    const byCat = new Map<string, NseIndex[]>();
    for (const idx of indices) {
      const g = byCat.get(idx.category);
      if (g) g.push(idx);
      else byCat.set(idx.category, [idx]);
    }
    const rank = (c: string) => {
      const i = CATEGORY_ORDER.indexOf(c);
      return i === -1 ? CATEGORY_ORDER.length : i;
    };
    return [...byCat.entries()]
      .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
      .map(([category, list]) => ({
        category,
        list: list.slice().sort((a, b) => b.percentChange - a.percentChange),
      }));
  }, [data]);

  return (
    <div className="mx-auto max-w-7xl space-y-3 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <LayoutGrid className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-bold text-foreground">NSE Heatmap</h1>
        <span
          className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"
          title="Official NSE sectoral & broad indices, straight from nseindia.com. Carries previous close, so it shows a real % change 24/7 — even when the market is closed."
        >
          Official NSE · 24/7
        </span>
        <div className="ml-auto flex items-center gap-2">
          {data?.asOf && (
            <span className="text-[10px] text-muted-foreground">as of {data.asOf}</span>
          )}
          <button
            type="button"
            onClick={() => void fetchOnce()}
            className="flex items-center gap-1 rounded-md bg-muted px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-accent"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* How to read it */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        <span>
          <b className="text-foreground">Each tile</b> = an official NSE index. <b className="text-foreground">Color</b> = % change vs the previous close.
        </span>
        <span className="flex items-center gap-1">
          <span className="font-mono">−3%</span>
          <span className="h-2.5 w-28 rounded-sm" style={{ background: LEGEND_GRADIENT }} />
          <span className="font-mono">+3%</span>
        </span>
        <span>Grouped by NSE category · hover a tile for details.</span>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
          <span className="mt-1 block text-xs text-muted-foreground">
            NSE occasionally rate-limits server calls — hit Refresh in a moment.
          </span>
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-border p-10 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          Loading NSE indices…
        </div>
      )}

      {groups.map(({ category, list }) => (
        <div key={category} className="space-y-1.5">
          <div className="flex items-baseline gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground">{category}</h2>
            <span className="text-[10px] text-muted-foreground">{list.length}</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {list.map((idx) => {
              const pct = idx.percentChange;
              return (
                <div
                  key={idx.symbol}
                  className="flex min-h-[60px] flex-col justify-between rounded-md p-2"
                  style={{ background: heatColor(pct) }}
                  title={`${idx.symbol}\n${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%  (${idx.variation >= 0 ? '+' : ''}${fmtNum(idx.variation)} pts)\nlast ${fmtNum(idx.last)} · prev ${fmtNum(idx.previousClose)}${
                    idx.advances != null && idx.declines != null
                      ? `\n${idx.advances} up · ${idx.declines} down${idx.unchanged != null ? ` · ${idx.unchanged} flat` : ''}`
                      : ''
                  }`}
                >
                  <div className="line-clamp-2 text-[10px] font-semibold leading-tight text-white/95">
                    {idx.symbol}
                  </div>
                  <div className="flex items-baseline justify-between gap-1">
                    <span className="text-[13px] font-bold tabular-nums text-white">
                      {pct >= 0 ? '+' : ''}
                      {pct.toFixed(2)}%
                    </span>
                    <span className="text-[9px] tabular-nums text-white/70">{fmtNum(idx.last)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {data && (
        <p className="text-[11px] text-muted-foreground">
          {data.count ?? 0} NSE indices · official figures from nseindia.com (works even when the market is
          closed — unlike a live broker feed). Auto-refreshes every 60s.
        </p>
      )}
    </div>
  );
}
