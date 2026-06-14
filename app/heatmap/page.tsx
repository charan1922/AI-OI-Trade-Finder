'use client';

import { Grid3x3, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { squarify, type TreemapRect } from './_lib/squarify';

interface HeatTile {
  symbol: string;
  sector: string;
  pct: number;
  turnover: number;
  price: number;
}

interface HeatmapResponse {
  success: boolean;
  source?: 'live' | 'eod';
  marketOpen?: boolean;
  asOf?: string;
  sessionDate?: string;
  baseDate?: string;
  /** Set when the market is open but the live quote failed (rate limit etc.). */
  liveError?: string | null;
  tiles?: HeatTile[];
  error?: string;
}

/** Poll fast whenever the market is open (so a one-off live failure retries
 *  quickly instead of sticking on EOD); closed-market data only changes after
 *  a sync, so poll slowly. */
const POLL_OPEN_MS = 15_000;
const POLL_CLOSED_MS = 120_000;

const W = 1200;
const H = 675;
const SECTOR_HEADER = 16;
const PAD = 2;

/**
 * Finviz-style color scale: deep neutral at 0%, saturated green/red at ±3%.
 * Piecewise-linear through fixed stops — far more vivid than a single
 * gray→color blend, and the dark neutral makes the extremes pop.
 */
const COLOR_STOPS: [number, [number, number, number]][] = [
  [-3, [246, 53, 56]], // strong red
  [-2, [191, 64, 69]],
  [-1, [139, 68, 78]],
  [0, [65, 69, 84]], // dark neutral slate
  [1, [53, 118, 78]],
  [2, [47, 158, 79]],
  [3, [48, 204, 90]], // strong green
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

/** CSS gradient matching the tile scale, for the legend strip. */
const LEGEND_GRADIENT = `linear-gradient(to right, ${COLOR_STOPS.map(
  ([p, c]) => `rgb(${c[0]},${c[1]},${c[2]}) ${((p + 3) / 6) * 100}%`,
).join(', ')})`;

const fmtCr = (v: number) => `₹${(v / 1e7).toFixed(v >= 1e9 ? 0 : 1)} Cr`;

export default function HeatmapPage() {
  const [data, setData] = useState<HeatmapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Returns the parsed response so the poll loop can pick its interval WITHOUT
  // side effects inside a setState updater (impure updaters run twice in
  // StrictMode and were doubling the pollers every cycle → request storm).
  const fetchOnce = useCallback(async (): Promise<HeatmapResponse | null> => {
    try {
      const res = await fetch('/api/heatmap');
      const d = (await res.json()) as HeatmapResponse;
      if (d.success) {
        setData(d);
        setError(null);
        return d;
      }
      setError(d.error ?? 'Failed to load heatmap');
      return null;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (stopped) return;
      const d = await fetchOnce();
      if (stopped) return;
      timer = setTimeout(tick, d?.marketOpen ? POLL_OPEN_MS : POLL_CLOSED_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchOnce]);

  // Two-level layout: sectors sized by total turnover, then stocks within each.
  const layout = useMemo(() => {
    const tiles = data?.tiles ?? [];
    if (tiles.length === 0) return null;
    const bySector = new Map<string, HeatTile[]>();
    for (const t of tiles) {
      const g = bySector.get(t.sector);
      if (g) g.push(t);
      else bySector.set(t.sector, [t]);
    }
    const sectorTotals = [...bySector.entries()].map(([sector, g]) => ({
      id: sector,
      value: g.reduce((s, t) => s + t.turnover, 0),
    }));
    const sectorRects = squarify(sectorTotals, 0, 0, W, H);
    const tileBySym = new Map(tiles.map((t) => [t.symbol, t]));

    return sectorRects.map((sr) => {
      const stocks = bySector.get(sr.id) ?? [];
      const inner: TreemapRect[] =
        sr.w > 2 * PAD && sr.h > SECTOR_HEADER + 2 * PAD
          ? squarify(
              stocks.map((t) => ({ id: t.symbol, value: t.turnover })),
              sr.x + PAD,
              sr.y + SECTOR_HEADER,
              sr.w - 2 * PAD,
              sr.h - SECTOR_HEADER - PAD,
            )
          : [];
      return { sector: sr, stocks: inner.map((r) => ({ rect: r, tile: tileBySym.get(r.id) })) };
    });
  }, [data]);

  return (
    <div className="mx-auto max-w-7xl space-y-3 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <Grid3x3 className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-bold text-foreground">F&O Heatmap</h1>
        {data?.source === 'live' && (
          <span
            className="flex items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"
            title="100% live Dhan feed — % change is Dhan's own net change vs the previous official close; size is today's traded value so far."
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> LIVE · today vs prev close
          </span>
        )}
        {data?.source === 'eod' && !data.marketOpen && (
          <span
            className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
            title="Market closed — showing the last synced session vs the one before it. Live colors resume at 9:15 IST."
          >
            EOD · {data.sessionDate} vs {data.baseDate}
          </span>
        )}
        {data?.source === 'eod' && data.marketOpen && (
          <span
            className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400"
            title={`The live quote call failed (${data.liveError ?? 'unknown reason'}) — showing the last session meanwhile. Retries automatically every 15s.`}
          >
            live feed hiccup — showing {data.sessionDate}, retrying…
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {data?.asOf && (
            <span className="text-[10px] text-muted-foreground">
              updated {new Date(data.asOf).toLocaleTimeString('en-IN', { hour12: false })}
            </span>
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
          <b className="text-foreground">Size</b> = money traded (₹ turnover) — big tile, big participation.
        </span>
        <span>
          <b className="text-foreground">Color</b> = % change{data?.source === 'live' ? ' since the last close' : ' vs the previous session'}.
        </span>
        <span className="flex items-center gap-1">
          <span className="font-mono">−3%</span>
          <span className="h-2.5 w-28 rounded-sm" style={{ background: LEGEND_GRADIENT }} />
          <span className="font-mono">+3%</span>
        </span>
        <span>Grouped by sector · hover any tile for details.</span>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">{error}</div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-border p-10 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          Building the heatmap…
        </div>
      )}

      {layout && (
        <div className="overflow-hidden rounded-xl border border-border bg-[#1b1e27]">
          <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label="Sector heatmap">
            {layout.map(({ sector, stocks }) => (
              <g key={sector.id}>
                {/* Sector band */}
                <rect x={sector.x} y={sector.y} width={sector.w} height={sector.h} fill="rgba(148,163,184,0.12)" stroke="rgba(148,163,184,0.45)" strokeWidth={1} />
                {sector.w > 56 && (
                  <text x={sector.x + 4} y={sector.y + 11.5} fontSize={9} fontWeight={700} fill="rgb(148,163,184)" style={{ textTransform: 'uppercase' }}>
                    {sector.id}
                  </text>
                )}
                {/* Stock tiles */}
                {stocks.map(({ rect, tile }) => {
                  if (!tile || rect.w <= 1 || rect.h <= 1) return null;
                  const showSym = rect.w > 44 && rect.h > 16;
                  const showPct = rect.w > 44 && rect.h > 30;
                  const fontSize = Math.min(12, Math.max(8, rect.w / 7));
                  return (
                    <g key={tile.symbol}>
                      <rect x={rect.x} y={rect.y} width={Math.max(0, rect.w - 1)} height={Math.max(0, rect.h - 1)} fill={heatColor(tile.pct)} rx={1}>
                        <title>
                          {`${tile.symbol} · ${tile.sector}\n${tile.pct >= 0 ? '+' : ''}${tile.pct.toFixed(2)}% · ₹${tile.price.toFixed(1)}\nturnover ${fmtCr(tile.turnover)}`}
                        </title>
                      </rect>
                      {showSym && (
                        <text x={rect.x + rect.w / 2} y={rect.y + rect.h / 2 + (showPct ? -2 : 3)} textAnchor="middle" fontSize={fontSize} fontWeight={700} fill="white" pointerEvents="none">
                          {tile.symbol}
                        </text>
                      )}
                      {showPct && (
                        <text x={rect.x + rect.w / 2} y={rect.y + rect.h / 2 + fontSize} textAnchor="middle" fontSize={fontSize * 0.85} fill="rgba(255,255,255,0.9)" pointerEvents="none">
                          {tile.pct >= 0 ? '+' : ''}
                          {tile.pct.toFixed(1)}%
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            ))}
          </svg>
        </div>
      )}

      {data && (
        <p className="text-[11px] text-muted-foreground">
          {data.tiles?.length ?? 0} F&O stocks across 11 sectors
          {data.source === 'live'
            ? ' — fully live from Dhan (price, % change, and turnover are all today’s real-time figures; nothing comes from stored data).'
            : ' — official NSE bhavcopy (market closed). Live colors resume automatically at 9:15 IST; EOD view updates when you sync NSE data.'}{' '}
          Stocks without a sector mapping are skipped, never guessed.
        </p>
      )}
    </div>
  );
}
