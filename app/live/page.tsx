'use client';

import { Gauge, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { HowToRead } from './_components/how-to-read';
import { UrgencyTable } from './_components/urgency-table';
import { useLiveUrgency } from './_hooks/use-live-urgency';
import type { SectorLeadersResponse, SectorPick, WatchlistSource } from './_lib/types';

// Grouped watchlist sources for the dropdown. Sector leaders come from the synced
// bhavcopy; NSE movers come from NSE's live pulse feeds (same as /nse/movers).
// Every source is gated server-side to F&O-only, non-'avoid' names.
const SOURCE_GROUPS: { group: string; options: { value: WatchlistSource; label: string }[] }[] = [
  {
    group: 'Sector leaders (bhavcopy)',
    options: [
      { value: 'sector-gainers', label: 'Sector winners' },
      { value: 'sector-losers', label: 'Sector losers' },
    ],
  },
  {
    group: 'NSE movers (live)',
    options: [
      { value: 'nse-oi', label: 'F&O OI build-up' },
      { value: 'nse-gainers', label: 'F&O top gainers' },
      { value: 'nse-losers', label: 'F&O top losers' },
      { value: 'nse-active-value', label: 'Most active (value)' },
      { value: 'nse-active-volume', label: 'Most active (volume)' },
      { value: 'nse-52wh', label: '52-week highs' },
    ],
  },
];

const SOURCE_LABEL = Object.fromEntries(
  SOURCE_GROUPS.flatMap((g) => g.options.map((o) => [o.value, o.label])),
) as Record<WatchlistSource, string>;

export default function LiveUrgencyPage() {
  // No hardcoded basket — the default watchlist is auto-picked sector leaders
  // (see the effect below); the user can overwrite it with any manual list.
  const [watchInput, setWatchInput] = useState('');
  const [applied, setApplied] = useState('');

  // Auto-pick state. Cleared when the user applies a manual list. autoLoading
  // starts true because the mount effect always auto-picks.
  const [source, setSource] = useState<WatchlistSource>('sector-gainers');
  const [autoPicks, setAutoPicks] = useState<SectorPick[] | null>(null);
  const [autoMeta, setAutoMeta] = useState<SectorLeadersResponse['meta'] | null>(null);
  const [autoLoading, setAutoLoading] = useState(true);
  const [autoError, setAutoError] = useState<string | null>(null);

  const symbols = useMemo(
    () =>
      applied
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    [applied],
  );

  const { rows, marketOpen, asOf, loading, error, excluded, refresh } = useLiveUrgency(symbols);

  const applyManual = (text: string) => {
    setApplied(text);
    setAutoPicks(null);
    setAutoMeta(null);
    setAutoError(null);
  };

  // Pure fetch — no setState, so the mount effect below stays free of
  // synchronous setState (react-hooks/set-state-in-effect). Sector sources hit
  // the bhavcopy ranker; NSE sources hit the live pulse feeds. Both return the
  // same shape and are gated to F&O-only, non-'avoid' names server-side.
  const fetchWatchlist = async (src: WatchlistSource): Promise<SectorLeadersResponse> => {
    try {
      const url = src.startsWith('sector-')
        ? `/api/live/sector-leaders?basis=${src === 'sector-losers' ? 'losers' : 'gainers'}&perSector=2`
        : `/api/live/nse-watchlist?source=${src}`;
      const res = await fetch(url);
      return (await res.json()) as SectorLeadersResponse;
    } catch (e) {
      return { success: false, picks: [], error: (e as Error).message };
    }
  };

  const applyPicks = (d: SectorLeadersResponse) => {
    if (!d.success) {
      setAutoError(`Couldn't build the watchlist: ${d.error ?? 'unknown error'}`);
      return;
    }
    if (d.picks.length === 0) {
      // Honest empty state — e.g. an equity-wide NSE feed whose current names are
      // all non-F&O or in the 'avoid' band. Clear the list and say why.
      setWatchInput('');
      setApplied('');
      setAutoPicks(null);
      setAutoMeta(null);
      setAutoError('No tradeable F&O names in this source right now — every candidate was non-F&O or in the ‘avoid’ band. Try another source.');
      return;
    }
    const list = d.picks.map((p) => p.symbol).join(', ');
    setWatchInput(list);
    setApplied(list);
    setAutoPicks(d.picks);
    setAutoMeta(d.meta ?? null);
    setAutoError(null);
  };

  const autoPick = async (src: WatchlistSource) => {
    setAutoLoading(true);
    applyPicks(await fetchWatchlist(src));
    setAutoLoading(false);
  };

  // Manual refresh: rebuild the auto-picked watchlist from the current source
  // (so freshly-entered movers appear), then immediately re-poll live quotes.
  // A manually-typed list is left as-is — only the live quotes refresh.
  const handleRefresh = () => {
    if (autoPicks !== null) void autoPick(source);
    void refresh();
  };

  // Symbol → sector for the table tag (only known when auto-picked).
  const sectorBySymbol = useMemo(() => {
    if (!autoPicks) return undefined;
    return Object.fromEntries(autoPicks.map((p) => [p.symbol, p.sector]));
  }, [autoPicks]);

  // Default watchlist = sector leaders, built once on mount (setState only in
  // the async callback). If it fails (e.g. bhavcopy not synced) the error
  // banner shows and the user can type a manual list.
  useEffect(() => {
    let ignore = false;
    fetchWatchlist('sector-gainers').then((d) => {
      if (ignore) return;
      applyPicks(d);
      setAutoLoading(false);
    });
    return () => {
      ignore = true;
    };
  }, []);

  // Warm the NSE pulse feeds (shared 30s server cache) in the background so the
  // NSE-movers dropdown sources build instantly instead of cold-missing into a
  // ~9s NSE timeout (the 502 the user hit). Fire-and-forget, staggered to stay
  // under NSE's burst throttle. One successful warm per feed is enough — the
  // cache then serves stale on any later failure, so it never hard-fails again.
  useEffect(() => {
    const feeds = ['oiSpurts', 'gainers', 'losers', 'mostActiveValue', 'mostActiveVolume', 'week52High'];
    const timers = feeds.map((f, i) =>
      setTimeout(() => {
        void fetch(`/api/nse/pulse/${f}`).catch(() => {});
      }, i * 400),
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  // Latest-ref so the 60s interval below never resets / goes stale.
  const autoRefreshRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    autoRefreshRef.current = () => {
      if (autoPicks !== null && !autoLoading) void autoPick(source);
    };
  });

  // Auto-refresh the auto-picked watchlist every minute so live NSE movers stay
  // current. (Sector-leader sources are EOD bhavcopy — no intraday change, so
  // this is a harmless no-op there.) The quote table itself already re-polls
  // every 4s; this refreshes WHICH stocks are listed.
  useEffect(() => {
    const id = setInterval(() => autoRefreshRef.current?.(), 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="mx-auto max-w-7xl space-y-2 p-3">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <Gauge className="h-4 w-4 text-primary" />
          <h1 className="text-base font-bold text-foreground">Live Urgency</h1>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            real-time depth · Dhan quote
          </span>
        </div>
        {marketOpen === true && (
          <span className="flex items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> Market open
          </span>
        )}
        {marketOpen === false && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            Market closed
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {asOf && (
            <span className="text-[10px] text-muted-foreground">
              updated {new Date(asOf).toLocaleTimeString('en-IN', { hour12: false })}
            </span>
          )}
          <HowToRead />
          <button
            type="button"
            onClick={handleRefresh}
            disabled={loading || autoLoading}
            title="Rebuild the watchlist from the current source and re-poll live quotes"
            className="flex items-center gap-1 rounded-md bg-muted px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading || autoLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Watchlist editor */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={watchInput}
          onChange={(e) => setWatchInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyManual(watchInput);
          }}
          placeholder="Comma-separated F&O symbols…"
          className="min-w-[320px] flex-1 rounded-md border border-border bg-card px-2.5 py-1 text-xs text-foreground focus:border-primary focus:outline-none"
        />
        <button
          type="button"
          onClick={() => applyManual(watchInput)}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
        >
          Apply ({symbols.length})
        </button>
        <span className="text-[11px] text-muted-foreground/60">or</span>
        <div
          className="flex items-center gap-1.5"
          title="Builds the watchlist from the chosen source — bhavcopy sector leaders or a live NSE movers feed. Always F&O-only, excluding the 'avoid' lot-size band and names without a live future. Max 25 stocks."
        >
          <button
            type="button"
            onClick={() => autoPick(source)}
            disabled={autoLoading}
            className="flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/15 disabled:opacity-50"
          >
            {autoLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Build watchlist
          </button>
          <select
            value={source}
            onChange={(e) => {
              // Changing the source rebuilds the watchlist immediately — no need
              // to also click "Build watchlist" (that's now just a manual refresh).
              const next = e.target.value as WatchlistSource;
              setSource(next);
              void autoPick(next);
            }}
            disabled={autoLoading}
            className="rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground focus:border-primary focus:outline-none disabled:opacity-50"
            title="Sector winners/losers = per-sector leaders from bhavcopy · NSE movers = live feeds from /nse/movers (OI build-up, gainers, losers, most active, 52-week highs). Changing this rebuilds the list."
          >
            {SOURCE_GROUPS.map((g) => (
              <optgroup key={g.group} label={g.group}>
                {g.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      </div>

      {autoError && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          {autoError}
        </div>
      )}

      {/* What the auto-pick selected, grouped by sector — so the list explains itself */}
      {autoPicks && autoPicks.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-2">
          <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-[10px] text-muted-foreground">
            <span className="font-bold uppercase tracking-wide">Auto-picked: {SOURCE_LABEL[source]}</span>
            {autoMeta && (
              <span>
                {autoMeta.returnWindow
                  ? `5-session return ${autoMeta.returnWindow.from} → ${autoMeta.returnWindow.to} · liquidity ≥ ₹${autoMeta.liquidityFloorCr} Cr/day`
                  : 'live F&O movers from NSE'}{' '}
                · {autoMeta.sectorsCovered} sectors
                {autoMeta.excludedAvoid ? ` · ${autoMeta.excludedAvoid} avoid-band removed` : ''} · F&O only, re-click to
                refresh
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {autoPicks.map((p) => (
              <span
                key={p.symbol}
                title={`${p.sector} · ${p.retPct >= 0 ? '+' : ''}${p.retPct.toFixed(2)}%${p.avgFutTurnoverCr ? ` · ₹${p.avgFutTurnoverCr.toFixed(0)} Cr/day avg futures turnover` : ''}`}
                className="inline-flex cursor-help items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px]"
              >
                <span className="text-muted-foreground/60">{p.sector}</span>
                <span className="font-semibold text-foreground">{p.symbol}</span>
                <span className={p.retPct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                  {p.retPct >= 0 ? '+' : ''}
                  {p.retPct.toFixed(1)}%
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Names the watchlist asked for but Live Urgency won't show — F&O-only, no 'avoid' band */}
      {excluded.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          <b>Hidden (F&amp;O-only, no &lsquo;avoid&rsquo; band):</b>{' '}
          {excluded.map((e) => `${e.symbol} (${e.reason})`).join(', ')}
        </div>
      )}

      {/* What the signals mean — plain English, compact single strip */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-muted/30 px-2.5 py-1.5 text-[10px] leading-snug text-muted-foreground">
        <span className="font-bold uppercase tracking-wide text-foreground">How to read</span>
        <span>
          <b className="text-foreground">Spread</b> = cost (tight = cheap)
        </span>
        <span>
          <b className="text-foreground">Bid/Ask</b> = who&apos;s pushing (buyers vs sellers)
        </span>
        <span>
          <b className="text-foreground">OI level</b> = conviction (high = big players in)
        </span>
        <span>
          <b className="text-foreground">Turnover</b> = is it real? (high = real money)
        </span>
        <span className="text-muted-foreground/70">· big players hide size, so this is a partial view</span>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {marketOpen === false ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
          The market is closed (NSE 9:15–15:30 IST, weekdays). The order book — and therefore the live spread /
          imbalance — only exists during market hours, so nothing is shown rather than a fabricated snapshot.
        </div>
      ) : marketOpen === null && (loading || autoLoading) ? (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-border p-6 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          {autoLoading ? 'Building watchlist…' : 'Connecting to the live quote feed…'}
        </div>
      ) : (
        <UrgencyTable rows={rows} sectors={sectorBySymbol} />
      )}
    </div>
  );
}
