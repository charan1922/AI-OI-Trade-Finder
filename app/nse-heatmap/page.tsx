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

/**
 * Curated "main sectors" — the official NSE sectoral indices that mirror the
 * Dhan heatmap's sector buckets. Symbols are the exact NSE `indexSymbol` strings
 * (verified against /api/allIndices); `label` is the friendly name we display.
 */
const MAIN_SECTORS: { symbol: string; label: string }[] = [
  { symbol: 'NIFTY BANK', label: 'BANK' },
  { symbol: 'NIFTY PVT BANK', label: 'PVT BANK' },
  { symbol: 'NIFTY PSU BANK', label: 'PSU BANK' },
  { symbol: 'NIFTY FIN SERVICE', label: 'FIN SERVICE' },
  { symbol: 'NIFTY IT', label: 'IT' },
  { symbol: 'NIFTY AUTO', label: 'AUTO' },
  { symbol: 'NIFTY PHARMA', label: 'PHARMA' },
  { symbol: 'NIFTY HEALTHCARE', label: 'HEALTHCARE' },
  { symbol: 'NIFTY FMCG', label: 'FMCG' },
  { symbol: 'NIFTY METAL', label: 'METAL' },
  { symbol: 'NIFTY ENERGY', label: 'ENERGY' },
  { symbol: 'NIFTY OIL AND GAS', label: 'OIL & GAS' },
  { symbol: 'NIFTY REALTY', label: 'REALTY' },
  { symbol: 'NIFTY CEMENT', label: 'CEMENT' },
  { symbol: 'NIFTY CONSR DURBL', label: 'CONSUMER DURABLES' },
  { symbol: 'NIFTY CHEMICALS', label: 'CHEMICALS' },
  { symbol: 'NIFTY MEDIA', label: 'MEDIA' },
];

/** Key broad-market benchmarks shown as a compact context strip. */
const BROAD: { symbol: string; label: string }[] = [
  { symbol: 'NIFTY 50', label: 'NIFTY 50' },
  { symbol: 'NIFTY NEXT 50', label: 'NEXT 50' },
  { symbol: 'NIFTY 500', label: 'NIFTY 500' },
  { symbol: 'NIFTY MIDCAP 100', label: 'MIDCAP 100' },
  { symbol: 'NIFTY SMLCAP 100', label: 'SMALLCAP 100' },
  { symbol: 'INDIA VIX', label: 'INDIA VIX' },
];

const CATEGORY_ORDER = [
  'SECTORAL INDICES',
  'BROAD MARKET INDICES',
  'INDICES ELIGIBLE IN DERIVATIVES',
  'THEMATIC INDICES',
  'STRATEGY INDICES',
  'FIXED INCOME INDICES',
];

/** Finviz-style scale: deep neutral at 0%, saturated green/red at ±3%. */
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

/** One colored index tile. */
function IndexTile({ idx, label, big }: { idx: NseIndex; label: string; big?: boolean }) {
  const pct = idx.percentChange;
  return (
    <div
      className={`flex flex-col justify-between rounded-md p-2 ${big ? 'min-h-[72px]' : 'min-h-[58px]'}`}
      style={{ background: heatColor(pct) }}
      title={`${idx.symbol}\n${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%  (${idx.variation >= 0 ? '+' : ''}${fmtNum(idx.variation)} pts)\nlast ${fmtNum(idx.last)} · prev ${fmtNum(idx.previousClose)}${
        idx.advances != null && idx.declines != null
          ? `\n${idx.advances} up · ${idx.declines} down${idx.unchanged != null ? ` · ${idx.unchanged} flat` : ''}`
          : ''
      }`}
    >
      <div
        className={`line-clamp-2 font-semibold leading-tight text-white/95 ${big ? 'text-[11px]' : 'text-[10px]'}`}
      >
        {label}
      </div>
      <div className="flex items-baseline justify-between gap-1">
        <span className={`font-bold tabular-nums text-white ${big ? 'text-[15px]' : 'text-[13px]'}`}>
          {pct >= 0 ? '+' : ''}
          {pct.toFixed(2)}%
        </span>
        <span className="text-[9px] tabular-nums text-white/70">{fmtNum(idx.last)}</span>
      </div>
    </div>
  );
}

export default function NseHeatmapPage() {
  const [data, setData] = useState<NseHeatmapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'main' | 'all'>('main');

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

  const bySymbol = useMemo(
    () => new Map((data?.indices ?? []).map((i) => [i.symbol, i])),
    [data],
  );

  // Main view: curated sectors ordered by MAGNITUDE of move (biggest first,
  // like the Dhan heatmap), plus the broad-market strip in its fixed order.
  const mainSectors = useMemo(() => {
    return MAIN_SECTORS.map((m) => ({ ...m, idx: bySymbol.get(m.symbol) }))
      .filter((m): m is { symbol: string; label: string; idx: NseIndex } => !!m.idx)
      .sort((a, b) => Math.abs(b.idx.percentChange) - Math.abs(a.idx.percentChange));
  }, [bySymbol]);

  const broad = useMemo(
    () => BROAD.map((m) => ({ ...m, idx: bySymbol.get(m.symbol) })).filter((m) => !!m.idx),
    [bySymbol],
  );

  // All view: every index grouped by NSE category, sorted by % change in-group.
  const allGroups = useMemo(() => {
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

  const toggleCls = (id: 'main' | 'all') =>
    `rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
      view === id ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:bg-accent'
    }`;

  return (
    <div className="mx-auto max-w-7xl space-y-3 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <LayoutGrid className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-bold text-foreground">NSE Heatmap</h1>
        <span
          className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"
          title="Official NSE indices from nseindia.com. Carries previous close, so it shows a real % change 24/7 — even when the market is closed."
        >
          Official NSE · 24/7
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
            <button type="button" onClick={() => setView('main')} className={toggleCls('main')}>
              Main sectors
            </button>
            <button type="button" onClick={() => setView('all')} className={toggleCls('all')}>
              All indices
            </button>
          </div>
          {data?.asOf && <span className="text-[10px] text-muted-foreground">as of {data.asOf}</span>}
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
        <span>
          {view === 'main'
            ? 'Main sectors, biggest mover first.'
            : 'All NSE indices grouped by category.'}
        </span>
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

      {/* ── Main sectors view ───────────────────────────────────────────── */}
      {data && view === 'main' && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-baseline gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground">Sectors</h2>
              <span className="text-[10px] text-muted-foreground">{mainSectors.length}</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {mainSectors.map((m) => (
                <IndexTile key={m.symbol} idx={m.idx} label={m.label} big />
              ))}
            </div>
          </div>

          {broad.length > 0 && (
            <div className="space-y-1.5">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground">Broad market</h2>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-6">
                {broad.map((m) => (
                  <IndexTile key={m.symbol} idx={m.idx!} label={m.label} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── All indices view ────────────────────────────────────────────── */}
      {data &&
        view === 'all' &&
        allGroups.map(({ category, list }) => (
          <div key={category} className="space-y-1.5">
            <div className="flex items-baseline gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-foreground">{category}</h2>
              <span className="text-[10px] text-muted-foreground">{list.length}</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {list.map((idx) => (
                <IndexTile key={idx.symbol} idx={idx} label={idx.symbol} />
              ))}
            </div>
          </div>
        ))}

      {data && (
        <p className="text-[11px] text-muted-foreground">
          {view === 'main'
            ? `${mainSectors.length} sectors + ${broad.length} benchmarks`
            : `${data.count ?? 0} NSE indices`}{' '}
          · official figures from nseindia.com (works even when the market is closed). Auto-refreshes every 60s.
        </p>
      )}
    </div>
  );
}
