'use client';

import { Grid3x3, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SectorAggregate } from '@/lib/sector/aggregate';
import { squarify, squarifyOrdered, type TreemapRect } from './_lib/squarify';

interface HeatTile {
  symbol: string;
  sector: string;
  /** % change vs the previous close (includes the overnight gap). */
  pct: number;
  /** % change since today's open (the default "today" view; no gap). */
  intradayPct: number;
  turnover: number;
  price: number;
}

type Metric = 'intraday' | 'prevclose';

/**
 * Our sector name → official NSE sectoral-index symbol. Used to overlay the
 * real NSE index % on each sector band so the heatmap's sector headlines line
 * up with /nse/heatmap. Sectors with no clean NSE index (Capital Goods,
 * Consumer Services, Services, Telecom) are intentionally omitted — they fall
 * back to the turnover-weighted proxy. Symbols are the exact NSE `indexSymbol`
 * strings already used by /nse/heatmap, so they're known-valid.
 */
const SECTOR_TO_NSE_INDEX: Record<string, string> = {
  AUTO: 'NIFTY AUTO',
  CEMENT: 'NIFTY CEMENT',
  CHEMICALS: 'NIFTY CHEMICALS',
  'CONSUMER DURABLES': 'NIFTY CONSR DURBL',
  ENERGY: 'NIFTY ENERGY',
  'FIN SERVICE': 'NIFTY FIN SERVICE',
  FMCG: 'NIFTY FMCG',
  IT: 'NIFTY IT',
  METAL: 'NIFTY METAL',
  PHARMA: 'NIFTY PHARMA',
  'PSU BANK': 'NIFTY PSU BANK',
  'PVT BANK': 'NIFTY PVT BANK',
  REALTY: 'NIFTY REALTY',
};

interface HeatmapResponse {
  success: boolean;
  source?: 'live' | 'eod' | 'session';
  marketOpen?: boolean;
  asOf?: string;
  sessionDate?: string;
  baseDate?: string;
  /** True when serving the last good LIVE snapshot because the latest quote
   *  call failed — data is real but no longer fresh; a retry is in flight. */
  stale?: boolean;
  /** Set when the market is open but the live quote failed (rate limit etc.). */
  liveError?: string | null;
  tiles?: HeatTile[];
  /** Per-sector turnover-weighted move + breadth (headlines each sector band). */
  sectors?: SectorAggregate[];
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

/** Compact "how long ago" for the freshness/staleness indicator. */
function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s ago`;
}

export default function HeatmapPage() {
  const [data, setData] = useState<HeatmapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tile coloring metric. Default 'prevclose' = change vs the previous close —
  // the standard daily % everyone quotes, and what NSE movers/heatmap show, so
  // numbers MATCH NSE out of the box. 'intraday' (since open) is the toggle.
  const [metric, setMetric] = useState<Metric>('prevclose');
  // Official NSE sector-index % overlay (sector name → % vs prev close), so the
  // sector bands match /nse/heatmap. null until the first NSE fetch lands.
  const [nsePct, setNsePct] = useState<Map<string, number> | null>(null);
  const [nseStale, setNseStale] = useState(false);
  // Ticks every second so the "updated Xs ago" age stays live between polls —
  // this is what makes staleness visible (the number keeps climbing) instead of
  // a frozen timestamp the user can't judge.
  const [nowTs, setNowTs] = useState(() => Date.now());

  // Returns the parsed response so the poll loop can pick its interval WITHOUT
  // side effects inside a setState updater (impure updaters run twice in
  // StrictMode and were doubling the pollers every cycle → request storm).
  const fetchOnce = useCallback(async (): Promise<HeatmapResponse | null> => {
    setRefreshing(true);
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
      setRefreshing(false);
    }
  }, []);

  // Keep the age counter live (1s cadence).
  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Overlay the OFFICIAL NSE sector indices (same live feed as /nse/heatmap) so
  // sector headlines match it. Independent 60s poll (NSE route caches 60s); a
  // failure keeps the last good overlay rather than blanking it.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (stopped) return;
      try {
        const res = await fetch('/api/nse/heatmap');
        const d = (await res.json()) as {
          success?: boolean;
          stale?: boolean;
          indices?: { symbol: string; percentChange: number }[];
        };
        if (!stopped && d.success && Array.isArray(d.indices)) {
          const bySym = new Map(d.indices.map((i) => [i.symbol, i.percentChange]));
          const m = new Map<string, number>();
          for (const [sector, idxSym] of Object.entries(SECTOR_TO_NSE_INDEX)) {
            const v = bySym.get(idxSym);
            if (v != null) m.set(sector, v);
          }
          setNsePct(m);
          setNseStale(Boolean(d.stale));
        }
      } catch {
        // Keep the last good overlay; sectors without NSE data use the proxy.
      }
      if (stopped) return;
      timer = setTimeout(tick, 60_000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
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

  // Sector headline % = official NSE sector index when we have it (so it matches
  // /nse/heatmap), else the turnover-weighted proxy. `source` lets the UI say
  // which one a band is showing. Always "vs prev close" — NSE gives nothing else.
  const sectorHeadline = useMemo(() => {
    const m = new Map<string, { pct: number; source: 'nse' | 'proxy' }>();
    for (const s of data?.sectors ?? []) {
      const nse = nsePct?.get(s.sector);
      m.set(
        s.sector,
        nse != null ? { pct: nse, source: 'nse' } : { pct: s.weightedPct, source: 'proxy' },
      );
    }
    return m;
  }, [data, nsePct]);

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
    // Bands are sized by turnover but ORDERED by MAGNITUDE of % change (biggest
    // mover first, regardless of + / −) so the map reads top-left = most active
    // sector → bottom-right = quietest. Color still encodes direction (red/green).
    // squarifyOrdered preserves this order; plain squarify would re-sort by area.
    const sectorTotals = [...bySector.entries()]
      .map(([sector, g]) => ({ id: sector, value: g.reduce((s, t) => s + t.turnover, 0) }))
      .sort(
        (a, b) =>
          Math.abs(sectorHeadline.get(b.id)?.pct ?? 0) -
          Math.abs(sectorHeadline.get(a.id)?.pct ?? 0),
      );
    const sectorRects = squarifyOrdered(sectorTotals, 0, 0, W, H);
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
  }, [data, sectorHeadline]);

  // Per-sector aggregate (turnover-weighted move + breadth) keyed by sector name.
  const sectorAgg = useMemo(
    () => new Map((data?.sectors ?? []).map((s) => [s.sector, s])),
    [data],
  );

  // Sectors ranked by their headline move (NSE official when available) for the
  // side bar chart. maxAbs scales the diverging bars so the strongest mover fills
  // the track on each side.
  const sectorRanking = useMemo(() => {
    // Bar chart stays a SIGNED leaderboard — gainers (top) → losers (bottom).
    // (The treemap is the magnitude view; this side chart keeps direction order.)
    const arr = (data?.sectors ?? [])
      .map((agg) => {
        const h = sectorHeadline.get(agg.sector);
        return { agg, pct: h?.pct ?? agg.weightedPct, source: h?.source ?? 'proxy' };
      })
      .sort((a, b) => b.pct - a.pct);
    const maxAbs = arr.reduce((m, s) => Math.max(m, Math.abs(s.pct)), 0) || 1;
    return { arr, maxAbs };
  }, [data, sectorHeadline]);

  // ── Single source of truth for "what state are we in?" ──────────────────
  // The badge, the age line, and the footer all read from these so the UI can
  // never say two contradictory things at once.
  const ageMs = data?.asOf ? nowTs - new Date(data.asOf).getTime() : null;
  const isLiveFresh = data?.source === 'live' && !data.stale;
  const isLiveStale = data?.source === 'live' && data.stale === true;
  const isEodClosed = data?.source === 'eod' && !data.marketOpen;
  const isEodNoLive = data?.source === 'eod' && data.marketOpen; // open, but no live snapshot yet
  // TODAY's completed session, built from the Fyers 5-min candles the poller
  // records — shown right after the 15:30 close, before the evening bhavcopy.
  const isSessionClosed = data?.source === 'session';

  // Selected stock-tile metric. Sector headlines are independent (always NSE/proxy
  // vs prev close — NSE gives no intraday).
  const tilePct = (t: HeatTile) => (metric === 'intraday' ? t.intradayPct : t.pct);
  const nseActive = (nsePct?.size ?? 0) > 0;

  return (
    <div className="mx-auto max-w-7xl space-y-3 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <Grid3x3 className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-bold text-foreground">F&O Heatmap</h1>
        {/* LIVE · fresh — green pulse, real-time Dhan feed */}
        {isLiveFresh && (
          <span
            className="flex items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"
            title="100% live Dhan feed — % change is Dhan's own net change vs the previous official close; size is today's traded value so far."
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> LIVE · today vs prev close
          </span>
        )}
        {/* LIVE · stale — last good live snapshot held while the feed retries.
            This is the key fix: we show REAL (if slightly old) live data, not
            yesterday, and say so plainly. */}
        {isLiveStale && (
          <span
            className="flex items-center gap-1.5 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400"
            title={`Live feed stalled (${data?.liveError ?? 'unknown reason'}). Holding the last good live snapshot${ageMs != null ? ` from ${fmtAgo(ageMs)}` : ''} and retrying every 15s — these are today's prices, just not the latest tick.`}
          >
            <RefreshCw className="h-3 w-3 animate-spin" />
            LIVE held{ageMs != null ? ` · ${fmtAgo(ageMs)}` : ''} · retrying…
          </span>
        )}
        {/* EOD · market closed */}
        {isEodClosed && (
          <span
            className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
            title="Market closed — showing the last synced session vs the one before it. Live colors resume at 9:15 IST."
          >
            EOD · {data?.sessionDate} vs {data?.baseDate}
          </span>
        )}
        {/* SESSION · today's completed session (post-close, from live candles) */}
        {isSessionClosed && (
          <span
            className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:bg-sky-500/10 dark:text-sky-400"
            title="Market closed — showing TODAY's completed session, built from the recorded 5-min candles (open→close of the day). The official NSE bhavcopy view takes over once it's synced this evening."
          >
            TODAY · {data?.sessionDate} (session)
          </span>
        )}
        {/* EOD · market open but no live snapshot yet (e.g. just after 9:15, or
            the very first call failed) */}
        {isEodNoLive && (
          <span
            className="flex items-center gap-1.5 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400"
            title={`Couldn't reach the live feed yet (${data?.liveError ?? 'unknown reason'}) — showing yesterday's EOD (${data?.sessionDate}) meanwhile. Retries automatically every 15s.`}
          >
            <RefreshCw className="h-3 w-3 animate-spin" />
            live feed unavailable — showing EOD {data?.sessionDate}, retrying…
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* Tile metric toggle — what the tile colors mean. Default matches NSE. */}
          <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
            <button
              type="button"
              onClick={() => setMetric('prevclose')}
              title="Change vs the PREVIOUS close — (LTP − prev close) / prev close. The standard daily % NSE quotes; includes the overnight gap. Matches NSE movers & NSE Heatmap."
              className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                metric === 'prevclose'
                  ? 'bg-foreground text-background'
                  : 'bg-muted text-muted-foreground hover:bg-accent'
              }`}
            >
              vs Prev close
            </button>
            <button
              type="button"
              onClick={() => setMetric('intraday')}
              title="Move since TODAY'S OPEN only — (LTP − open) / open. Excludes the overnight gap, so it differs from NSE's headline % on gap days."
              className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                metric === 'intraday'
                  ? 'bg-foreground text-background'
                  : 'bg-muted text-muted-foreground hover:bg-accent'
              }`}
            >
              Since open
            </button>
          </div>
          {data?.asOf && (
            <span
              className={`text-[10px] ${isLiveStale ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
              title={`Snapshot captured at ${new Date(data.asOf).toLocaleTimeString('en-IN', { hour12: false })}`}
            >
              updated {ageMs != null ? fmtAgo(ageMs) : new Date(data.asOf).toLocaleTimeString('en-IN', { hour12: false })}
            </span>
          )}
          <button
            type="button"
            onClick={() => void fetchOnce()}
            disabled={refreshing}
            className="flex items-center gap-1 rounded-md bg-muted px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-70"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* How to read it */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        <span>
          <b className="text-foreground">Size</b> = money traded (₹ turnover) — big tile, big participation.
        </span>
        <span>
          <b className="text-foreground">Tile color</b> ={' '}
          {metric === 'intraday'
            ? 'move since today’s open (excludes the overnight gap)'
            : 'change vs previous close (matches NSE)'}.
        </span>
        <span className="flex items-center gap-1">
          <span className="font-mono">−3%</span>
          <span className="h-2.5 w-28 rounded-sm" style={{ background: LEGEND_GRADIENT }} />
          <span className="font-mono">+3%</span>
        </span>
        <span>
          <b className="text-foreground">Sector %</b> ={' '}
          {nseActive ? 'official NSE sector index (matches NSE Heatmap)' : 'turnover-weighted avg'} · vs prev close.
        </span>
        <span>Hover any tile for details.</span>
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
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-[#1b1e27]">
          <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label="Sector heatmap">
            {layout.map(({ sector, stocks }) => {
              const agg = sectorAgg.get(sector.id);
              const head = sectorHeadline.get(sector.id);
              const headPct = head?.pct ?? agg?.weightedPct ?? 0;
              const isNse = head?.source === 'nse';
              return (
              <g key={sector.id}>
                {/* Sector band */}
                <rect x={sector.x} y={sector.y} width={sector.w} height={sector.h} fill="rgba(148,163,184,0.12)" stroke="rgba(148,163,184,0.45)" strokeWidth={1}>
                  {agg && (
                    <title>
                      {`${sector.id} — ${isNse ? 'NSE index' : 'turnover-weighted'} ${headPct >= 0 ? '+' : ''}${headPct.toFixed(2)}%${isNse ? ` (turnover-wtd proxy ${agg.weightedPct >= 0 ? '+' : ''}${agg.weightedPct.toFixed(2)}%)` : ` (simple ${agg.simplePct >= 0 ? '+' : ''}${agg.simplePct.toFixed(2)}%)`}\n${agg.advancers} up · ${agg.decliners} down · ${agg.unchanged} flat${agg.advanceRatio != null ? ` · ${Math.round(agg.advanceRatio * 100)}% advancing` : ''}`}
                    </title>
                  )}
                </rect>
                {sector.w > 56 && (
                  <text x={sector.x + 4} y={sector.y + 11.5} fontSize={9} fontWeight={700} style={{ textTransform: 'uppercase' }}>
                    <tspan fill="rgb(148,163,184)">{sector.id}</tspan>
                    {sector.w > 110 && (
                      <tspan dx={6} fill={headPct >= 0 ? 'rgb(48,204,90)' : 'rgb(246,53,56)'}>
                        {headPct >= 0 ? '+' : ''}
                        {headPct.toFixed(2)}%
                      </tspan>
                    )}
                  </text>
                )}
                {/* Stock tiles */}
                {stocks.map(({ rect, tile }) => {
                  if (!tile || rect.w <= 1 || rect.h <= 1) return null;
                  const showSym = rect.w > 44 && rect.h > 16;
                  const showPct = rect.w > 44 && rect.h > 30;
                  const fontSize = Math.min(12, Math.max(8, rect.w / 7));
                  const pct = tilePct(tile);
                  return (
                    <g key={tile.symbol}>
                      <rect x={rect.x} y={rect.y} width={Math.max(0, rect.w - 1)} height={Math.max(0, rect.h - 1)} fill={heatColor(pct)} rx={1}>
                        <title>
                          {`${tile.symbol} · ${tile.sector}\ntoday ${tile.intradayPct >= 0 ? '+' : ''}${tile.intradayPct.toFixed(2)}% · vs prev close ${tile.pct >= 0 ? '+' : ''}${tile.pct.toFixed(2)}%\n₹${tile.price.toFixed(1)} · turnover ${fmtCr(tile.turnover)}`}
                        </title>
                      </rect>
                      {showSym && (
                        <text x={rect.x + rect.w / 2} y={rect.y + rect.h / 2 + (showPct ? -2 : 3)} textAnchor="middle" fontSize={fontSize} fontWeight={700} fill="white" pointerEvents="none">
                          {tile.symbol}
                        </text>
                      )}
                      {showPct && (
                        <text x={rect.x + rect.w / 2} y={rect.y + rect.h / 2 + fontSize} textAnchor="middle" fontSize={fontSize * 0.85} fill="rgba(255,255,255,0.9)" pointerEvents="none">
                          {pct >= 0 ? '+' : ''}
                          {pct.toFixed(1)}%
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
              );
            })}
          </svg>
          </div>

          {/* Compact sector ranking — official NSE sector % when available, best → worst. */}
          <div className="w-full shrink-0 rounded-xl border border-border bg-card p-2 lg:w-60">
            <div className="mb-1.5 flex items-baseline justify-between px-1">
              <span className="text-[11px] font-semibold text-foreground">Sectors by % change</span>
              <span className="text-[9px] text-muted-foreground" title={nseActive ? 'Official NSE sector indices — matches the NSE Heatmap' : 'Turnover-weighted proxy (NSE feed unavailable)'}>
                {nseActive ? 'NSE official' : 'turnover-wtd'}
              </span>
            </div>
            <div className="space-y-[3px]">
              {sectorRanking.arr.map(({ agg, pct, source }) => {
                const frac = Math.min(1, Math.abs(pct) / sectorRanking.maxAbs);
                return (
                  <div
                    key={agg.sector}
                    className="flex items-center gap-1"
                    title={`${agg.sector} — ${source === 'nse' ? 'NSE index' : 'turnover-weighted'} ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%${source === 'nse' ? ` (turnover-wtd proxy ${agg.weightedPct >= 0 ? '+' : ''}${agg.weightedPct.toFixed(2)}%)` : ` (simple ${agg.simplePct >= 0 ? '+' : ''}${agg.simplePct.toFixed(2)}%)`}\n${agg.advancers} up · ${agg.decliners} down · ${agg.stocks} stocks`}
                  >
                    <span className="flex w-[62px] shrink-0 items-center gap-0.5 truncate text-[9px] text-muted-foreground">
                      {agg.sector}
                      {source === 'proxy' && <span title="No NSE sector index — turnover-weighted proxy">~</span>}
                    </span>
                    <div className="relative h-3 flex-1 rounded-sm bg-muted/40">
                      <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
                      <div
                        className="absolute top-0.5 bottom-0.5 rounded-sm"
                        style={
                          pct >= 0
                            ? { left: '50%', width: `${(frac * 50).toFixed(1)}%`, background: heatColor(pct) }
                            : { right: '50%', width: `${(frac * 50).toFixed(1)}%`, background: heatColor(pct) }
                        }
                      />
                    </div>
                    <span
                      className={`w-9 shrink-0 text-right text-[9px] tabular-nums ${pct >= 0 ? 'text-emerald-500' : 'text-red-400'}`}
                    >
                      {pct >= 0 ? '+' : ''}
                      {pct.toFixed(1)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {data && (
        <p className="text-[11px] text-muted-foreground">
          {data.tiles?.length ?? 0} F&O stocks across {data.sectors?.length ?? 0} sectors
          {isLiveFresh &&
            ' — fully live from Dhan (price, % change, and turnover are all today’s real-time figures; nothing comes from stored data).'}
          {isLiveStale &&
            ` — last good live snapshot${ageMs != null ? ` (${fmtAgo(ageMs)})` : ''}; the latest quote call failed, so this is held while we retry every 15s. Still today’s real figures — just not the newest tick.`}
          {isEodClosed &&
            ' — official NSE bhavcopy (market closed). Live colors resume automatically at 9:15 IST; EOD view updates when you sync NSE data.'}
          {isSessionClosed &&
            ` — today’s completed session (${data.sessionDate}), built from the recorded 5-min candles (day open→close, turnover summed). Shown right after the 15:30 close; the official NSE bhavcopy view takes over once synced this evening.`}
          {isEodNoLive &&
            ` — yesterday’s NSE bhavcopy (${data.sessionDate}) shown as a placeholder: the live feed couldn’t be reached yet. Retrying every 15s; live colors appear once a quote succeeds.`}{' '}
          {nseActive
            ? `Sector headlines use the official NSE sector indices${nseStale ? ' (cached)' : ''} — they match the NSE Heatmap. Sectors marked “~” have no NSE index and use a turnover-weighted proxy.`
            : 'Sector headlines use a turnover-weighted proxy (live NSE index feed unavailable).'}{' '}
          Stocks without a sector mapping are skipped, never guessed.
        </p>
      )}
    </div>
  );
}
