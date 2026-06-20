'use client';

import { Flame, Loader2, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ActiveStock, MoverStock, NsePulse, OiStock, WeekHighStock } from '@/lib/nse/pulse';
import { MarketStatusStrip } from '@/app/nse/_components/market-status-strip';
import { fmtCr, fmtNum, fmtPct, pctClass } from '@/app/nse/_lib/heat';

type PulseResponse = { success: boolean; error?: string } & Partial<NsePulse>;

const POLL_MS = 60_000;
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
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-foreground">
          {icon}
          {title}
        </h2>
        {right}
      </div>
      <div className="divide-y divide-border/50">{children}</div>
    </div>
  );
}

function Empty() {
  return <div className="px-3 py-6 text-center text-xs text-muted-foreground">No data right now.</div>;
}

export default function NseMoversPage() {
  const [data, setData] = useState<PulseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState<(typeof MOVER_GROUPS)[number]['id']>('FOSec');
  const [activeBy, setActiveBy] = useState<'value' | 'volume'>('value');

  const fetchOnce = useCallback(async () => {
    try {
      const res = await fetch('/api/nse/pulse');
      const d = (await res.json()) as PulseResponse;
      if (d.success) {
        setData(d);
        setError(null);
      } else {
        setError(d.error ?? 'Failed to load NSE market data');
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

  const gainers: MoverStock[] = data?.gainers?.[group] ?? [];
  const losers: MoverStock[] = data?.losers?.[group] ?? [];
  const active: ActiveStock[] = (activeBy === 'value' ? data?.mostActiveValue : data?.mostActiveVolume) ?? [];
  const oi: OiStock[] = data?.oiSpurts ?? [];
  const highs: WeekHighStock[] = data?.week52High ?? [];

  const segCls = (on: boolean) =>
    `rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
      on ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
    }`;

  return (
    <div className="mx-auto max-w-7xl space-y-3 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <Flame className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-bold text-foreground">NSE Market Movers</h1>
        <span
          className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"
          title="Live market activity from NSE's public feeds — gainers, losers, most active, OI build-up, 52-week highs."
        >
          Official NSE
        </span>
        <button
          type="button"
          onClick={() => void fetchOnce()}
          className="ml-auto flex items-center gap-1 rounded-md bg-muted px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-accent"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      <MarketStatusStrip status={data?.marketStatus ?? null} />

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
          Loading NSE market data…
        </div>
      )}

      {data && (
        <>
          {/* F&O OI Build-up — biggest open-interest increases (fresh F&O positions). Shown first. */}
          <Panel
            title="F&O OI Build-up"
            icon={<TrendingUp className="h-3.5 w-3.5 text-violet-500" />}
            right={<span className="text-[10px] text-muted-foreground">{oi.length} F&O underlyings · top OI gains</span>}
          >
            {oi.length === 0 ? (
              <Empty />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2">
                {[...oi]
                  .sort((a, b) => b.changeInOiPct - a.changeInOiPct)
                  .slice(0, 20)
                  .map((s, i) => (
                    <div
                      key={s.symbol}
                      className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 text-xs"
                    >
                      <span className="w-4 text-right text-[10px] tabular-nums text-muted-foreground">{i + 1}</span>
                      <span className="flex-1 truncate font-mono font-medium">{s.symbol}</span>
                      <span className="tabular-nums text-muted-foreground">{fmtNum(s.underlyingValue)}</span>
                      <span className={`w-20 text-right font-semibold tabular-nums ${pctClass(s.changeInOiPct)}`}>
                        {fmtPct(s.changeInOiPct)} OI
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </Panel>

          {/* Group toggle for gainers/losers */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">Universe:</span>
            <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
              {MOVER_GROUPS.map((g) => (
                <button key={g.id} type="button" onClick={() => setGroup(g.id)} className={segCls(group === g.id)}>
                  {g.label}
                </button>
              ))}
            </div>
            <span className="text-[10px] text-muted-foreground">top movers are capped at ~20 per list by NSE</span>
          </div>

          {/* Gainers / Losers */}
          <div className="grid gap-3 md:grid-cols-2">
            <Panel title="Top Gainers" icon={<TrendingUp className="h-3.5 w-3.5 text-emerald-500" />}>
              {gainers.length === 0 ? (
                <Empty />
              ) : (
                gainers.map((s, i) => (
                  <div key={s.symbol} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <span className="w-4 text-right text-[10px] tabular-nums text-muted-foreground">{i + 1}</span>
                    <span className="flex-1 truncate font-mono font-medium">{s.symbol}</span>
                    <span className="tabular-nums text-muted-foreground">{fmtNum(s.ltp)}</span>
                    <span className={`w-16 text-right font-semibold tabular-nums ${pctClass(s.pctChange)}`}>
                      {fmtPct(s.pctChange)}
                    </span>
                  </div>
                ))
              )}
            </Panel>

            <Panel title="Top Losers" icon={<TrendingDown className="h-3.5 w-3.5 text-red-500" />}>
              {losers.length === 0 ? (
                <Empty />
              ) : (
                losers.map((s, i) => (
                  <div key={s.symbol} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    <span className="w-4 text-right text-[10px] tabular-nums text-muted-foreground">{i + 1}</span>
                    <span className="flex-1 truncate font-mono font-medium">{s.symbol}</span>
                    <span className="tabular-nums text-muted-foreground">{fmtNum(s.ltp)}</span>
                    <span className={`w-16 text-right font-semibold tabular-nums ${pctClass(s.pctChange)}`}>
                      {fmtPct(s.pctChange)}
                    </span>
                  </div>
                ))
              )}
            </Panel>
          </div>

          {/* Most Active (full width — OI moved to the top) */}
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
              <div className="grid grid-cols-1 sm:grid-cols-2">
                {active.map((s, i) => (
                  <div
                    key={s.symbol}
                    className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 text-xs"
                  >
                    <span className="w-4 text-right text-[10px] tabular-nums text-muted-foreground">{i + 1}</span>
                    <span className="flex-1 truncate font-mono font-medium">{s.symbol}</span>
                    <span className="tabular-nums text-muted-foreground">{fmtCr(s.tradedValue)}</span>
                    <span className={`w-16 text-right font-semibold tabular-nums ${pctClass(s.pctChange)}`}>
                      {fmtPct(s.pctChange)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {/* 52-week highs */}
          <Panel title={`52-Week Highs (${highs.length})`} icon={<TrendingUp className="h-3.5 w-3.5 text-emerald-500" />}>
            {highs.length === 0 ? (
              <Empty />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {highs.slice(0, 30).map((s) => (
                  <div key={s.symbol} className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 text-xs">
                    <span className="w-20 shrink-0 truncate font-mono font-medium">{s.symbol}</span>
                    <span className="flex-1 truncate text-[10px] text-muted-foreground">{s.company}</span>
                    <span className="tabular-nums text-muted-foreground">{fmtNum(s.ltp)}</span>
                    <span className={`w-14 text-right font-semibold tabular-nums ${pctClass(s.pctChange)}`}>
                      {fmtPct(s.pctChange)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <p className="text-[11px] text-muted-foreground">
            Live from NSE public feeds (nseindia.com) — no broker auth. Auto-refreshes every 60s.
            Gainers/losers &amp; most-active are NSE&apos;s top-20 lists; OI build-up covers the full F&amp;O universe.
          </p>
        </>
      )}
    </div>
  );
}
