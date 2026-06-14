'use client';

import { LineChart, Loader2, Play } from 'lucide-react';
import { useState } from 'react';
import { EquityCurve } from './_components/equity-curve';
import { Scoreboard } from './_components/scoreboard';
import { TradeTable } from './_components/trade-table';
import type { BtRunResponse, GateBasis } from './_lib/bt-types';

const BASIS_LABELS: Record<GateBasis, string> = {
  optOi: 'Combined option OI',
  futOi: 'Combined futures OI',
  score: 'Signal score',
  pillars: 'Pillars (OI dir + turnover + conviction)',
  none: 'No filter',
};

function gateText(basis: GateBasis, t: number): string {
  if (basis === 'none') return 'take every verified trade (no signal filter)';
  if (basis === 'score') return `take only when ≥ ${t} of 6 "Why this trade" signals support`;
  if (basis === 'futOi') return `take only when combined futures OI ≥ ${t}× its 20-day average`;
  if (basis === 'pillars')
    return `take only when option OI ≥ ${t}× 20-day avg (conviction) AND futures turnover ≥ 1.2× (quality) AND the futures price+OI direction agrees with the CE/PE`;
  return `take only when combined option OI ≥ ${t}× its 20-day average`;
}

export default function BacktestPage() {
  const [data, setData] = useState<BtRunResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [gateBasis, setGateBasis] = useState<GateBasis>('optOi');
  const [gateThreshold, setGateThreshold] = useState(1.1);
  const [profitTarget, setProfitTarget] = useState(5000);

  const onBasisChange = (b: GateBasis) => {
    setGateBasis(b);
    setGateThreshold(b === 'score' ? 4 : 1.1);
  };

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gateBasis, gateThreshold: gateBasis === 'none' ? 0 : gateThreshold, profitTarget }),
      });
      const d = await res.json();
      if (d.success) setData(d as BtRunResponse);
      else setError(d.error ?? 'Backtest failed');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4">
      {/* Header + controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <LineChart className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-bold text-foreground">Backtest</h1>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">vectorbt · verified trades</span>
        </div>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Gate
          <select
            value={gateBasis}
            onChange={(e) => onBasisChange(e.target.value as GateBasis)}
            className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none"
          >
            {(Object.keys(BASIS_LABELS) as GateBasis[]).map((b) => (
              <option key={b} value={b}>
                {BASIS_LABELS[b]}
              </option>
            ))}
          </select>
        </label>

        {gateBasis !== 'none' && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            ≥
            <input
              type="number"
              step={gateBasis === 'score' ? 1 : 0.05}
              min={gateBasis === 'score' ? 1 : 1}
              max={gateBasis === 'score' ? 6 : undefined}
              value={gateThreshold}
              onChange={(e) => setGateThreshold(Number(e.target.value))}
              className="w-16 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none"
            />
            {gateBasis === 'score' ? '/6' : '×'}
          </label>
        )}

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Profit ₹
          <input
            type="number"
            step="500"
            min="500"
            value={profitTarget}
            onChange={(e) => setProfitTarget(Number(e.target.value))}
            className="w-24 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none"
          />
        </label>

        <button
          type="button"
          onClick={run}
          disabled={loading}
          className="ml-auto flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {loading ? 'Running…' : 'Run Backtest'}
        </button>
      </div>

      {/* What's being tested */}
      <div className="rounded-xl border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
        <span className="font-semibold text-foreground">Rule tested:</span> on TradeFinder&apos;s{' '}
        <b>human-verified</b> trades, {gateText(gateBasis, gateThreshold)} (signals from bhavcopy combined OI). Then
        enter at <b>TF&apos;s actual entry time</b> (clamped to the <b>9:45–11:00</b> window), take profit at{' '}
        <b>+₹{profitTarget.toLocaleString('en-IN')}</b>, stop at the <b>previous candle&apos;s low</b> (trails up),
        else exit at day end. Booked in <b>vectorbt</b> with the Indian F&amp;O options cost model.
        <span className="mt-1 block text-[11px] text-muted-foreground/70">
          Bid-ask spread / urgency is a <b>live-only</b> signal (5-min candles have no order book) and is excluded from
          this historical backtest — see the <b>Live Urgency</b> page.
        </span>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {data?.prep && (data.prep.missingCandles.length > 0 || data.prep.missingBhav.length > 0) && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-700 dark:text-amber-300">
          {data.prep.missingCandles.length > 0 && (
            <div>No option candles for {data.prep.missingCandles.length} trade(s) — download them in Data Downloader.</div>
          )}
          {data.prep.missingBhav.length > 0 && (
            <div>No bhavcopy (combined OI) for {data.prep.missingBhav.length} trade-day(s) — sync bhavcopy in Data Downloader.</div>
          )}
        </div>
      )}

      {!data && !loading && !error && (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          Click <b>Run Backtest</b> to replay the rule across TradeFinder&apos;s verified trades. Needs option candles +
          bhavcopy in{' '}
          <a className="text-primary underline" href="/data-downloader">
            Data Downloader
          </a>
          .
        </div>
      )}

      {loading && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-border p-10 text-center text-sm text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          Preparing per-trade data and running vectorbt… first run compiles numba, so it can take ~20s.
        </div>
      )}

      {data && (
        <>
          <Scoreboard summary={data.summary} />
          <EquityCurve results={data.results} />
          <TradeTable results={data.results} gateBasis={data.summary.gateBasis} />
        </>
      )}
    </div>
  );
}
