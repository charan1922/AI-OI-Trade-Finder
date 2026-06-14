'use client';

import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import type { ScanSummary } from '@/lib/backtest/signal-scanner';

const signedPct = (v: number, digits = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;

/** Too few trades and any stats are noise — the verdict says so instead of pretending. */
const MIN_TRADES_FOR_VERDICT = 30;

/**
 * Verdict banner + stat cards. The verdict is the beginner-facing answer to
 * "so… does this rule work?" in one plain sentence, color-coded, and honest
 * about sample size. Every card carries a hover tooltip explaining the stat.
 */
export function ScanScoreboard({ summary }: { summary: ScanSummary }) {
  return (
    <div className="space-y-3">
      <Verdict summary={summary} />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        <Stat
          label="Trades"
          value={String(summary.trades)}
          sub={summary.skippedNoEntry > 0 ? `${summary.signals} signals · ${summary.skippedNoEntry} untradeable` : `${summary.signals} signals`}
          hint="How many times the rule fired AND the stock had a next session to trade. A signal is untradeable when the symbol's data gaps (e.g. it left F&O)."
        />
        <Stat
          label="Win rate"
          value={`${summary.winRate.toFixed(1)}%`}
          sub={`${summary.wins} of ${summary.trades} made money`}
          hint="Share of trades with a positive return after costs. 50% means a coin flip — win rate alone says nothing about HOW MUCH you win or lose."
          tone={summary.winRate >= 50 ? 'good' : 'bad'}
        />
        <Stat
          label="Avg / trade"
          value={signedPct(summary.avgNetPct)}
          sub={`median ${signedPct(summary.medianNetPct)}`}
          hint="Average return per trade AFTER costs. The median is the middle trade — when average and median differ a lot, a few outliers are doing the work."
          tone={summary.avgNetPct > 0 ? 'good' : 'bad'}
        />
        <Stat
          label="Random baseline"
          value={signedPct(summary.baselineNetPct)}
          sub={`${summary.baselineDays.toLocaleString()} stock-days`}
          hint="What a dart-throwing monkey averages: every stock, every day, same entry/exit pattern and same costs, no signal. Adjusted for this run's long/short mix. The rule must beat THIS, not just zero."
        />
        <Stat
          label="Edge"
          value={signedPct(summary.edgePct)}
          sub="avg − baseline"
          hint="The number that matters: average per-trade return minus the random baseline. Positive = the signal added information. Negative = you'd have done better picking at random."
          tone={summary.edgePct > 0 ? 'good' : 'bad'}
          emphasize
        />
        <Stat
          label="Profit factor"
          value={summary.profitFactor == null ? '∞' : summary.profitFactor.toFixed(2)}
          sub="₹ won per ₹ lost"
          hint="Sum of all winning returns divided by the sum of all losing returns. Above 1.0 = profitable overall; 1.5+ is considered solid."
          tone={(summary.profitFactor ?? Number.POSITIVE_INFINITY) > 1 ? 'good' : 'bad'}
        />
        <Stat
          label="Max drawdown"
          value={`−${summary.maxDrawdownPct.toFixed(1)}`}
          sub="% points, peak → trough"
          hint="The deepest fall of the cumulative curve from its best point — the pain you'd have sat through. Measured in percentage points of the equal-weight curve."
          tone="bad"
        />
        <Stat
          label="TF overlap"
          value={summary.tfComparable > 0 ? `${summary.tfMatches}/${summary.tfComparable}` : '—'}
          sub="picks in TF's top-20"
          hint="For trades on days where a TradeFinder snapshot exists, how many of this rule's picks were also in TF's top-20 by R-Factor. A sanity check that the rule looks at the same stocks TF does — only 8 snapshot days exist, so treat it as anecdote."
        />
      </div>
    </div>
  );
}

function Verdict({ summary }: { summary: ScanSummary }) {
  if (summary.trades === 0) {
    return (
      <Banner tone="warn" icon={<AlertTriangle className="h-4 w-4 shrink-0" />}>
        <strong>No trades fired.</strong> The filters are too strict for this dataset — lower the OI level or turnover
        threshold and run again.
      </Banner>
    );
  }
  if (summary.trades < MIN_TRADES_FOR_VERDICT) {
    return (
      <Banner tone="warn" icon={<AlertTriangle className="h-4 w-4 shrink-0" />}>
        <strong>Only {summary.trades} trades — too few to judge.</strong> Averages over tiny samples are mostly luck.
        Loosen the filters for a bigger sample, or treat this result as anecdote, not evidence.
      </Banner>
    );
  }
  const e = summary.edgePct;
  if (e > 0.05) {
    return (
      <Banner tone="good" icon={<CheckCircle2 className="h-4 w-4 shrink-0" />}>
        <strong>This configuration beat random.</strong> {summary.trades} trades averaged{' '}
        <strong>{signedPct(summary.avgNetPct)}</strong> per trade after costs, vs a random baseline of{' '}
        {signedPct(summary.baselineNetPct)} — an edge of <strong>{signedPct(e)}</strong> per trade. Before trusting it:
        check the breakdown below (is one side doing all the work?), and remember this is ~6 months of one market
        regime.
      </Banner>
    );
  }
  if (e < -0.05) {
    return (
      <Banner tone="bad" icon={<XCircle className="h-4 w-4 shrink-0" />}>
        <strong>This configuration did NOT beat random.</strong> {summary.trades} trades averaged{' '}
        <strong>{signedPct(summary.avgNetPct)}</strong> per trade after costs, vs a random baseline of{' '}
        {signedPct(summary.baselineNetPct)} — an edge of <strong>{signedPct(e)}</strong>. That is a real finding: it
        stops you trading a losing rule with real money. Check the direction breakdown — sometimes one side works
        while the other drags the average down.
      </Banner>
    );
  }
  return (
    <Banner tone="warn" icon={<AlertTriangle className="h-4 w-4 shrink-0" />}>
      <strong>Roughly a wash.</strong> {summary.trades} trades averaged {signedPct(summary.avgNetPct)} per trade vs a
      random baseline of {signedPct(summary.baselineNetPct)} — an edge of {signedPct(e)}, too small to mean anything.
      After real-world slippage this would likely be break-even or worse.
    </Banner>
  );
}

function Banner({ tone, icon, children }: { tone: 'good' | 'bad' | 'warn'; icon: React.ReactNode; children: React.ReactNode }) {
  const cls =
    tone === 'good'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300'
      : tone === 'bad'
        ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
        : 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300';
  return (
    <div className={`flex items-start gap-2 rounded-xl border p-3 text-xs leading-relaxed ${cls}`}>
      <span className="mt-0.5">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  hint,
  tone,
  emphasize,
}: {
  label: string;
  value: string;
  sub?: string;
  hint: string;
  tone?: 'good' | 'bad';
  emphasize?: boolean;
}) {
  const valueCls =
    tone === 'good'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'bad'
        ? 'text-red-600 dark:text-red-400'
        : 'text-foreground';
  return (
    <div
      title={hint}
      className={`cursor-help rounded-lg border bg-card p-2.5 ${emphasize ? 'border-primary/50' : 'border-border'}`}
    >
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label} <span className="text-muted-foreground/40">ⓘ</span>
      </div>
      <div className={`mt-0.5 font-mono text-base font-bold tabular-nums ${valueCls}`}>{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}
