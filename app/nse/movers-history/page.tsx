'use client';

import { CalendarDays, ChevronLeft, ChevronRight, Flame, Loader2, TrendingDown, TrendingUp } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { fmtCr, fmtNum, fmtPct, pctClass } from '@/app/nse/_lib/heat';

interface HistStock {
  symbol: string;
  close: number;
  pctChange: number;
  turnover: number;
  volume: number;
  oiPct: number;
  hasFno: boolean;
}

interface HistResponse {
  success: boolean;
  date?: string;
  prevDate?: string;
  count?: number;
  stocks?: HistStock[];
  error?: string;
}

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
  return <div className="px-3 py-5 text-center text-[11px] text-muted-foreground">No data for this session.</div>;
}

function Row({ i, symbol, value, pct }: { i: number; symbol: string; value: string; pct: number }) {
  return (
    <div className="flex items-center gap-1.5 border-b border-border/30 px-2 py-[3px] text-[11px]">
      <span className="w-4 shrink-0 text-right text-[9px] tabular-nums text-muted-foreground">{i + 1}</span>
      <span className="flex-1 truncate font-mono font-medium">{symbol}</span>
      <span className="tabular-nums text-muted-foreground">{value}</span>
      <span className={`w-[58px] shrink-0 text-right font-semibold tabular-nums ${pctClass(pct)}`}>{fmtPct(pct)}</span>
    </div>
  );
}

export default function NseMoversHistoryPage() {
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState<string>('');
  const [data, setData] = useState<HistResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeBy, setActiveBy] = useState<'value' | 'volume'>('value');

  // Load the available session dates once, default to the latest.
  useEffect(() => {
    fetch('/api/nse/movers-history?dates=true')
      .then((r) => r.json())
      .then((d: { success: boolean; dates?: string[]; error?: string }) => {
        if (d.success && d.dates?.length) {
          setDates(d.dates);
          setDate(d.dates[0]);
        } else {
          setError(d.error ?? 'No bhavcopy sessions synced');
          setLoading(false);
        }
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!date) return;
    let stopped = false;
    const run = async () => {
      try {
        const res = await fetch(`/api/nse/movers-history?date=${date}`);
        const json = (await res.json()) as HistResponse;
        if (stopped) return;
        if (json.success) {
          setData(json);
          setError(null);
        } else {
          setError(json.error ?? 'Failed to load session');
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        if (!stopped) setLoading(false);
      }
    };
    void run();
    return () => {
      stopped = true;
    };
  }, [date]);

  const idx = dates.indexOf(date);
  const goOlder = () => idx >= 0 && idx < dates.length - 1 && setDate(dates[idx + 1]);
  const goNewer = () => idx > 0 && setDate(dates[idx - 1]);

  const stocks = useMemo(() => data?.stocks ?? [], [data]);
  const gainers = useMemo(() => [...stocks].sort((a, b) => b.pctChange - a.pctChange).slice(0, 20), [stocks]);
  const losers = useMemo(() => [...stocks].sort((a, b) => a.pctChange - b.pctChange).slice(0, 20), [stocks]);
  const active = useMemo(
    () =>
      [...stocks]
        .sort((a, b) => (activeBy === 'value' ? b.turnover - a.turnover : b.volume - a.volume))
        .slice(0, 20),
    [stocks, activeBy],
  );
  const oiBuildup = useMemo(
    () => stocks.filter((s) => s.hasFno).sort((a, b) => b.oiPct - a.oiPct).slice(0, 24),
    [stocks],
  );

  const segCls = (on: boolean) =>
    `rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
      on ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
    }`;
  const navCls = (disabled: boolean) =>
    `flex h-7 w-7 items-center justify-center rounded-md border border-border ${
      disabled ? 'opacity-30' : 'hover:bg-accent'
    }`;

  return (
    <div className="mx-auto max-w-7xl space-y-2 p-3">
      {/* Header + date picker */}
      <div className="flex flex-wrap items-center gap-2">
        <CalendarDays className="h-5 w-5 text-primary" />
        <h1 className="text-base font-bold text-foreground">EOD Movers</h1>
        <span
          className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-500/10 dark:text-sky-400"
          title="Reconstructed from NSE's official end-of-day bhavcopy. Price/% use the day's last-traded price (matching the live feed); OI% is counted in contracts. The live /nse/movers page is the intraday snapshot."
        >
          NSE bhavcopy · EOD
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" aria-label="Older session" onClick={goOlder} className={navCls(idx >= dates.length - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </button>
          <select
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-7 rounded-md border border-border bg-background px-2 text-xs tabular-nums"
          >
            {dates.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <button type="button" aria-label="Newer session" onClick={goNewer} className={navCls(idx <= 0)}>
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
        Close-to-close vs the prior session{data?.prevDate ? ` (${data.prevDate})` : ''} · {data?.count ?? 0} F&O stocks · official NSE bhavcopy, reconstructed (not the intraday snapshot).
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-border p-8 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          Loading session…
        </div>
      )}

      {data && (
        <>
          {/* 1 — F&O OI Build-up */}
          <Panel
            title="F&O OI Build-up"
            icon={<TrendingUp className="h-3.5 w-3.5 text-violet-500" />}
            right={
              <span
                className="cursor-help text-[9px] text-muted-foreground"
                title="Total (futures + options) OI change, close-to-close, counted in CONTRACTS — each expiry's OI ÷ that expiry's own board lot (taken per-contract from the NSE bhavcopy file), summed. Same basis as the live NSE Movers feed, and stays correct even when a stock is mid lot-size revision (e.g. MCX 625→225), where a share-based count would mislead because OI rolling into the next expiry carries a different lot."
              >
                top OI gains · price · OI%
              </span>
            }
          >
            {oiBuildup.length === 0 ? (
              <Empty />
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
                {oiBuildup.map((s, i) => (
                  <Row key={s.symbol} i={i} symbol={s.symbol} value={fmtNum(s.close)} pct={s.oiPct} />
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
                  <Row
                    key={s.symbol}
                    i={i}
                    symbol={s.symbol}
                    value={activeBy === 'value' ? fmtCr(s.turnover) : fmtNum(s.volume)}
                    pct={s.pctChange}
                  />
                ))}
              </div>
            )}
          </Panel>

          {/* 3 — Gainers / Losers */}
          <div className="grid gap-2 md:grid-cols-2">
            <Panel title="Top Gainers" icon={<TrendingUp className="h-3.5 w-3.5 text-emerald-500" />}>
              {gainers.length === 0 ? (
                <Empty />
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2">
                  {gainers.map((s, i) => (
                    <Row key={s.symbol} i={i} symbol={s.symbol} value={fmtNum(s.close)} pct={s.pctChange} />
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
                    <Row key={s.symbol} i={i} symbol={s.symbol} value={fmtNum(s.close)} pct={s.pctChange} />
                  ))}
                </div>
              )}
            </Panel>
          </div>

          <p className="text-[10px] text-muted-foreground">
            Reconstructed from NSE official bhavcopy. Price &amp; % change use the day&apos;s last-traded price vs the prior
            official close — the same basis as the live NSE Movers feed (and Google/brokers), so the two line up. OI% is total
            (futures + options) open-interest change counted in contracts — each expiry&apos;s OI divided by that expiry&apos;s
            own board lot, taken per-contract from the bhavcopy file — matching the live feed even across lot-size revisions
            (e.g. MCX). For live intraday movers, see NSE Movers.
          </p>
        </>
      )}
    </div>
  );
}
