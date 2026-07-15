'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useCategoryUrgency } from '../_hooks/use-category-urgency';
import type { SectorPick, WatchlistSource } from '../_lib/types';
import { UrgencyTable } from './urgency-table';

const fmtTime = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleTimeString('en-IN', { hour12: false }) : '—';

/** Mover symbols as plain chips — used after hours, when there's no live depth to show. */
function PickChips({ picks }: { picks: SectorPick[] }) {
  return (
    <div className="flex flex-wrap gap-1 px-2 py-1.5">
      {picks.map((p) => (
        <span
          key={p.symbol}
          title={`${p.sector} · ${p.retPct >= 0 ? '+' : ''}${p.retPct.toFixed(2)}%`}
          className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px]"
        >
          <span className="font-semibold text-foreground">{p.symbol}</span>
          <span className={p.retPct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
            {p.retPct >= 0 ? '+' : ''}
            {p.retPct.toFixed(1)}%
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * One Live Urgency category panel (e.g. OI Build-up), loaded independently via
 * useCategoryUrgency. While the market is open it shows the live depth table; off
 * hours it shows the mover names as chips with an honest "no live depth" note —
 * the order book only exists during market hours and is never fabricated.
 */
export function CategorySection({
  source,
  title,
  icon,
  staggerIndex,
  headerRight,
  refreshSignal,
  onStatus,
}: {
  source: WatchlistSource;
  title: string;
  icon?: React.ReactNode;
  staggerIndex: number;
  headerRight?: React.ReactNode;
  /** Increments when the page's "Refresh all" is clicked; 0 = initial (ignored). */
  refreshSignal: number;
  onStatus?: (marketOpen: boolean | null, asOf: string | null) => void;
}) {
  const {
    picks,
    meta,
    rows,
    sectors,
    marketOpen,
    snapshot,
    snapshotDate,
    asOf,
    listLoading,
    quoteLoading,
    error,
    refresh,
  } = useCategoryUrgency(source, staggerIndex);

  // Lift market-open / last-update up to the page header. Guarded so it only
  // reports real values (the page de-dupes identical updates).
  useEffect(() => {
    onStatus?.(marketOpen, asOf);
  }, [marketOpen, asOf, onStatus]);

  // "Refresh all" from the page — fire on signal change only (latest-ref avoids
  // re-firing when `refresh`'s identity changes as this section's symbols update).
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  useEffect(() => {
    if (refreshSignal === 0) return;
    refreshRef.current();
  }, [refreshSignal]);

  const busy = listLoading || quoteLoading;

  let body: React.ReactNode;
  if (error && picks.length === 0) {
    body = <div className="px-2 py-3 text-center text-[11px] text-red-600 dark:text-red-400">{error}</div>;
  } else if (listLoading && picks.length === 0) {
    body = (
      <div className="flex items-center justify-center gap-1.5 px-2 py-3 text-[11px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-primary" /> Loading movers…
      </div>
    );
  } else if (picks.length === 0) {
    body = (
      <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">
        No tradeable F&amp;O names in this feed right now.
      </div>
    );
  } else if (marketOpen === false && snapshot && rows.length > 0) {
    // After hours: the last RECORDED state of the most recent session — real
    // captured values (OI, R-Factor, price), with the bid/ask book absent
    // because it no longer exists. Live depth resumes at the next open.
    body = (
      <>
        <p className="border-b border-amber-300/40 bg-amber-50 px-2.5 py-1 text-[10px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          Closing snapshot · {snapshotDate ?? 'last session'} — the day&apos;s final recorded values (no live order book
          after close). Live depth resumes at the next open.
        </p>
        <UrgencyTable rows={rows} sectors={sectors} />
      </>
    );
  } else if (marketOpen === false) {
    // After hours with nothing recorded (fresh install): show the mover names
    // (NSE data, available off-hours) — depth/urgency are never synthesized.
    body = (
      <>
        <PickChips picks={picks} />
        <p className="border-t border-border/50 px-2.5 py-1.5 text-[10px] text-muted-foreground">
          Market closed (NSE 9:15–15:30 IST) — nothing recorded for this list&apos;s names in the last session; live
          depth, spread &amp; OI urgency resume at the open.
        </p>
      </>
    );
  } else if (rows.length === 0) {
    body = (
      <div className="flex items-center justify-center gap-1.5 px-2 py-3 text-[11px] text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        {marketOpen === null ? 'Connecting to the live quote feed…' : 'Fetching live depth…'}
      </div>
    );
  } else {
    body = <UrgencyTable rows={rows} sectors={sectors} />;
  }

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1">
        <div className="flex items-center gap-1.5">
          {icon}
          <h2 className="text-[12px] font-semibold tracking-wide text-foreground uppercase">{title}</h2>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {picks.length} F&amp;O
          </span>
          {meta?.excludedAvoid ? (
            <span className="text-[10px] text-muted-foreground/70">· {meta.excludedAvoid} avoid-band hidden</span>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {headerRight}
          {asOf && (
            <span
              className="text-[10px] text-muted-foreground tabular-nums"
              title="When this section's quotes last updated"
            >
              live {fmtTime(asOf)}
            </span>
          )}
          <button
            type="button"
            onClick={refresh}
            disabled={busy}
            title="Rebuild this list from NSE and re-poll its live quotes"
            className="flex items-center gap-1 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>
      {body}
    </section>
  );
}
