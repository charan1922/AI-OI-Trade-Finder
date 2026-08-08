'use client';

import { Grid3x3, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { squarify, squarifyOrdered, type TreemapRect } from '@/app/heatmap/_lib/squarify';
import groupsJson from '@/lib/data/sector_scope_groups.json';

type Signal = 'buy' | 'sell' | 'neutral' | null;
type DataSource = 'live' | 'stale-live' | 'session' | 'eod';

interface ScopeRow {
  symbol: string;
  ltp: number | null;
  previousClose: number | null;
  changePctPrevClose: number | null;
  rFactor: number | null;
  rFactorBias: Signal;
  turnover: number;
}

interface QuoteRow {
  symbol: string;
  rFactor: number | null;
  rFactorBias: Signal;
  previousClose?: number | null;
}

interface QuoteResponse {
  success: boolean;
  rows: QuoteRow[];
}

interface HeatmapTile {
  symbol: string;
  pct: number;
  turnover: number;
  price: number;
  previousClose: number;
}

interface HeatmapResponse {
  success: boolean;
  source?: DataSource;
  marketOpen?: boolean;
  sessionDate?: string;
  baseDate?: string;
  liveError?: string | null;
  tiles?: HeatmapTile[];
  error?: string;
}

interface IndexResponse {
  success: boolean;
  capturedAt?: string | null;
  values?: Record<string, number>;
}

interface TfRFactorResponse {
  success: boolean;
  capturedAt: string | null;
  values?: Record<string, { rFactor: number | null; pctChange: number | null; previousClose: number | null }>;
}

interface ScopeData {
  source: DataSource | undefined;
  marketOpen: boolean;
  sessionDate?: string;
  baseDate?: string;
  rows: ScopeRow[];
  /** When TradeFinder's own all_sector capture (the R-Factor column's source)
   *  was captured — null if /tf has never captured successfully. TF's board
   *  updates periodically, not live, so this can be minutes to a day old. */
  tfCapturedAt: string | null;
}

const GROUPS = groupsJson as Record<string, string[]>;
// Exactly the baskets TradeFinder's Sector Scope renders — verified against the
// live site on 2026-08-05: 15 baskets, 196 stocks, and NO 'OTHERS' card. The 14
// symbols the captured payload filed under OTHERS (SRF, HAL, DIXON, AMBER,
// CROMPTON, DELHIVERY, HAVELLS, IDEA, INDUSTOWER, KEI, NAM-INDIA, PGEL,
// PIDILITIND, COCHINSHIP) appear nowhere on that page, so neither do they here.
// Matches the basket order TradeFinder's own all_sector payload returns them
// in (https://tradefinder.in/api_be/data/order/all_sector, confirmed by the
// operator 2026-08-08) — not alphabetical, just their order.
const GROUP_ORDER = [
  'NIFTY METAL',
  'NIFTY PSU BANK',
  'NIFTY REALTY',
  'NIFTY ENERGY',
  'NIFTY AUTO',
  'NIFTY IT',
  'NIFTY PHARMA',
  'NIFTY 50',
  'NIFTY PVT BANK',
  'NIFTY BANK',
  'NIFTY FIN SERVICE',
  'NIFTY FMCG',
  'NIFTY CEMENT',
  'NIFTY MID SELECT',
  'SENSEX',
] as const;
const ALL_SYMBOLS = [...new Set(GROUP_ORDER.flatMap((name) => GROUPS[name] ?? []))];

// TradeFinder display labels. Internal keys retain their full index names so
// basket membership and Dhan index lookup remain unchanged.
const DISPLAY_NAME: Record<(typeof GROUP_ORDER)[number], string> = {
  'NIFTY 50': 'NIFTY 50',
  'NIFTY AUTO': 'AUTO',
  'NIFTY BANK': 'BANK',
  'NIFTY CEMENT': 'CEMENT',
  'NIFTY ENERGY': 'ENERGY',
  'NIFTY FIN SERVICE': 'FIN SERVICE',
  'NIFTY FMCG': 'FMCG',
  'NIFTY IT': 'IT',
  'NIFTY METAL': 'METAL',
  'NIFTY MID SELECT': 'NIFTY MID SELECT',
  'NIFTY PHARMA': 'PHARMA',
  'NIFTY PSU BANK': 'PSU BANK',
  'NIFTY PVT BANK': 'PVT BANK',
  'NIFTY REALTY': 'REALTY',
  SENSEX: 'SENSEX',
};

function displayName(name: (typeof GROUP_ORDER)[number]): string {
  return DISPLAY_NAME[name];
}

const W = 1200;
const H = 675;
const HEADER = 16;
const PAD = 2;

const COLOR_STOPS: [number, [number, number, number]][] = [
  [-3, [246, 53, 56]],
  [-2, [191, 64, 69]],
  [-1, [139, 68, 78]],
  [0, [65, 69, 84]],
  [1, [53, 118, 78]],
  [2, [47, 158, 79]],
  [3, [48, 204, 90]],
];

const LEGEND_GRADIENT = `linear-gradient(to right, ${COLOR_STOPS.map(
  ([pct, color]) => `rgb(${color[0]},${color[1]},${color[2]}) ${((pct + 3) / 6) * 100}%`,
).join(', ')})`;

function heatColor(pct: number): string {
  const value = Math.max(-3, Math.min(3, pct));
  for (let index = 0; index < COLOR_STOPS.length - 1; index++) {
    const [startPct, start] = COLOR_STOPS[index];
    const [endPct, end] = COLOR_STOPS[index + 1];
    if (value <= endPct) {
      const weight = (value - startPct) / (endPct - startPct);
      const color = start.map((channel, channelIndex) => Math.round(channel + (end[channelIndex] - channel) * weight));
      return `rgb(${color[0]},${color[1]},${color[2]})`;
    }
  }
  const last = COLOR_STOPS[COLOR_STOPS.length - 1][1];
  return `rgb(${last[0]},${last[1]},${last[2]})`;
}

function formatPrice(value: number | null) {
  if (value == null) return '-';
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: value < 100 ? 2 : 1,
    maximumFractionDigits: 2,
  }).format(value);
}

/** TradeFinder's board updates periodically, not live — this says exactly how
 *  stale the R-Factor column is, rather than letting a silent number imply
 *  it's ticking in real time. */
function formatTfCapturedAt(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function SectorScopePage() {
  const [data, setData] = useState<ScopeData | null>(null);
  const [indexValues, setIndexValues] = useState<Record<string, number>>({});
  const [indexCapturedAt, setIndexCapturedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchOnce = useCallback(async (fresh = false): Promise<ScopeData | null> => {
    setRefreshing(true);
    try {
      const heatmapResponse = await fetch('/api/heatmap', { cache: 'no-store' });
      const heatmap = (await heatmapResponse.json()) as HeatmapResponse;

      // R-Factor enrichment (our own bias signal, and previousClose fallback).
      // It is never allowed to block the raw Dhan/Fyers price, prior-close,
      // and percentage fields.
      let quote: QuoteResponse | null = null;
      try {
        const quoteResponse = await fetch('/api/live/quote', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbols: ALL_SYMBOLS, scope: 'sector-scope', fresh }),
        });
        const payload = (await quoteResponse.json()) as QuoteResponse;
        if (quoteResponse.ok && payload.success) quote = payload;
      } catch {
        // The source rows below remain usable without this enrichment.
      }

      try {
        const indexResponse = await fetch('/api/sector-scope/indices', { cache: 'no-store' });
        const payload = (await indexResponse.json()) as IndexResponse;
        if (indexResponse.ok && payload.success) {
          setIndexValues(payload.values ?? {});
          setIndexCapturedAt(payload.capturedAt ?? null);
        }
      } catch {
        // Stock heatmap data remains usable if the separate index feed is down.
      }

      // The R-Factor NUMBER shown on this page is TradeFinder's OWN, from their
      // most recent captured all_sector board — not our own model (user request
      // 2026-08-08: the two page's numbers previously didn't match because this
      // page computed its own instead of showing theirs).
      let tfRFactor: TfRFactorResponse | null = null;
      try {
        const tfResponse = await fetch('/api/tf/rfactor-map', { cache: 'no-store' });
        const payload = (await tfResponse.json()) as TfRFactorResponse;
        if (tfResponse.ok && payload.success) tfRFactor = payload;
      } catch {
        // The source rows below remain usable without TF's R-Factor.
      }

      const tileBySymbol = new Map((heatmap.tiles ?? []).map((tile) => [tile.symbol, tile]));
      const quoteBySymbol = new Map((quote?.rows ?? []).map((row) => [row.symbol, row]));
      const tfBySymbol = tfRFactor?.values ?? {};
      const rows = ALL_SYMBOLS.map((symbol) => {
        const tile = tileBySymbol.get(symbol);
        const live = quoteBySymbol.get(symbol);
        return {
          symbol,
          ltp: tile?.price ?? null,
          previousClose: tile?.previousClose ?? live?.previousClose ?? null,
          changePctPrevClose: tile?.pct ?? null,
          rFactor: tfBySymbol[symbol]?.rFactor ?? null,
          rFactorBias: live?.rFactorBias ?? null,
          turnover: tile?.turnover ?? 0,
        } satisfies ScopeRow;
      });

      if (!heatmap.success || !rows.some((row) => row.ltp != null && row.changePctPrevClose != null)) {
        throw new Error(heatmap.error ?? 'Sector Scope market data is unavailable');
      }

      const next = {
        source: heatmap.source,
        marketOpen: heatmap.marketOpen ?? false,
        sessionDate: heatmap.sessionDate,
        baseDate: heatmap.baseDate,
        rows,
        tfCapturedAt: tfRFactor?.capturedAt ?? null,
      } satisfies ScopeData;
      setData(next);
      setError(null);
      return next;
    } catch (fetchError) {
      setError((fetchError as Error).message);
      return null;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const next = await fetchOnce();
      if (stopped) return;
      timer = setTimeout(tick, next?.marketOpen ? 150_000 : 900_000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchOnce]);

  const bySymbol = useMemo(() => new Map((data?.rows ?? []).map((row) => [row.symbol, row])), [data]);

  const baskets = useMemo(
    () => GROUP_ORDER.map((name) => {
      const rows = (GROUPS[name] ?? []).map((symbol) => bySymbol.get(symbol)).filter((row): row is ScopeRow => Boolean(row));
      const priced = rows.filter((row) => row.changePctPrevClose != null);
      const averagePct = priced.length
        ? priced.reduce((total, row) => total + (row.changePctPrevClose ?? 0), 0) / priced.length
        : 0;
      const turnover = rows.reduce((total, row) => total + row.turnover, 0);
      const indexPct = indexValues[name];
      return {
        name,
        rows,
        priced,
        averagePct,
        turnover,
        chartPct: indexPct ?? null,
      };
    }),
    [bySymbol, indexValues],
  );

  const basketByName = useMemo(() => new Map(baskets.map((basket) => [basket.name, basket])), [baskets]);

  const layout = useMemo(() => {
    const visible = baskets.filter((basket) => basket.rows.length > 0);
    const outer = squarifyOrdered(
      visible.map((basket) => ({ id: basket.name, value: Math.max(1, basket.turnover) })),
      0,
      0,
      W,
      H,
    );
    return outer.map((group) => {
      const basket = basketByName.get(group.id as (typeof GROUP_ORDER)[number])!;
      const inner: TreemapRect[] = group.w > PAD * 2 && group.h > HEADER + PAD * 2
        ? squarify(
            basket.rows.map((row) => ({ id: row.symbol, value: Math.max(1, row.turnover) })),
            group.x + PAD,
            group.y + HEADER,
            group.w - PAD * 2,
            group.h - HEADER - PAD,
          )
        : [];
      return { group, basket, stocks: inner.map((rect) => ({ rect, row: bySymbol.get(rect.id) })) };
    });
  }, [baskets, basketByName, bySymbol]);

  const live = data?.source === 'live' || data?.source === 'stale-live';
  const chart = useMemo(
    () => baskets
      .flatMap((basket) => (basket.chartPct != null ? [{ ...basket, chartPct: basket.chartPct }] : []))
      .sort((a, b) => b.chartPct - a.chartPct),
    [baskets],
  );
  const chartBound = Math.max(0.5, ...chart.map((basket) => Math.abs(basket.chartPct)));
  const sourceLabel = live
    ? 'LIVE · Dhan'
    : data?.source === 'session'
      ? `TODAY · ${data.sessionDate ?? 'Fyers session'}`
      : `EOD · ${data?.sessionDate ?? 'stored session'}`;

  return (
    <div className="mx-auto max-w-7xl space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Grid3x3 className="size-5 text-primary" />
        <h1 className="text-lg font-bold text-foreground">Sector Scope</h1>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
            live
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
              : 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
          }`}
          title={live ? 'Live Dhan prices and previous-close percentages.' : 'Stored Fyers/NSE session data until a live Dhan snapshot is available.'}
        >
          {sourceLabel}
        </span>
        {data && (
          <span
            className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-500/10 dark:text-violet-400"
            title="The R column shows TradeFinder's OWN R-Factor from their most recent captured board — this is how old that capture is, not how fresh the prices above are."
          >
            TF R-Factor: {data.tfCapturedAt ? formatTfCapturedAt(data.tfCapturedAt) : 'no capture yet'}
          </span>
        )}
        <button
          type="button"
          onClick={() => void fetchOnce(true)}
          disabled={refreshing}
          className="ml-auto flex items-center gap-1 rounded-md bg-muted px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-70"
        >
          <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        <span><b className="text-foreground">15 baskets · 196 stocks</b> — membership verified against TradeFinder&rsquo;s Sector Scope.</span>
        <span><b className="text-foreground">LTP / prev close / %</b> — this app’s Dhan or Fyers/NSE data.</span>
        <span><b className="text-foreground">Tile size</b> = traded value; <b className="text-foreground">color</b> = % vs previous close.</span>
        <span className="flex items-center gap-1 font-mono"><span>−3%</span><span className="h-2.5 w-28 rounded-sm" style={{ background: LEGEND_GRADIENT }} /><span>+3%</span></span>
      </div>

      {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">{error}</div>}

      {loading && !data && (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-border p-10 text-sm text-muted-foreground">
          <Loader2 className="size-5 animate-spin text-primary" /> Loading Sector Scope…
        </div>
      )}

      {data && (
        <>
          <div className="overflow-hidden rounded-xl border border-border bg-[#1b1e27]">
            <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label="Sector Scope heatmap">
              {layout.map(({ group, basket, stocks }) => (
                <g key={basket.name}>
                  <rect x={group.x} y={group.y} width={group.w} height={group.h} fill="rgba(148,163,184,0.12)" stroke="rgba(148,163,184,0.45)" strokeWidth={1}>
                    <title>{`${displayName(basket.name)} · ${basket.priced.length}/${basket.rows.length} priced · average ${basket.averagePct >= 0 ? '+' : ''}${basket.averagePct.toFixed(2)}%`}</title>
                  </rect>
                  {group.w > 70 && (
                    <text x={group.x + 4} y={group.y + 11.5} fontSize={9} fontWeight={700} fill="rgb(148,163,184)">
                      {displayName(basket.name)} {basket.averagePct >= 0 ? '+' : ''}{basket.averagePct.toFixed(2)}%
                    </text>
                  )}
                  {stocks.map(({ rect, row }) => {
                    if (!row || rect.w <= 1 || rect.h <= 1) return null;
                    const pct = row.changePctPrevClose ?? 0;
                    const showSymbol = rect.w > 44 && rect.h > 16;
                    const showPct = rect.w > 44 && rect.h > 30;
                    const fontSize = Math.min(12, Math.max(8, rect.w / 7));
                    return (
                      <g key={`${basket.name}-${row.symbol}`}>
                        <rect x={rect.x} y={rect.y} width={Math.max(0, rect.w - 1)} height={Math.max(0, rect.h - 1)} fill={heatColor(pct)} rx={1}>
                          <title>{`${row.symbol}\nLTP ₹${formatPrice(row.ltp)} · Prev close ₹${formatPrice(row.previousClose)}\n${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% vs previous close${row.rFactor != null ? `\nTF R-Factor ${row.rFactor.toFixed(2)}` : ''}`}</title>
                        </rect>
                        {showSymbol && <text x={rect.x + rect.w / 2} y={rect.y + rect.h / 2 + (showPct ? -2 : 3)} textAnchor="middle" fontSize={fontSize} fontWeight={700} fill="white" pointerEvents="none">{row.symbol}</text>}
                        {showPct && <text x={rect.x + rect.w / 2} y={rect.y + rect.h / 2 + fontSize} textAnchor="middle" fontSize={fontSize * 0.85} fill="rgba(255,255,255,0.9)" pointerEvents="none">{pct >= 0 ? '+' : ''}{pct.toFixed(1)}%</text>}
                      </g>
                    );
                  })}
                </g>
              ))}
            </svg>
          </div>

          <section className="rounded-xl border border-border bg-card p-3">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Sector Scope bar graph</h2>
                <p className="text-[10px] text-muted-foreground">
                  TradeFinder&apos;s own per-index R-factor, from their most recent captured board.
                  {indexCapturedAt ? ` As of ${formatTfCapturedAt(indexCapturedAt)}.` : ' No capture yet.'}
                </p>
              </div>
              <span className="text-[10px] text-muted-foreground">{chart.length}/15 indices · strongest to weakest</span>
            </div>
            <div className="overflow-x-auto pb-1">
              <div className="min-w-[960px] px-2">
                <div className="grid h-28 items-end gap-2" style={{ gridTemplateColumns: `repeat(${chart.length}, minmax(0, 1fr))` }}>
                  {chart.map((basket) => {
                    const height = basket.chartPct > 0 ? Math.max(3, (basket.chartPct / chartBound) * 94) : 0;
                    return (
                      <div key={`positive-${basket.name}`} className="flex h-full flex-col items-center justify-end" title={`${displayName(basket.name)}: ${basket.chartPct >= 0 ? '+' : ''}${basket.chartPct.toFixed(2)} R-factor`}>
                        {basket.chartPct > 0 && <span className="mb-1 text-[9px] font-medium tabular-nums text-emerald-500">+{basket.chartPct.toFixed(2)}</span>}
                        <div className="w-7 rounded-t-sm bg-emerald-500" style={{ height }} />
                      </div>
                    );
                  })}
                </div>
                <div className="border-t border-border" />
                <div className="grid h-28 items-start gap-2" style={{ gridTemplateColumns: `repeat(${chart.length}, minmax(0, 1fr))` }}>
                  {chart.map((basket) => {
                    const height = basket.chartPct < 0 ? Math.max(3, (Math.abs(basket.chartPct) / chartBound) * 94) : 0;
                    return (
                      <div key={`negative-${basket.name}`} className="flex h-full flex-col items-center" title={`${displayName(basket.name)}: ${basket.chartPct.toFixed(2)} R-factor`}>
                        <div className="w-7 rounded-b-sm bg-red-500" style={{ height }} />
                        {basket.chartPct < 0 && <span className="mt-1 text-[9px] font-medium tabular-nums text-red-400">{basket.chartPct.toFixed(2)}</span>}
                      </div>
                    );
                  })}
                </div>
                <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${chart.length}, minmax(0, 1fr))` }}>
                  {chart.map((basket) => (
                    <div key={`label-${basket.name}`} className="flex h-24 items-start justify-center">
                      <span className="origin-top-left translate-x-2 rotate-45 whitespace-nowrap text-[9px] text-muted-foreground">{displayName(basket.name)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {baskets.map((basket) => (
              <section key={basket.name} className="rounded-xl border border-border bg-card p-3">
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold text-foreground">{displayName(basket.name)}</h2>
                    <p className="text-[10px] text-muted-foreground">{basket.priced.length}/{basket.rows.length} priced</p>
                  </div>
                  <span className={`text-xs font-semibold tabular-nums ${basket.averagePct >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>{basket.averagePct >= 0 ? '+' : ''}{basket.averagePct.toFixed(2)}%</span>
                </div>
                <div className="max-h-72 overflow-auto">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 bg-card text-[10px] text-muted-foreground">
                      <tr className="border-b border-border"><th className="py-1.5 text-left font-medium">Symbol</th><th className="py-1.5 text-right font-medium">LTP</th><th className="py-1.5 text-right font-medium">Prev C</th><th className="py-1.5 text-right font-medium">%</th><th className="py-1.5 text-right font-medium" title="TradeFinder's own R-Factor, from their most recent captured board — not our estimate of it.">R</th></tr>
                    </thead>
                    <tbody>
                      {[...basket.rows].sort((a, b) => (b.changePctPrevClose ?? -Infinity) - (a.changePctPrevClose ?? -Infinity)).map((row) => {
                        const pct = row.changePctPrevClose;
                        return <tr key={row.symbol} className="border-b border-border/60"><td className="py-1.5 font-medium text-foreground">{row.symbol}</td><td className="py-1.5 text-right tabular-nums">{formatPrice(row.ltp)}</td><td className="py-1.5 text-right tabular-nums text-muted-foreground">{formatPrice(row.previousClose)}</td><td className={`py-1.5 text-right font-medium tabular-nums ${pct == null ? 'text-muted-foreground' : pct >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>{pct == null ? '-' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`}</td><td className="py-1.5 text-right tabular-nums text-muted-foreground">{row.rFactor?.toFixed(2) ?? '-'}</td></tr>;
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
