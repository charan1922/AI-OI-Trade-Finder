'use client';

import { Flame, Loader2, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type {
  ActiveStock,
  FeedKey,
  MarketStatus,
  MoverStock,
  OiStock,
} from '@/lib/nse/pulse';
import { MarketStatusStrip } from '@/app/nse/_components/market-status-strip';
import { fmtCr, fmtNum, fmtPct, pctClass } from '@/app/nse/_lib/heat';

// Poll fast while the market is OPEN (these feeds tick live); slower when CLOSED —
// the data is the static last session. Each feed runs its OWN timer at this cadence.
const POLL_OPEN_MS = 60_000;
const POLL_CLOSED_MS = 90_000;

// Gap between feed fetch *starts*. Firing all feeds at once trips NSE's burst
// throttle; staggering them ~350ms apart lets every feed succeed. Each feed's
// stagger index sets its initial delay so the browser never bursts NSE.
const FEED_STAGGER_MS = 350;

const MOVER_GROUPS = [
  { id: 'allSec', label: 'All' },
  { id: 'FOSec', label: 'F&O' },
  { id: 'NIFTY', label: 'Nifty 50' },
] as const;

type FeedResponse<T> = { success: boolean; data?: T; error?: string; stale?: boolean };

type Feed<T> = {
  data: T | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  stale: boolean;
  fetchedAt: number | null;
  refresh: () => Promise<void>;
};

/**
 * One independent NSE feed: own fetch, own cache freshness, own timer, own refresh.
 * `staggerIndex` offsets this feed's first fetch so all feeds don't burst NSE at once.
 */
function useNseFeed<T>(feed: FeedKey, intervalMs: number, staggerIndex: number): Feed<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);

  const fetchOnce = useCallback(async () => {
    try {
      const res = await fetch(`/api/nse/pulse/${feed}`);
      const j = (await res.json()) as FeedResponse<T>;
      if (j.success && j.data !== undefined) {
        setData(j.data);
        setStale(!!j.stale);
        setFetchedAt(Date.now());
        setError(null);
      } else {
        setError(j.error ?? 'Failed to load');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [feed]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchOnce();
    } finally {
      setRefreshing(false);
    }
  }, [fetchOnce]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (delay: number) => {
      timer = setTimeout(async () => {
        if (stopped) return;
        await fetchOnce();
        if (stopped) return;
        schedule(intervalMs);
      }, delay);
    };
    schedule(staggerIndex * FEED_STAGGER_MS); // staggered first fetch, then steady cadence
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [fetchOnce, intervalMs, staggerIndex]);

  return { data, loading, refreshing, error, stale, fetchedAt, refresh };
}

const fmtTime = (ts: number | null) =>
  ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

/** Card wrapper with a self-contained header: refresh button, spinner, last-fetched time, stale badge. */
function Panel({
  title,
  icon,
  right,
  feed,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  right?: React.ReactNode;
  feed: Pick<Feed<unknown>, 'refreshing' | 'stale' | 'fetchedAt' | 'refresh'>;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-1">
        <h2 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-foreground">
          {icon}
          {title}
        </h2>
        <div className="flex items-center gap-1.5">
          {right}
          {feed.stale && (
            <span
              className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400"
              title="NSE briefly throttled this feed — showing its last good data."
            >
              cached
            </span>
          )}
          <span className="text-[9px] tabular-nums text-muted-foreground" title="When this feed was last fetched">
            {fmtTime(feed.fetchedAt)}
          </span>
          <button
            type="button"
            onClick={() => void feed.refresh()}
            disabled={feed.refreshing}
            title="Refresh this feed"
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-70"
          >
            <RefreshCw className={`h-3 w-3 ${feed.refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}

/** Per-panel body state: loader on first load, error inline, empty fallback, else children. */
function PanelBody({
  loading,
  error,
  empty,
  children,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  children: React.ReactNode;
}) {
  if (error && empty) {
    return <div className="px-3 py-4 text-center text-[11px] text-red-600 dark:text-red-400">{error}</div>;
  }
  if (loading && empty) {
    return (
      <div className="flex items-center justify-center gap-2 px-3 py-4 text-[11px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        Loading…
      </div>
    );
  }
  if (empty) {
    return <div className="px-3 py-5 text-center text-[11px] text-muted-foreground">No data right now.</div>;
  }
  return <>{children}</>;
}

/** Dense stock row: rank · symbol · secondary value · signed %. */
function Row({
  i,
  symbol,
  value,
  pct,
}: {
  i: number;
  symbol: string;
  value: string;
  pct: number;
}) {
  return (
    <div className="flex items-center gap-1.5 border-b border-border/30 px-2 py-[3px] text-[11px]">
      <span className="w-4 shrink-0 text-right text-[9px] tabular-nums text-muted-foreground">{i + 1}</span>
      <span className="flex-1 truncate font-mono font-medium">{symbol}</span>
      <span className="tabular-nums text-muted-foreground">{value}</span>
      <span className={`w-[58px] shrink-0 text-right font-semibold tabular-nums ${pctClass(pct)}`}>{fmtPct(pct)}</span>
    </div>
  );
}

export default function NseMoversPage() {
  const [group, setGroup] = useState<(typeof MOVER_GROUPS)[number]['id']>('FOSec');
  const [activeBy, setActiveBy] = useState<'value' | 'volume'>('value');

  // Market status drives the poll cadence for every other feed.
  const statusFeed = useNseFeed<MarketStatus>('marketStatus', POLL_CLOSED_MS, 0);
  const open = statusFeed.data ? /open/i.test(statusFeed.data.status) : false;
  const pollMs = open ? POLL_OPEN_MS : POLL_CLOSED_MS;

  // Each feed is independent: own cache, own timer, own refresh — staggered to dodge NSE's burst throttle.
  const oiFeed = useNseFeed<OiStock[]>('oiSpurts', pollMs, 1);
  const mavFeed = useNseFeed<ActiveStock[]>('mostActiveValue', pollMs, 2);
  const mvolFeed = useNseFeed<ActiveStock[]>('mostActiveVolume', pollMs, 3);
  const gainersFeed = useNseFeed<Record<string, MoverStock[]>>('gainers', pollMs, 4);
  const losersFeed = useNseFeed<Record<string, MoverStock[]>>('losers', pollMs, 5);

  const allFeeds = [statusFeed, oiFeed, mavFeed, mvolFeed, gainersFeed, losersFeed];
  const [refreshingAll, setRefreshingAll] = useState(false);

  const refreshAll = async () => {
    setRefreshingAll(true);
    try {
      // Stagger the starts so we refresh everything without bursting NSE.
      allFeeds.forEach((f, i) => {
        setTimeout(() => void f.refresh(), i * FEED_STAGGER_MS);
      });
      await new Promise((r) => setTimeout(r, allFeeds.length * FEED_STAGGER_MS));
    } finally {
      setRefreshingAll(false);
    }
  };

  const gainers = gainersFeed.data?.[group] ?? [];
  const losers = losersFeed.data?.[group] ?? [];
  const activeFeed = activeBy === 'value' ? mavFeed : mvolFeed;
  const active = activeFeed.data ?? [];
  const oi = oiFeed.data ?? [];
  const oiBuildup = [...oi].sort((a, b) => b.changeInOiPct - a.changeInOiPct);

  const segCls = (on: boolean) =>
    `rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
      on ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
    }`;

  return (
    <div className="mx-auto max-w-7xl space-y-2 p-3">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <Flame className="h-5 w-5 text-primary" />
        <h1 className="text-base font-bold text-foreground">NSE Market Movers</h1>
        <span
          className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"
          title="Live market activity from NSE's public feeds — OI build-up, most active, gainers/losers."
        >
          Official NSE
        </span>
        <button
          type="button"
          onClick={() => void refreshAll()}
          disabled={refreshingAll}
          className="ml-auto flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-70"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshingAll ? 'animate-spin' : ''}`} />
          Refresh all
        </button>
      </div>

      <MarketStatusStrip status={statusFeed.data ?? null} />

      {/* 1 — F&O OI Build-up (biggest open-interest increases = fresh positions) */}
      <Panel
        title="F&O OI Build-up"
        icon={<TrendingUp className="h-3.5 w-3.5 text-violet-500" />}
        feed={oiFeed}
        right={<span className="text-[9px] text-muted-foreground">{oi.length} F&O · top OI gains</span>}
      >
        <PanelBody loading={oiFeed.loading} error={oiFeed.error} empty={oiBuildup.length === 0}>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
            {oiBuildup.slice(0, 24).map((s, i) => (
              <Row key={s.symbol} i={i} symbol={s.symbol} value={fmtNum(s.underlyingValue)} pct={s.changeInOiPct} />
            ))}
          </div>
        </PanelBody>
      </Panel>

      {/* 2 — Most Active */}
      <Panel
        title="Most Active"
        icon={<Flame className="h-3.5 w-3.5 text-amber-500" />}
        feed={activeFeed}
        right={
          <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
            <button type="button" onClick={() => setActiveBy('value')} className={segCls(activeBy === 'value')}>
              Value
            </button>
            <button type="button" onClick={() => setActiveBy('volume')} className={segCls(activeBy === 'volume')}>
              Volume
            </button>
          </div>
        }
      >
        <PanelBody loading={activeFeed.loading} error={activeFeed.error} empty={active.length === 0}>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
            {active.map((s, i) => (
              <Row key={s.symbol} i={i} symbol={s.symbol} value={fmtCr(s.tradedValue)} pct={s.pctChange} />
            ))}
          </div>
        </PanelBody>
      </Panel>

      {/* 3 — Gainers / Losers (with universe toggle) */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">Universe:</span>
        <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
          {MOVER_GROUPS.map((g) => (
            <button key={g.id} type="button" onClick={() => setGroup(g.id)} className={segCls(group === g.id)}>
              {g.label}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-muted-foreground">NSE caps these at ~20 per list</span>
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        <Panel title="Top Gainers" icon={<TrendingUp className="h-3.5 w-3.5 text-emerald-500" />} feed={gainersFeed}>
          <PanelBody loading={gainersFeed.loading} error={gainersFeed.error} empty={gainers.length === 0}>
            <div className="grid grid-cols-1 sm:grid-cols-2">
              {gainers.map((s, i) => (
                <Row key={s.symbol} i={i} symbol={s.symbol} value={fmtNum(s.ltp)} pct={s.pctChange} />
              ))}
            </div>
          </PanelBody>
        </Panel>

        <Panel title="Top Losers" icon={<TrendingDown className="h-3.5 w-3.5 text-red-500" />} feed={losersFeed}>
          <PanelBody loading={losersFeed.loading} error={losersFeed.error} empty={losers.length === 0}>
            <div className="grid grid-cols-1 sm:grid-cols-2">
              {losers.map((s, i) => (
                <Row key={s.symbol} i={i} symbol={s.symbol} value={fmtNum(s.ltp)} pct={s.pctChange} />
              ))}
            </div>
          </PanelBody>
        </Panel>
      </div>

      <p className="text-[10px] text-muted-foreground">
        Live from NSE public feeds — no broker auth. Each panel refreshes on its own timer (every{' '}
        {open ? '60s while open' : '90s while closed'}) and shows its own last-fetched time. % is vs the previous close
        using <b className="text-foreground">last-traded price (LTP)</b> — the same basis as EOD Movers, so the two
        line up.
      </p>
    </div>
  );
}
