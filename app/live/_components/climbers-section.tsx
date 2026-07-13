'use client';

import { ArrowDown, ArrowUp, Loader2, Sparkles, TrendingUp } from 'lucide-react';
import { useState } from 'react';
import { useClimbers } from '../_hooks/use-climbers';
import type { RaceRunner, RankFeed } from '../_lib/types';

// The feeds the race can track, in the order shown as tabs. Labels are plain.
const FEEDS: { key: RankFeed; label: string }[] = [
  { key: 'oi', label: 'OI Build-up' },
  { key: 'gainers', label: 'Gainers' },
  { key: 'losers', label: 'Losers' },
  { key: 'active-value', label: 'Most Active' },
];

/** Format the feed's metric value for the little context number. */
function fmtValue(feed: RankFeed, v: number): string {
  if (feed === 'oi') return `${v >= 0 ? '+' : ''}${v.toFixed(1)}% OI`;
  if (feed === 'gainers' || feed === 'losers') return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  if (feed === 'active-value') return v >= 1e7 ? `₹${(v / 1e7).toFixed(0)}Cr` : `₹${(v / 1e5).toFixed(0)}L`;
  return v >= 1e7 ? `${(v / 1e7).toFixed(1)}Cr` : `${(v / 1e5).toFixed(0)}L`;
}

/**
 * The rank "track" over the day as a tiny sparkline. Rank 1 (best) sits at the
 * TOP, so a climb reads as the line going UP. Auto-scaled to this name's own
 * rank range — the delta badge carries the magnitude; the line shows the path.
 */
function RankSparkline({ track, climbed }: { track: (number | null)[]; climbed: boolean }) {
  const W = 60;
  const H = 18;
  const pts = track.map((r, i) => ({ i, r })).filter((p): p is { i: number; r: number } => p.r != null);
  if (pts.length < 2) return <span className="inline-block" style={{ width: W, height: H }} />;

  const ranks = pts.map((p) => p.r);
  const minR = Math.min(...ranks);
  const maxR = Math.max(...ranks);
  const span = maxR - minR || 1;
  const n = track.length - 1 || 1;
  const x = (i: number) => 1 + (i / n) * (W - 2);
  // Best rank (minR) → top (small y); worst (maxR) → bottom.
  const y = (r: number) => 1 + ((r - minR) / span) * (H - 2);

  const d = pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.r).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const stroke = climbed ? 'rgb(16 185 129)' : 'rgb(239 68 68)';

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0" aria-hidden>
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
      <circle cx={x(last.i)} cy={y(last.r)} r={1.8} fill={stroke} />
    </svg>
  );
}

function RunnerRow({ c, feed }: { c: RaceRunner; feed: RankFeed }) {
  const climbed = (c.deltaSinceOpen ?? 0) > 0;
  return (
    <div
      onClick={() =>
        window.open(`https://in.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(c.symbol)}&interval=5`, '_blank', 'noopener,noreferrer')
      }
      title={`${c.symbol} — now #${c.rankNow}, from #${c.rankOpen} at open (climbed ${c.deltaSinceOpen}) · ${fmtValue(feed, c.valueNow)}. Open chart.`}
      className="flex cursor-pointer items-center gap-1.5 rounded border border-border bg-muted/30 px-1.5 py-0.5 hover:bg-muted/60"
    >
      {/* Headline = current rank (always within the top 20). */}
      <span className="w-7 shrink-0 text-center text-[12px] font-bold tabular-nums text-foreground">#{c.rankNow}</span>
      <span className="w-14 truncate text-[10.5px] font-medium text-foreground">{c.symbol}</span>
      {/* Climb since open — secondary. */}
      <span className={`flex shrink-0 items-center gap-0.5 text-[9.5px] tabular-nums ${climbed ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
        {climbed ? <ArrowUp className="h-2.5 w-2.5" /> : <ArrowDown className="h-2.5 w-2.5" />}
        {Math.abs(c.deltaSinceOpen ?? 0)}
      </span>
      <span className="text-[9px] text-muted-foreground">from #{c.rankOpen}</span>
      <RankSparkline track={c.track} climbed={climbed} />
      <span className="ml-auto text-[9.5px] tabular-nums text-muted-foreground">{fmtValue(feed, c.valueNow)}</span>
    </div>
  );
}

/**
 * "Running race" — who has CLIMBED the leaderboard SINCE MARKET OPEN. Each name
 * shows its rank at open, its rank now, the spots gained, and a sparkline of its
 * rank at every 5-min check today — so you can see at a glance who's been
 * marching up the board all session. Re-ranked biggest-climber-first each poll.
 * New-to-board names (weren't ranked at open) are listed separately so a fresh
 * arrival never masquerades as a big climb. Reads local rank_snapshots — no cost.
 */
export function ClimbersSection({ refreshSignal }: { refreshSignal: number }) {
  const [feed, setFeed] = useState<RankFeed>('oi');
  const { data, loading, error } = useClimbers(feed, refreshSignal);

  const runners = data?.runners ?? [];
  const newEntrants = data?.newEntrants ?? [];
  const checks = data?.bucketTimes?.length ?? 0;
  const hasRace = data?.openTs != null && (data?.bucketTimes?.length ?? 0) >= 2;

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-2.5 py-1.5">
        <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-foreground">Running race</h2>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          into the top 20 · since open{checks > 0 ? ` · ${checks} checks` : ''}
        </span>
        <div className="ml-auto flex items-center gap-0.5 rounded-lg border border-border p-0.5">
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
      </header>

      <div className="px-2.5 py-2">
        {error ? (
          <p className="py-2 text-center text-[11px] text-red-600 dark:text-red-400">{error}</p>
        ) : loading && !data ? (
          <p className="flex items-center justify-center gap-2 py-2 text-[11px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" /> Loading the race…
          </p>
        ) : !hasRace ? (
          <p className="py-2 text-center text-[11px] text-muted-foreground">
            The race fills in from the open — it needs at least two 5-min checks. It builds as the session runs (resumes
            at the next open when the market&apos;s closed).
          </p>
        ) : runners.length === 0 && newEntrants.length === 0 ? (
          <p className="py-2 text-center text-[11px] text-muted-foreground">
            No one&apos;s climbed this board since the open — the leaderboard has held its shape.
          </p>
        ) : (
          <div className="space-y-2">
            {runners.length > 0 && (
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
                {runners.map((c) => (
                  <RunnerRow key={c.symbol} c={c} feed={feed} />
                ))}
              </div>
            )}
            {newEntrants.length > 0 && (
              <div>
                <p className="mb-1 flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                  <Sparkles className="h-3 w-3 text-amber-500" /> New since open (weren&apos;t on the board at 9:15)
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
