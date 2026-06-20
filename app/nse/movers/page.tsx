'use client';

import { Flame, Loader2, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ActiveStock, MoverStock, NsePulse, OiStock, WeekHighStock } from '@/lib/nse/pulse';
import { MarketStatusStrip } from '@/app/nse/_components/market-status-strip';
import { fmtCr, fmtNum, fmtPct, pctClass } from '@/app/nse/_lib/heat';

type PulseResponse = { success: boolean; error?: string } & Partial<NsePulse>;

// Poll fast while the market is OPEN (these feeds tick live); slow when CLOSED —
// the data is the static last session, so frequent polls would just burn NSE's
// (unpublished) rate budget. One pulse refresh = ~7 upstream NSE calls.
const POLL_OPEN_MS = 60_000;
const POLL_CLOSED_MS = 300_000;

const MOVER_GROUPS = [
  { id: 'allSec', label: 'All' },
  { id: 'FOSec', label: 'F&O' },
  { id: 'NIFTY', label: 'Nifty 50' },
] as const;

/** Card wrapper (module-level so it isn't re-created each render). */
function Panel({
  title,
  icon,
  right,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-1">
        <h2 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-foreground">
          {icon}
          {title}
        </h2>
        {right}
      </div>
      {children}
    </div>
  );
}

function Empty() {
  return <div className="px-3 py-5 text-center text-[11px] text-muted-foreground">No data right now.</div>;
}

/** Dense stock row: rank · symbol · secondary value · signed %. */
function Row({
  i,
  symbol,
  value,
  pct,
  pctSuffix = '',
}: {
  i: number;
  symbol: string;
  value: string;
  pct: number;
  pctSuffix?: string;
}) {
  return (
    <div className="flex items-center gap-1.5 border-b border-border/30 px-2 py-[3px] text-[11px]">
      <span className="w-4 shrink-0 text-right text-[9px] tabular-nums text-muted-foreground">{i + 1}</span>
      <span className="flex-1 truncate font-mono font-medium">{symbol}</span>
      <span className="tabular-nums text-muted-foreground">{value}</span>
      <span className={`w-[58px] shrink-0 text-right font-semibold tabular-nums ${pctClass(pct)}`}>
        {fmtPct(pct)}
        {pctSuffix}
      </span>
    </div>
  );
}

export default function NseMoversPage() {
  const [data, setData] = useState<PulseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState<(typeof MOVER_GROUPS)[number]['id']>('FOSec');
  const [activeBy, setActiveBy] = useState<'value' | 'volume'>('value');

  const fetchOnce = useCallback(async (): Promise<PulseResponse | null> => {
    try {
      const res = await fetch('/api/nse/pulse');
      const d = (await res.json()) as PulseResponse;
      if (d.success) {
        setData(d);
        setError(null);
        return d;
      }
      setError(d.error ?? 'Failed to load NSE market data');
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
      const open = d?.marketStatus ? /open/i.test(d.marketStatus.status) : false;
      timer = setTimeout(tick, open ? POLL_OPEN_MS : POLL_CLOSED_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchOnce]);

  const gainers: MoverStock[] = data?.gainers?.[group] ?? [];
  const losers: MoverStock[] = data?.losers?.[group] ?? [];
  const active: ActiveStock[] = (activeBy === 'value' ? data?.mostActiveValue : data?.mostActiveVolume) ?? [];
  const oi: OiStock[] = data?.oiSpurts ?? [];
  const highs: WeekHighStock[] = data?.week52High ?? [];
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
          title="Live market activity from NSE's public feeds — OI build-up, most active, gainers/losers, 52-week highs."
        >
          Official NSE
        </span>
        <button
          type="button"
          onClick={() => void fetchOnce()}
          className="ml-auto flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      <MarketStatusStrip status={data?.marketStatus ?? null} />

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-600 dark:text-red-400">
          {error} — NSE occasionally rate-limits server calls; hit Refresh in a moment.
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-border p-8 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          Loading NSE market data…
        </div>
      )}

      {data && (
        <>
          {/* 1 — F&O OI Build-up (biggest open-interest increases = fresh positions) */}
          <Panel
            title="F&O OI Build-up"
            icon={<TrendingUp className="h-3.5 w-3.5 text-violet-500" />}
            right={<span className="text-[9px] text-muted-foreground">{oi.length} F&O · top OI gains · price · OI%</span>}
          >
            {oiBuildup.length === 0 ? (
              <Empty />
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
                {oiBuildup.slice(0, 24).map((s, i) => (
                  <Row key={s.symbol} i={i} symbol={s.symbol} value={fmtNum(s.underlyingValue)} pct={s.changeInOiPct} />
                ))}
              </div>
            )}
          </Panel>

          {/* 2 — Most Active */}
          <Panel
            title="Most Active"
            icon={<Flame className="h-3.5 w-3.5 text-amber-500" />}
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
            {active.length === 0 ? (
              <Empty />
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
                {active.map((s, i) => (
                  <Row key={s.symbol} i={i} symbol={s.symbol} value={fmtCr(s.tradedValue)} pct={s.pctChange} />
                ))}
              </div>
            )}
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
            <Panel title="Top Gainers" icon={<TrendingUp className="h-3.5 w-3.5 text-emerald-500" />}>
              {gainers.length === 0 ? (
                <Empty />
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2">
                  {gainers.map((s, i) => (
                    <Row key={s.symbol} i={i} symbol={s.symbol} value={fmtNum(s.ltp)} pct={s.pctChange} />
                  ))}
                </div>
              )}
            </Panel>

            <Panel title="Top Losers" icon={<TrendingDown className="h-3.5 w-3.5 text-red-500" />}>
              {losers.length === 0 ? (
                <Empty />
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2">
                  {losers.map((s, i) => (
                    <Row key={s.symbol} i={i} symbol={s.symbol} value={fmtNum(s.ltp)} pct={s.pctChange} />
                  ))}
                </div>
              )}
            </Panel>
          </div>

          {/* 4 — 52-week highs */}
          <Panel title={`52-Week Highs (${highs.length})`} icon={<TrendingUp className="h-3.5 w-3.5 text-emerald-500" />}>
            {highs.length === 0 ? (
              <Empty />
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
                {highs.slice(0, 30).map((s, i) => (
                  <Row key={s.symbol} i={i} symbol={s.symbol} value={fmtNum(s.ltp)} pct={s.pctChange} />
                ))}
              </div>
            )}
          </Panel>

          <p className="text-[10px] text-muted-foreground">
            Live from NSE public feeds — no broker auth. Refreshes every {data?.marketStatus && /open/i.test(data.marketStatus.status) ? '60s while open' : '5 min (market closed — static last session)'}.
          </p>
        </>
      )}
    </div>
  );
}
