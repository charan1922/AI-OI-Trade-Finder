'use client';

import { ArrowUp, Loader2, Sparkles, TrendingUp } from 'lucide-react';
import { useState } from 'react';
import { useClimbers } from '../_hooks/use-climbers';
import type { Climber, RankFeed } from '../_lib/types';

// The feeds the race can track, in the order shown as tabs. Labels are plain.
const FEEDS: { key: RankFeed; label: string }[] = [
  { key: 'oi', label: 'OI Build-up' },
  { key: 'gainers', label: 'Gainers' },
  { key: 'losers', label: 'Losers' },
  { key: 'active-value', label: 'Most Active' },
];
const WINDOWS = [30, 60];

/** Format the feed's metric value for the little context number. */
function fmtValue(feed: RankFeed, v: number): string {
  if (feed === 'oi') return `${v >= 0 ? '+' : ''}${v.toFixed(1)}% OI`;
  if (feed === 'gainers' || feed === 'losers') return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  if (feed === 'active-value') return v >= 1e7 ? `₹${(v / 1e7).toFixed(0)}Cr` : `₹${(v / 1e5).toFixed(0)}L`;
  return v >= 1e7 ? `${(v / 1e7).toFixed(1)}Cr` : `${(v / 1e5).toFixed(0)}L`;
}

function ClimberRow({ c, feed }: { c: Climber; feed: RankFeed }) {
  return (
    <div
      onClick={() =>
        window.open(`https://in.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(c.symbol)}&interval=5`, '_blank', 'noopener,noreferrer')
      }
      title={`${c.symbol} — climbed from #${c.rankThen} to #${c.rankNow} (${c.delta} spots) · ${fmtValue(feed, c.valueNow)}. Open chart.`}
      className="flex cursor-pointer items-center gap-2 rounded border border-border bg-muted/30 px-2 py-1 hover:bg-muted/60"
    >
      <span className="flex items-center gap-0.5 font-bold text-emerald-600 dark:text-emerald-400">
        <ArrowUp className="h-3 w-3" />
        {c.delta}
      </span>
      <span className="font-medium text-foreground">{c.symbol}</span>
      <span className="text-[10px] text-muted-foreground">
        #{c.rankThen}→<b className="text-foreground">#{c.rankNow}</b>
      </span>
      <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">{fmtValue(feed, c.valueNow)}</span>
    </div>
  );
}

/**
 * "Running race" — the biggest RANK CLIMBERS in a feed over the last 30/60 min.
 * The rank-momentum read: who's getting crowded into RIGHT NOW (moving up the
 * leaderboard), which the static category tables below can't show. New-to-board
 * names are listed separately so a fresh arrival never masquerades as a big climb.
 * Reads local rank_snapshots only — no Dhan/NSE cost.
 */
export function ClimbersSection({ refreshSignal }: { refreshSignal: number }) {
  const [feed, setFeed] = useState<RankFeed>('oi');
  const [windowMin, setWindowMin] = useState(30);
  const { data, loading, error } = useClimbers(feed, windowMin, refreshSignal);

  const climbers = data?.climbers ?? [];
  const newEntrants = data?.newEntrants ?? [];
  const hasSeries = data?.baselineTs != null;

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-2.5 py-1.5">
        <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-foreground">Running race</h2>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          climbing the leaderboard
        </span>
        <div className="ml-auto flex items-center gap-2">
          {/* Feed tabs */}
          <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
            {FEEDS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFeed(f.key)}
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                  feed === f.key ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {/* Window toggle */}
          <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWindowMin(w)}
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                  windowMin === w ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {w}m
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="px-2.5 py-2">
        {error ? (
          <p className="py-2 text-center text-[11px] text-red-600 dark:text-red-400">{error}</p>
        ) : loading && !data ? (
          <p className="flex items-center justify-center gap-2 py-2 text-[11px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" /> Loading the race…
          </p>
        ) : !hasSeries ? (
          <p className="py-2 text-center text-[11px] text-muted-foreground">
            Not enough history yet — the race needs ~{Math.round(windowMin / 2)}+ min of 5-min snapshots. It fills in
            as the session runs (resumes at the next open when the market&apos;s closed).
          </p>
        ) : climbers.length === 0 && newEntrants.length === 0 ? (
          <p className="py-2 text-center text-[11px] text-muted-foreground">
            No one&apos;s climbing this board over the last {windowMin} min — the leaderboard is settled.
          </p>
        ) : (
          <div className="space-y-2">
            {climbers.length > 0 && (
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
                {climbers.map((c) => (
                  <ClimberRow key={c.symbol} c={c} feed={feed} />
                ))}
              </div>
            )}
            {newEntrants.length > 0 && (
              <div>
                <p className="mb-1 flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                  <Sparkles className="h-3 w-3 text-amber-500" /> New to the board (weren&apos;t here {windowMin}m ago)
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {newEntrants.map((c) => (
                    <span
                      key={c.symbol}
                      onClick={() =>
                        window.open(`https://in.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(c.symbol)}&interval=5`, '_blank', 'noopener,noreferrer')
                      }
                      title={`${c.symbol} — new at #${c.rankNow} · ${fmtValue(feed, c.valueNow)}. Open chart.`}
                      className="inline-flex cursor-pointer items-center gap-1 rounded border border-amber-300/50 bg-amber-50 px-1.5 py-0.5 text-[10px] dark:bg-amber-500/10"
                    >
                      <span className="font-semibold text-foreground">{c.symbol}</span>
                      <span className="text-muted-foreground">#{c.rankNow}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
