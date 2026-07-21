'use client';

import { useEffect, useState } from 'react';

/** Latest cycle fields we render (subset of StoredPriorityCycle). */
interface LatestCycle {
  fullPriorityCount: number;
  tier0Count: number;
  baseTier1Count: number;
  sectorPromotedCount: number;
  cappedWaitCount: number;
  activeBullishSectors: string[];
  activeBearishSectors: string[];
  cappedLiveEnabled: boolean;
  sectorLiveEnabled: boolean;
}
interface ShadowSummary {
  success: boolean;
  cycles: number;
  latest: LatestCycle | null;
  totalSuggestions: number;
  totalOutsideCap: number;
  outsideCapPct: number;
  outsideCapSymbols: string[];
}

/**
 * Read-only priority-refresh SHADOW summary (MEASUREMENT ONLY — it never changes
 * what the poller waits for or how it trades, and it does not reorder anything).
 * Shows the proposed reduced-plan membership + how often a suggestion fell
 * OUTSIDE the proposed cap. Self-fetches; renders nothing until there is data.
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
        <div>Proposed wait group: <span className="font-medium">{c.cappedWaitCount}</span></div>
      </div>

      <div className="mt-2 text-xs">
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
          candidate-pool active sectors — bullish: {c.activeBullishSectors.join(', ') || '—'} · bearish:{' '}
          {c.activeBearishSectors.join(', ') || '—'}
        </div>
      )}
      <div className="mt-2 text-[11px] text-muted-foreground">
        Sector activity is read from the scan’s candidate pool (mover feeds), not the full F&amp;O heatmap — a
        first-cut shadow signal; a full-universe source lands with sector-live. Timing (“how much sooner”) is not
        measured here because this PR does not reorder the download.
      </div>
    </section>
  );
}
