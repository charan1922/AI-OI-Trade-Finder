'use client';

import { Gauge, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { HowToRead } from './_components/how-to-read';
import { UrgencyTable } from './_components/urgency-table';
import { useLiveUrgency } from './_hooks/use-live-urgency';
import type { SectorBasis, SectorLeadersResponse, SectorPick } from './_lib/types';

const BASIS_LABEL: Record<SectorBasis, string> = {
  gainers: 'top gainers',
  losers: 'top losers',
  movers: 'biggest movers',
};

export default function LiveUrgencyPage() {
  // No hardcoded basket — the default watchlist is auto-picked sector leaders
  // (see the effect below); the user can overwrite it with any manual list.
  const [watchInput, setWatchInput] = useState('');
  const [applied, setApplied] = useState('');

  // Auto-pick (sector leaders) state. Cleared when the user applies a manual
  // list. autoLoading starts true because the mount effect always auto-picks.
  const [autoBasis, setAutoBasis] = useState<SectorBasis>('gainers');
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

  const { rows, marketOpen, asOf, loading, error, refresh } = useLiveUrgency(symbols);

  const applyManual = (text: string) => {
    setApplied(text);
    setAutoPicks(null);
    setAutoMeta(null);
    setAutoError(null);
  };

  // Pure fetch — no setState, so the mount effect below stays free of
  // synchronous setState (react-hooks/set-state-in-effect).
  const fetchSectorLeaders = async (basis: SectorBasis): Promise<SectorLeadersResponse> => {
    try {
      const res = await fetch(`/api/live/sector-leaders?basis=${basis}&perSector=2`);
      return (await res.json()) as SectorLeadersResponse;
    } catch (e) {
      return { success: false, picks: [], error: (e as Error).message };
    }
  };

  const applyPicks = (d: SectorLeadersResponse) => {
    if (!d.success) {
      setAutoError(d.error ?? 'Failed to build the sector watchlist');
      return;
    }
    const list = d.picks.map((p) => p.symbol).join(', ');
    setWatchInput(list);
    setApplied(list);
    setAutoPicks(d.picks);
    setAutoMeta(d.meta ?? null);
    setAutoError(null);
  };

  const autoPick = async (basis: SectorBasis) => {
    setAutoLoading(true);
    applyPicks(await fetchSectorLeaders(basis));
    setAutoLoading(false);
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
    fetchSectorLeaders('gainers').then((d) => {
      if (ignore) return;
      applyPicks(d);
      setAutoLoading(false);
    });
    return () => {
      ignore = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Gauge className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-bold text-foreground">Live Urgency</h1>
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
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-1 rounded-md bg-muted px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
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
          title="Builds the watchlist automatically from synced NSE data: the 2 strongest stocks of EACH sector over the last 5 sessions, only counting liquid names (≥ ₹100 Cr/day futures turnover) with a live futures contract. Max 25 stocks."
        >
          <button
            type="button"
            onClick={() => autoPick(autoBasis)}
            disabled={autoLoading}
            className="flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/15 disabled:opacity-50"
          >
            {autoLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Auto-pick sector leaders
          </button>
          <select
            value={autoBasis}
            onChange={(e) => setAutoBasis(e.target.value as SectorBasis)}
            className="rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground focus:border-primary focus:outline-none"
            title="gainers = strongest 5-session rise per sector · losers = strongest fall (short candidates) · biggest movers = largest move either way"
          >
            <option value="gainers">top gainers</option>
            <option value="losers">top losers</option>
            <option value="movers">biggest movers</option>
          </select>
        </div>
      </div>

      {autoError && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          Auto-pick failed: {autoError}
        </div>
      )}

      {/* What the auto-pick selected, grouped by sector — so the list explains itself */}
      {autoPicks && autoPicks.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-2.5">
          <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 text-[10px] text-muted-foreground">
            <span className="font-bold uppercase tracking-wide">Auto-picked: {BASIS_LABEL[autoBasis]} per sector</span>
            {autoMeta && (
              <span>
                5-session return {autoMeta.returnWindow.from} → {autoMeta.returnWindow.to} · liquidity ≥ ₹
                {autoMeta.liquidityFloorCr} Cr/day · {autoMeta.sectorsCovered} sectors · refreshes from bhavcopy, so
                re-click after each NSE sync
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {autoPicks.map((p) => (
              <span
                key={p.symbol}
                title={`${p.sector} · ${p.retPct >= 0 ? '+' : ''}${p.retPct.toFixed(2)}% over 5 sessions · ₹${p.avgFutTurnoverCr.toFixed(0)} Cr/day avg futures turnover`}
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

      {/* Honest framing of what the signals mean */}
      <div className="rounded-xl border border-border bg-muted/30 p-3 text-[11px] leading-relaxed text-muted-foreground">
        <b className="text-foreground">Reading urgency:</b> a <b>tight spread</b> means liquidity / cheap execution (not
        &quot;calm&quot;); a <b>wide</b> spread means illiquidity or stress. The real aggression read is the{' '}
        <b>bid/ask imbalance</b> (resting demand vs supply), paired with the futures <b>OI level</b> (conviction) and{' '}
        <b>turnover</b> (quality). Caveat: large players hide size via icebergs / slicing, so the visible book
        under-represents the biggest flow — treat this as a partial, real-time view, never the whole picture.
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {marketOpen === false ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          The market is closed (NSE 9:15–15:30 IST, weekdays). The order book — and therefore the live spread /
          imbalance — only exists during market hours, so nothing is shown rather than a fabricated snapshot.
        </div>
      ) : marketOpen === null && (loading || autoLoading) ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-border p-10 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          {autoLoading ? 'Picking sector leaders…' : 'Connecting to the live quote feed…'}
        </div>
      ) : (
        <UrgencyTable rows={rows} sectors={sectorBySymbol} />
      )}
    </div>
  );
}
