'use client';

import { Grid3x3, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { squarify, squarifyOrdered, type TreemapRect } from '@/app/heatmap/_lib/squarify';
import groupsJson from '@/lib/data/sector_scope_groups.json';

interface ScopeRow {
  symbol: string;
  ltp: number | null;
  previousClose: number | null;
  changePctPrevClose: number | null;
  rFactor: number | null;
}

/** Only `turnover` is read off this — see the `turnoverBySymbol` note. Every
 *  NUMBER this page shows comes from TradeFinder, never from here. */
interface HeatmapResponse {
  success: boolean;
  tiles?: { symbol: string; turnover: number }[];
}

interface IndexResponse {
  success: boolean;
  capturedAt?: string | null;
  values?: Record<string, number>;
}

interface TfRFactorResponse {
  success: boolean;
  capturedAt: string | null;
  values?: Record<string, { ltp: number | null; rFactor: number | null; pctChange: number | null; previousClose: number | null }>;
}

interface ScopeData {
  rows: ScopeRow[];
  /** When the all_sector capture every number on this page comes from was
   *  taken — null if /tf has never captured successfully. TradeFinder's board
   *  refreshes periodically, not tick-by-tick, and stops entirely when their
   *  session lapses (as it did at 12:10 IST on 2026-08-10), so this is the
   *  page's real freshness and is shown rather than implied. */
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

/** How often tile SIZES may be refreshed from /api/heatmap. Deliberately far
 *  slower than the board itself — see the call site for why a broker call for
 *  rectangle area must not compete with /live's quote polling. */
const HEATMAP_MIN_INTERVAL_MS = 10 * 60_000;

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
  /** Wall clock, in state rather than read during render — the capture-age
   *  badge has to keep counting up BETWEEN refreshes (a frozen board is
   *  precisely when no new data arrives to re-render on), but calling Date.now()
   *  in the render body is impure and unstable. Starts null so the server and
   *  the first client render agree; fetchOnce sets it on the very first tick. */
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  /** Traded value per symbol, used for NOTHING except treemap tile size — the
   *  proportional look of /heatmap, which the operator wants kept (2026-08-10).
   *  TradeFinder's payload carries no turnover, so this is the one thing still
   *  sourced from Dhan/Fyers via /api/heatmap. It is fetched OUT OF BAND and
   *  never awaited: the grid paints immediately from TF's capture with equal
   *  tiles, then re-proportions the moment turnover lands. A slow or failed
   *  broker call therefore costs layout polish, never the page. */
  const [turnoverBySymbol, setTurnoverBySymbol] = useState<Record<string, number>>({});
  /** When tile sizes were last refreshed. Kept in a ref, not state — it must
   *  not trigger a render, and it must survive every board refresh in between. */
  const lastHeatmapAtRef = useRef(0);

  /**
   * TWO parallel reads, both pure SQLite, no broker anywhere. This page is 100%
   * TradeFinder now (user decision 2026-08-10: "it totally depends on TF data")
   * and loads in tens of milliseconds instead of seconds.
   *
   * WHAT CHANGED AND WHY. It used to run FOUR fetches strictly one after
   * another, so load time was their SUM (~3–7s, reported as "taking so much
   * time"). Two were Dhan calls that cannot even overlap — they share a
   * process-wide 1.5s-spaced gate (lib/dhan/quote-gate.ts) — and neither was
   * needed:
   *
   *  - POST /api/live/quote (196 symbols) contributed NOTHING visible. Its
   *    `rFactorBias` went into a field no JSX here ever read, and its
   *    `previousClose` sat behind a value the heatmap always supplied.
   *  - GET /api/heatmap supplied LTP, previous close and % change — all three
   *    of which TradeFinder's own all_sector payload already carries
   *    (param_0/param_1/param_2), so we were asking a broker for numbers TF
   *    had already handed us. It also supplied `turnover`, used for nothing
   *    but treemap tile SIZE; TF's payload has no turnover at all (verified
   *    against two real captures, 2026-08-10 — every leaf is exactly
   *    Symbol + param_0..param_3), so sizing tiles by it was our invention and
   *    never made this page match theirs. Tiles are equal-sized now.
   *
   * The trade-off, stated plainly: this page is now exactly as fresh as the
   * last successful /tf capture and no fresher. When TradeFinder signs the
   * session out mid-day (as it did at 12:10 IST on 2026-08-10) these numbers
   * FREEZE rather than falling back to live Dhan prices. That is intended —
   * matching TradeFinder is the point of the page — which is why the capture
   * time is shown prominently and turns amber once stale, instead of a frozen
   * board quietly passing for a live one.
   *
   * NOTE for whoever edits this next: dropping the /api/live/quote call also
   * dropped its side effects (intraday OI recording, universe enrollment,
   * breakout context) from THIS page. They still run every ~5 min during market
   * hours via the Fyers poller's scanner pass (lib/trade-suggest/engine.ts
   * calls the same route with fresh:true) and from /live whenever it's open —
   * this page was never their only source.
   */
  const fetchOnce = useCallback(async (): Promise<ScopeData | null> => {
    setRefreshing(true);
    setNow(Date.now());
    try {
      const [indexPayload, tfRFactor] = await Promise.all([
        fetch('/api/sector-scope/indices', { cache: 'no-store' })
          .then(async (r) => ((await r.json()) as IndexResponse))
          .then((p) => (p.success ? p : null))
          .catch(() => null),
        fetch('/api/tf/rfactor-map', { cache: 'no-store' })
          .then(async (r) => ((await r.json()) as TfRFactorResponse))
          .then((p) => (p.success ? p : null))
          .catch(() => null),
      ]);

      // The bar chart and the stock grid come from two different TF endpoints
      // (daily-index vs all_sector) — one missing must never blank the other.
      if (indexPayload) {
        setIndexValues(indexPayload.values ?? {});
        setIndexCapturedAt(indexPayload.capturedAt ?? null);
      }

      if (!tfRFactor) throw new Error('Could not read the TradeFinder capture — check /tf.');

      const tfBySymbol = tfRFactor.values ?? {};
      const rows = ALL_SYMBOLS.map((symbol) => {
        const tf = tfBySymbol[symbol];
        return {
          symbol,
          ltp: tf?.ltp ?? null,
          previousClose: tf?.previousClose ?? null,
          changePctPrevClose: tf?.pctChange ?? null,
          rFactor: tf?.rFactor ?? null,
        } satisfies ScopeRow;
      });

      if (!rows.some((row) => row.changePctPrevClose != null)) {
        throw new Error('No TradeFinder capture yet — paste a fresh "Copy as cURL" on /tf to start capturing.');
      }

      const next = { rows, tfCapturedAt: tfRFactor.capturedAt ?? null } satisfies ScopeData;
      setData(next);
      setError(null);

      // ONLY NOW go looking for tile sizes, and rarely.
      //
      // /api/heatmap is a Dhan call behind the process-wide 1.5s quote gate,
      // measured at 1.0–8.6s against the real dev server (2026-08-10) versus
      // 36–45ms for the two TF reads above. Two consequences, both real:
      //
      //  1. Fired alongside them — even unawaited — it competed for the same
      //     server and browser connections, which is why the network trace
      //     showed indices/rfactor-map inflated to ~3s. Starting it after the
      //     data is committed to state means it cannot delay the paint; the
      //     grid is already up as an even mesh and re-proportions when turnover
      //     lands.
      //  2. More seriously, it takes the SAME gate /live's quote polling needs.
      //     app/live/_lib/quote-scheduler.ts aborts any quote that exceeds
      //     FETCH_TIMEOUT_MS (8s), which the browser reports as "(canceled)" —
      //     observed live on 2026-08-10. A cosmetic tile size must never
      //     out-queue the trading page's quotes.
      //
      // So it runs at most once per HEATMAP_MIN_INTERVAL_MS regardless of how
      // often the board refreshes. Traded value barely moves across ten
      // minutes, and it decides nothing but rectangle area.
      if (Date.now() - lastHeatmapAtRef.current > HEATMAP_MIN_INTERVAL_MS) {
        lastHeatmapAtRef.current = Date.now();
        void fetch('/api/heatmap', { cache: 'no-store' })
          .then(async (r) => ((await r.json()) as HeatmapResponse))
          .then((h) => {
            if (!h?.success || !h.tiles?.length) return;
            const sizes: Record<string, number> = {};
            for (const tile of h.tiles) sizes[tile.symbol] = tile.turnover;
            setTurnoverBySymbol(sizes);
          })
          .catch(() => undefined);
      }

      return next;
    } catch (fetchError) {
      setError((fetchError as Error).message);
      return null;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // 90s, matching the /tf browser relay's own RELOAD_INTERVAL_MS — there is no
  // point refreshing faster than TradeFinder's board is being captured, and no
  // point refreshing slower or the page lags a capture it already has. The old
  // interval branched on the heatmap's `marketOpen` flag (150s open / 900s
  // closed); it no longer needs to, because a refresh is now two indexed SQLite
  // reads rather than a broker call, so polling off-hours costs nothing worth
  // branching for.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      await fetchOnce();
      if (stopped) return;
      timer = setTimeout(tick, 90_000);
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
      // TradeFinder's own per-sector up/down split, shown above each card's
      // table exactly as their page does ("7 stocks (63.64% Up)"). A flat
      // zero counts as neither, matching how their bar reads.
      const up = priced.filter((row) => (row.changePctPrevClose ?? 0) > 0).length;
      const down = priced.filter((row) => (row.changePctPrevClose ?? 0) < 0).length;
      // Highest R-Factor first — the order TradeFinder's own table opens in.
      const ranked = [...rows].sort((a, b) => (b.rFactor ?? -1) - (a.rFactor ?? -1));
      const indexPct = indexValues[name];
      return {
        name,
        rows,
        ranked,
        priced,
        up,
        down,
        averagePct,
        chartPct: indexPct ?? null,
      };
    }),
    [bySymbol, indexValues],
  );

  const basketByName = useMemo(() => new Map(baskets.map((basket) => [basket.name, basket])), [baskets]);

  /**
   * Tiles sized by traded value, the same proportional look as /heatmap —
   * operator's call (2026-08-10), reversing an earlier equal-tile experiment
   * that flattened the grid and lost the at-a-glance sense of where the money
   * actually is.
   *
   * Until turnover arrives (it's fetched out of band, see `turnoverBySymbol`)
   * every tile falls back to 1, so the grid renders instantly as an even mesh
   * and then re-proportions. Never a blank or blocked treemap.
   */
  const layout = useMemo(() => {
    const visible = baskets.filter((basket) => basket.rows.length > 0);
    const weight = (symbol: string) => Math.max(1, turnoverBySymbol[symbol] ?? 1);
    const outer = squarifyOrdered(
      visible.map((basket) => ({
        id: basket.name,
        value: Math.max(1, basket.rows.reduce((total, row) => total + weight(row.symbol), 0)),
      })),
      0,
      0,
      W,
      H,
    );
    return outer.map((group) => {
      const basket = basketByName.get(group.id as (typeof GROUP_ORDER)[number])!;
      const inner: TreemapRect[] = group.w > PAD * 2 && group.h > HEADER + PAD * 2
        ? squarify(
            basket.rows.map((row) => ({ id: row.symbol, value: weight(row.symbol) })),
            group.x + PAD,
            group.y + HEADER,
            group.w - PAD * 2,
            group.h - HEADER - PAD,
          )
        : [];
      return { group, basket, stocks: inner.map((rect) => ({ rect, row: bySymbol.get(rect.id) })) };
    });
  }, [baskets, basketByName, bySymbol, turnoverBySymbol]);

  const chart = useMemo(
    () => baskets
      .flatMap((basket) => (basket.chartPct != null ? [{ ...basket, chartPct: basket.chartPct }] : []))
      .sort((a, b) => b.chartPct - a.chartPct),
    [baskets],
  );
  const chartBound = Math.max(0.5, ...chart.map((basket) => Math.abs(basket.chartPct)));

  /** How old the capture every number here comes from is. Beyond this the badge
   *  turns amber — the page can no longer be assumed to reflect the market,
   *  which is exactly the state that went unnoticed on 2026-08-10 when TF
   *  signed the session out at 12:10 and the board silently froze. */
  const STALE_AFTER_MIN = 10;
  const capturedAgeMin = now != null && data?.tfCapturedAt
    ? Math.floor((now - new Date(data.tfCapturedAt).getTime()) / 60_000)
    : null;
  const stale = capturedAgeMin != null && capturedAgeMin > STALE_AFTER_MIN;

  return (
    <div className="mx-auto max-w-7xl space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Grid3x3 className="size-5 text-primary" />
        <h1 className="text-lg font-bold text-foreground">Sector Scope</h1>
        {/* ONE freshness badge, because there is now only one source. It is the
            page's whole honesty mechanism: every number comes from this capture
            and is exactly this old. Amber past STALE_AFTER_MIN. */}
        {data && (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              stale
                ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
                : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
            }`}
            title={
              stale
                ? `Every number on this page is from TradeFinder's board captured ${capturedAgeMin} minutes ago, and nothing newer has arrived. If that keeps growing, the TradeFinder session has probably been signed out — check /tf.`
                : "Every number on this page is TradeFinder's own, from their most recently captured board."
            }
          >
            TF capture: {data.tfCapturedAt ? formatTfCapturedAt(data.tfCapturedAt) : 'none yet'}
            {stale ? ` · ${capturedAgeMin}m old` : ''}
          </span>
        )}
        <button
          type="button"
          onClick={() => void fetchOnce()}
          disabled={refreshing}
          className="ml-auto flex items-center gap-1 rounded-md bg-muted px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-70"
        >
          <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {stale && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-400">
          TradeFinder&rsquo;s board hasn&rsquo;t updated for {capturedAgeMin} minutes — these numbers are frozen, not live. If it stays
          stuck, their session has signed out; paste a fresh &quot;Copy as cURL&quot; on <a href="/tf" className="underline">/tf</a>.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        <span><b className="text-foreground">15 baskets · 196 stocks</b> — membership verified against TradeFinder&rsquo;s Sector Scope.</span>
        <span><b className="text-foreground">Every number is TradeFinder&rsquo;s own</b> — prev close, %, and R-Factor straight from their board.</span>
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
              /* Column set, order and sort match TradeFinder's own Sector Scope
                 cards (screenshot, 2026-08-10): Symbol · Pre C · % · R Fact ·
                 Signal, highest R-Factor first, under an up/down split bar.
                 Their table shows no LTP, so neither does this one — param_0 is
                 still captured and available, it just isn't what their board
                 puts in front of you. Density follows the Live Urgency table
                 (text-[10px], px-1.5 py-0.5) rather than a looser style of its
                 own. */
              <section key={basket.name} className="rounded-xl border border-border bg-card p-2.5">
                <div className="mb-1.5 flex items-baseline justify-between gap-2">
                  <h2 className="text-xs font-semibold text-foreground">{displayName(basket.name)}</h2>
                  <span className={`text-[11px] font-semibold tabular-nums ${basket.averagePct >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>{basket.averagePct >= 0 ? '+' : ''}{basket.averagePct.toFixed(2)}%</span>
                </div>

                {/* TradeFinder's up/down split bar. Widths are the share of
                    PRICED stocks each way, so a card with missing prices can't
                    show a bar that implies more coverage than it has. */}
                {basket.priced.length > 0 && (
                  <>
                    <div className="mb-1 flex h-1 overflow-hidden rounded-full bg-muted">
                      <div className="bg-emerald-500" style={{ width: `${(basket.up / basket.priced.length) * 100}%` }} />
                      <div className="bg-red-400" style={{ width: `${(basket.down / basket.priced.length) * 100}%` }} />
                    </div>
                    <div className="mb-1.5 flex justify-between text-[9px] text-muted-foreground tabular-nums">
                      <span className="text-emerald-600 dark:text-emerald-400">{basket.up} up ({((basket.up / basket.priced.length) * 100).toFixed(1)}%)</span>
                      <span className="text-red-500 dark:text-red-400">{basket.down} down ({((basket.down / basket.priced.length) * 100).toFixed(1)}%)</span>
                    </div>
                  </>
                )}

                <div className="max-h-72 overflow-auto">
                  <table className="w-full text-[10px]">
                    <thead className="sticky top-0 bg-card text-muted-foreground">
                      <tr className="border-b border-border text-[9px] font-semibold uppercase tracking-wider">
                        <th className="px-1.5 py-1 text-left">Symbol</th>
                        <th className="px-1.5 py-1 text-right">Pre C</th>
                        <th className="px-1.5 py-1 text-right">%</th>
                        <th className="px-1.5 py-1 text-right" title="TradeFinder's own R-Factor (param_3) from their most recent captured board — not our estimate of it.">R Fact</th>
                        <th className="px-1.5 py-1 text-right">Sig</th>
                      </tr>
                    </thead>
                    <tbody>
                      {basket.ranked.map((row) => {
                        const pct = row.changePctPrevClose;
                        const pctCls = pct == null ? 'text-muted-foreground' : pct >= 0 ? 'text-emerald-500' : 'text-red-400';
                        return (
                          <tr key={row.symbol} className="border-b border-border/60">
                            <td className="px-1.5 py-0.5 font-medium text-foreground">{row.symbol}</td>
                            <td className="px-1.5 py-0.5 text-right tabular-nums text-muted-foreground">{formatPrice(row.previousClose)}</td>
                            <td className={`px-1.5 py-0.5 text-right font-medium tabular-nums ${pctCls}`}>{pct == null ? '—' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}`}</td>
                            <td className="px-1.5 py-0.5 text-right font-semibold tabular-nums text-violet-600 dark:text-violet-400">{row.rFactor?.toFixed(2) ?? '—'}</td>
                            {/* Direction only — the same arrow TradeFinder shows,
                                which tracks the sign of the day's move. It is NOT
                                a trade signal and must not be read as one. */}
                            <td className={`px-1.5 py-0.5 text-right ${pctCls}`}>{pct == null ? '—' : pct >= 0 ? '▲' : '▼'}</td>
                          </tr>
                        );
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
