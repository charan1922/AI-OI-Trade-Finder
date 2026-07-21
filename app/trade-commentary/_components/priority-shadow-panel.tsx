'use client';

import { useEffect, useState } from 'react';

/** Latest cycle fields we render (subset of StoredPriorityCycle). */
interface LatestCycle {
  fullPriorityCount: number;
  tier0Count: number;
  baseTier1Count: number;
  sectorPromotedCount: number;
  cappedWaitCount: number;
  shadowReleaseMs: number | null;
  actualReleaseMs: number | null;
  activeBullishSectors: string[];
  activeBearishSectors: string[];
  cappedLiveEnabled: boolean;
  sectorLiveEnabled: boolean;
}
interface ShadowSummary {
  success: boolean;
  cycles: number;
  latest: LatestCycle | null;
  p50SavedMs: number | null;
  p95SavedMs: number | null;
  measuredCycles: number;
  totalSuggestions: number;
  totalOutsideCap: number;
  outsideCapPct: number;
  outsideCapSymbols: string[];
}

const secs = (ms: number | null): string => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`);

/**
 * Read-only priority-refresh SHADOW summary (measurement only — it never changes
 * what the poller waits for or how it trades). Self-fetches so it's decoupled
 * from the main commentary data. Renders nothing until there is data.
 */
export function PriorityShadowPanel() {
  const [data, setData] = useState<ShadowSummary | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/priority-refresh', { cache: 'no-store' })
        .then((r) => r.json())
        .then((d: ShadowSummary) => {
          if (alive && d?.success) setData(d);
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!data || data.cycles === 0 || !data.latest) return null;
  const c = data.latest;
  const live = c.cappedLiveEnabled || c.sectorLiveEnabled;

  return (
    <section className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-semibold">Priority Refresh (shadow)</span>
        <span className="rounded-full border border-amber-500/40 px-2 py-0.5 text-xs text-amber-600 dark:text-amber-400">
          {live ? 'LIVE mode on' : 'measurement only · never changes trading'}
        </span>
        <span className="text-xs text-muted-foreground">{data.cycles} cycles today</span>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
        <div>Full priority: <span className="font-medium">{c.fullPriorityCount}</span></div>
        <div>Tier 0: <span className="font-medium">{c.tier0Count}</span></div>
        <div>Base Tier 1: <span className="font-medium">{c.baseTier1Count}</span></div>
        <div>Sector promoted: <span className="font-medium">{c.sectorPromotedCount}</span></div>
        <div>Wait group: <span className="font-medium">{c.cappedWaitCount}</span></div>
        <div>
          Est. saving p50: <span className="font-medium">{secs(data.p50SavedMs)}</span>
          {data.p95SavedMs != null && <span className="text-muted-foreground"> · p95 {secs(data.p95SavedMs)}</span>}
        </div>
      </div>

      <div className="mt-2 text-xs text-muted-foreground">
        latest cycle: shadow release {secs(c.shadowReleaseMs)} vs actual {secs(c.actualReleaseMs)} ·{' '}
        measured over {data.measuredCycles} cycle(s)
      </div>

      <div className="mt-1 text-xs">
        Suggestions outside the proposed cap:{' '}
        <span className={data.totalOutsideCap > 0 ? 'font-medium text-amber-600 dark:text-amber-400' : 'font-medium'}>
          {data.totalOutsideCap} of {data.totalSuggestions} ({data.outsideCapPct}%)
        </span>
        {data.outsideCapSymbols.length > 0 && (
          <span className="text-muted-foreground"> — {data.outsideCapSymbols.join(', ')}</span>
        )}
      </div>

      {(c.activeBullishSectors.length > 0 || c.activeBearishSectors.length > 0) && (
        <div className="mt-1 text-xs text-muted-foreground">
          active sectors — bullish: {c.activeBullishSectors.join(', ') || '—'} · bearish:{' '}
          {c.activeBearishSectors.join(', ') || '—'}
        </div>
      )}
    </section>
  );
}
