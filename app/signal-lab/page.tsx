'use client';

import { FlaskConical, Loader2, Play } from 'lucide-react';
import { useState } from 'react';
import type { ScanParams, ScanResult } from '@/lib/backtest/signal-scanner';
import { HowItWorks } from './_components/how-it-works';
import { ScanCurve } from './_components/scan-curve';
import { ScanScoreboard } from './_components/scan-scoreboard';
import { ScanBreakdowns, ScanTradeTable } from './_components/scan-table';

// Mirrors DEFAULT_SCAN_PARAMS in lib/backtest/signal-scanner.ts. Kept as a local
// constant so this client bundle never imports the server-side scanner module.
const DEFAULTS: ScanParams = {
  oiLevelMin: 1.25,
  turnoverMin: 1.5,
  direction: 'both',
  includeWeak: false,
  holdDays: 1,
  costPct: 0.1,
};

export default function SignalLabPage() {
  const [params, setParams] = useState<ScanParams>(DEFAULTS);
  const [data, setData] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof ScanParams>(key: K, value: ScanParams[K]) =>
    setParams((p) => ({ ...p, [key]: value }));

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/backtest/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const d = await res.json();
      if (d.success) setData(d as ScanResult);
      else setError(d.error ?? 'Scan failed');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-3 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <FlaskConical className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-bold text-foreground">Signal Lab</h1>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          point-in-time scan · whole F&O universe
        </span>
        {data && (
          <span className="text-[11px] text-muted-foreground">
            {data.coverage.symbols} stocks · {data.coverage.sessions} sessions · {data.coverage.from} → {data.coverage.to}
          </span>
        )}
      </div>

      <HowItWorks />

      {/* Rule controls — each input carries its plain-English meaning */}
      <div className="rounded-xl border border-border bg-card p-3">
        <h2 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">The rule being tested</h2>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <Field
            label="Futures OI level"
            help="How crowded the stock's futures are vs their own normal: today's open interest ÷ its 20-session average. TradeFinder's top picks sat at 1.25× and above — that's the default."
          >
            <span className="text-muted-foreground">≥</span>
            <input
              type="number"
              step={0.05}
              min={1}
              max={5}
              value={params.oiLevelMin}
              onChange={(e) => set('oiLevelMin', Number(e.target.value))}
              className="w-16 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none"
            />
            <span className="text-muted-foreground">× 20d avg</span>
          </Field>

          <Field
            label="Futures turnover"
            help="How actively traded the stock's futures were that day vs normal — a quality filter that keeps out illiquid names."
          >
            <span className="text-muted-foreground">≥</span>
            <input
              type="number"
              step={0.1}
              min={1}
              max={10}
              value={params.turnoverMin}
              onChange={(e) => set('turnoverMin', Number(e.target.value))}
              className="w-16 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none"
            />
            <span className="text-muted-foreground">× 20d avg</span>
          </Field>

          <Field
            label="Direction"
            help="Long buildup days are traded long (buy), short buildup days short (sell first). Restrict to one side to test it in isolation."
          >
            <select
              value={params.direction}
              onChange={(e) => set('direction', e.target.value as ScanParams['direction'])}
              className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none"
            >
              <option value="both">Both sides</option>
              <option value="long">Long only</option>
              <option value="short">Short only</option>
            </select>
          </Field>

          <Field
            label="Hold"
            help="1 = enter at next morning's open, exit at that same day's close. 2 = exit at the close of the day after. And so on."
          >
            <select
              value={params.holdDays}
              onChange={(e) => set('holdDays', Number(e.target.value))}
              className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none"
            >
              {[1, 2, 3, 4, 5].map((h) => (
                <option key={h} value={h}>
                  {h} session{h > 1 ? 's' : ''}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Cost / trade"
            help="Round-trip cost (brokerage, taxes, slippage) charged to every trade, as % of position. 0.1% is a fair intraday approximation. The random baseline pays the same cost, so the comparison stays fair."
          >
            <input
              type="number"
              step={0.05}
              min={0}
              max={2}
              value={params.costPct}
              onChange={(e) => set('costPct', Number(e.target.value))}
              className="w-16 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none"
            />
            <span className="text-muted-foreground">%</span>
          </Field>

          <label
            className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
            title="Short-covering and long-unwinding are positions EXITING, not fresh conviction — weaker signals, off by default."
          >
            <input
              type="checkbox"
              checked={params.includeWeak}
              onChange={(e) => set('includeWeak', e.target.checked)}
              className="accent-primary"
            />
            include weak quadrants <span className="text-muted-foreground/40">ⓘ</span>
          </label>

          <button
            type="button"
            onClick={run}
            disabled={loading}
            className="ml-auto flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {loading ? 'Scanning…' : 'Run Scan'}
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          In words: <em>
            “Each evening, find every stock whose futures OI is at least {params.oiLevelMin}× its 20-day average AND
            turnover is at least {params.turnoverMin}× average AND the day was a{' '}
            {params.direction === 'long' ? 'long buildup' : params.direction === 'short' ? 'short buildup' : 'long or short buildup'}
            {params.includeWeak ? ' (or a weak covering/unwinding day)' : ''}. Next morning,{' '}
            {params.direction === 'short' ? 'short it' : params.direction === 'long' ? 'buy it' : 'trade in the buildup’s direction'}{' '}
            at the open; exit at the close {params.holdDays === 1 ? 'the same day' : `after ${params.holdDays} sessions`}.”
          </em>
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {!data && !loading && !error && (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          Click <b>Run Scan</b> to replay this rule across every F&O stock and every session in the bhavcopy database.
          Nothing is downloaded — it only reads data already synced via{' '}
          <a className="text-primary underline" href="/data-downloader">
            Data Downloader
          </a>
          .
        </div>
      )}

      {loading && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-border p-10 text-center text-sm text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          Replaying every stock, every session…
        </div>
      )}

      {data && (
        <>
          <ScanScoreboard summary={data.summary} />
          <ScanBreakdowns byDirection={data.byDirection} byQuadrant={data.byQuadrant} />
          <ScanCurve curve={data.curve} />
          <ScanTradeTable trades={data.trades} />

          {/* Honesty notes — what this scan is and is not */}
          <div className="rounded-xl border border-border bg-muted/30 p-3 text-[11px] leading-relaxed text-muted-foreground">
            <strong className="text-foreground">Read the result honestly:</strong>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                Trades are on the <strong>stock itself</strong> at official NSE open/close prices — not on option
                premiums (no per-strike history exists for the whole universe). An options version would amplify both
                wins and losses.
              </li>
              <li>
                The window is ~{data.coverage.sessions} sessions ({data.coverage.from} → {data.coverage.to}) — one
                market regime. A rule that wins here can lose in a different regime; the baseline of{' '}
                {data.summary.baselineGrossPct >= 0 ? '+' : ''}
                {data.summary.baselineGrossPct.toFixed(2)}% per stock-day tells you which way the whole market drifted.
              </li>
              <li>
                Costs are a flat {data.params.costPct}% approximation. Real slippage on illiquid names is worse.
              </li>
              <li>
                If you tweak parameters until the result looks good, you are <strong>curve-fitting</strong> — the more
                combinations you try, the less the best one means. Decide the rule first, then test it.
              </li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function Field({ label, help, children }: { label: string; help: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1" title={help}>
      <span className="cursor-help text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label} <span className="text-muted-foreground/40">ⓘ</span>
      </span>
      <div className="flex items-center gap-1.5 text-xs">{children}</div>
    </div>
  );
}
