'use client';

import { Flame, Gauge, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { CategorySection } from './_components/category-section';
import { ClimbersSection } from './_components/climbers-section';
import { HowToRead } from './_components/how-to-read';
// NiftyMarketContext hidden for now, in favor of TfRaceCard (operator request,
// 2026-08-06) — not deleted, just not rendered; restore by swapping the card below.
// import { NiftyMarketContext } from './_components/nifty-market-context';
import { TfRaceCard } from './_components/tf-race-card';

// Live depth split by category, mirroring the /nse/movers panels. Each section
// loads independently — its own F&O-gated mover list + its own live-quote poll —
// and the shared quote scheduler keeps total Dhan quote traffic within the 1
// req/sec limit. A stock can appear in more than one category, exactly as on
// /nse/movers (the sections are intentionally NOT de-duplicated against each other).

// NSE pulse feeds the sections read through (same shared 30s server cache the
// /nse/movers page warms). Pre-warmed on mount so the first list fetch is instant.
const WARM_FEEDS = ['oiSpurts', 'mostActiveValue', 'mostActiveVolume', 'gainers', 'losers'];

const segCls = (on: boolean): string =>
  `rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
    on ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
  }`;

export default function LiveUrgencyPage() {
  // Most Active mirrors /nse/movers' value/volume toggle (switches the feed).
  const [activeBy, setActiveBy] = useState<'value' | 'volume'>('value');
  // Market status + last-update are lifted from the sections (any section reports).
  const [marketOpen, setMarketOpen] = useState<boolean | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  // Bumped by "Refresh all" — every section refreshes when this changes.
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Pre-warm NSE pulse feeds (shared 30s server cache) so each section's
  // nse-watchlist call hits a warm cache instead of cold-missing into NSE's ~9s
  // timeout. Staggered to stay under NSE's burst throttle.
  useEffect(() => {
    const timers = WARM_FEEDS.map((f, i) =>
      setTimeout(() => {
        void fetch(`/api/nse/pulse/${f}`).catch(() => {});
      }, i * 400)
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  // Sections call this on every quote poll; de-dupe so the header re-renders only
  // when the market-open flag flips or the timestamp actually advances.
  const handleStatus = useCallback((open: boolean | null, when: string | null) => {
    if (open !== null) setMarketOpen((prev) => (prev === open ? prev : open));
    if (when) setAsOf((prev) => (prev && prev >= when ? prev : when));
  }, []);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-2 p-3">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <Gauge className="h-4 w-4 text-primary" />
        <h1 className="text-base font-bold text-foreground">Live Urgency</h1>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          NSE movers · live depth by category
        </span>
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
            onClick={() => setRefreshNonce((n) => n + 1)}
            title="Rebuild every category's list from NSE and re-poll live quotes"
            className="flex items-center gap-1 rounded-md bg-muted px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-accent"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh all
          </button>
        </div>
      </div>

      {/* Equal halves (operator, 2026-08-13) — the two climber boards are peers,
          so neither gets more room than the other. minmax(0,1fr) rather than a
          bare 1fr: a grid track's default min-content floor would let either
          card's widest row push the column past 50% and overflow the page. */}
      <div className="grid items-start gap-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <TfRaceCard />

        {/* Rank-momentum across the NSE feeds, above the static tables */}
        <ClimbersSection refreshSignal={refreshNonce} />
      </div>

      {/* Category sections — each loads independently, like the /nse/movers panels */}
      <CategorySection
        source="nse-oi"
        title="F&O OI Build-up"
        icon={<TrendingUp className="h-3.5 w-3.5 text-violet-500" />}
        staggerIndex={0}
        refreshSignal={refreshNonce}
        onStatus={handleStatus}
      />

      <CategorySection
        source={activeBy === 'value' ? 'nse-active-value' : 'nse-active-volume'}
        title="Most Active"
        icon={<Flame className="h-3.5 w-3.5 text-amber-500" />}
        staggerIndex={1}
        refreshSignal={refreshNonce}
        onStatus={handleStatus}
        headerRight={
          <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
            <button type="button" onClick={() => setActiveBy('value')} className={segCls(activeBy === 'value')}>
              Value
            </button>
            <button type="button" onClick={() => setActiveBy('volume')} className={segCls(activeBy === 'volume')}>
              Volume
            </button>
          </div>
        }
      />

      <CategorySection
        source="nse-gainers"
        title="Top Gainers (F&O)"
        icon={<TrendingUp className="h-3.5 w-3.5 text-emerald-500" />}
        staggerIndex={2}
        refreshSignal={refreshNonce}
        onStatus={handleStatus}
      />

      <CategorySection
        source="nse-losers"
        title="Top Losers (F&O)"
        icon={<TrendingDown className="h-3.5 w-3.5 text-red-500" />}
        staggerIndex={3}
        refreshSignal={refreshNonce}
        onStatus={handleStatus}
      />

      <p className="text-[10px] text-muted-foreground">
        Live depth from Dhan, mover lists from NSE&apos;s public feeds — the same lists as{' '}
        <span className="font-mono">/nse/movers</span>, gated to F&amp;O names with a live future (no
        &lsquo;avoid&rsquo; lot-size band). Each section refreshes its list every 60s and re-polls live quotes every
        ~5s; quote requests are rate-limited to stay within Dhan&apos;s 1 req/sec.
      </p>
    </div>
  );
}
