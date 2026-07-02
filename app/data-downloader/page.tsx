'use client';

import { Database, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { BhavcopySync } from './_components/bhavcopy-sync';
import { TradeContextView } from './_components/trade-context-view';
import { TradeList, tradeKey } from './_components/trade-list';
import { useDataStatus } from './_hooks/use-data-status';
import type { TradeDataStatus } from './_lib/types';

export default function BacktestDataPage() {
  const { trades, loading, error, refresh } = useDataStatus();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  // After a bhavcopy sync, refresh the list status (ready/partial counts) and the
  // open trade's context.
  const onSynced = useCallback(() => {
    refresh();
    setRefreshToken((n) => n + 1);
  }, [refresh]);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'ready' | 'partial' | 'missing'>('all');
  const [showUnverified, setShowUnverified] = useState(false);

  // Base set respects the verified toggle; header counts read from it.
  const base = useMemo(
    () => (showUnverified ? trades : trades.filter((t) => t.humanReview)),
    [trades, showUnverified],
  );

  const counts = useMemo(
    () => ({
      total: base.length,
      ready: base.filter((t) => t.status === 'ready').length,
      partial: base.filter((t) => t.status === 'partial').length,
      missing: base.filter((t) => t.status === 'missing').length,
    }),
    [base],
  );

  const filtered = useMemo(() => {
    let list = base;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((t) => t.symbol.toLowerCase().includes(q) || t.date.includes(q));
    }
    if (statusFilter !== 'all') {
      list = list.filter((t) => t.status === statusFilter);
    }
    return list;
  }, [base, search, statusFilter]);

  // Default to the first visible trade until the user picks one (derived, not an
  // effect — avoids a cascading render on load).
  const effectiveKey = useMemo(
    () => selectedKey ?? (filtered.length > 0 ? tradeKey(filtered[0]) : null),
    [selectedKey, filtered],
  );

  // Selection persists across refreshes; resolve against the full trade list so a
  // freshly-downloaded trade keeps its detail open.
  const selectedTrade = useMemo<TradeDataStatus | null>(
    () => trades.find((t) => tradeKey(t) === effectiveKey) ?? null,
    [trades, effectiveKey],
  );

  return (
    <div className="p-3 mx-auto max-w-[1600px] space-y-2.5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5">
          <Database className="w-4 h-4 text-primary" />
          <h1 className="text-base font-bold text-foreground">TradeFinder Trade Context</h1>
          <div className="flex items-center gap-1.5 text-[11px] ml-1">
            <span className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-300 dark:border-emerald-500/20 font-mono">
              {counts.ready} ready
            </span>
            {counts.partial > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-300 dark:border-amber-500/20 font-mono">
                {counts.partial} partial
              </span>
            )}
            <span className="px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-500/10 text-red-600/80 dark:text-red-400/70 border border-red-300 dark:border-red-500/20 font-mono">
              {counts.missing} missing
            </span>
            <span className="text-muted-foreground">of {counts.total}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          title="Refresh the ready / partial / missing counts for the whole list (global — not tied to one stock)"
          className="flex items-center gap-1 p-1.5 rounded-md bg-muted hover:bg-accent text-muted-foreground text-[11px] disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>Refresh list</span>
        </button>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search symbol or date…"
          className="flex-1 max-w-[220px] px-2.5 py-1 rounded-md bg-card border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          className="px-2 py-1 rounded-md bg-card border border-border text-xs text-foreground focus:outline-none focus:border-primary"
        >
          <option value="all">All</option>
          <option value="ready">Ready</option>
          <option value="partial">Partial</option>
          <option value="missing">Missing</option>
        </select>
        <button
          type="button"
          onClick={() => setShowUnverified((v) => !v)}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium transition-colors ${
            showUnverified
              ? 'bg-muted text-muted-foreground border-border'
              : 'bg-amber-100 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-500/30'
          }`}
          title="Toggle between human-verified trades only and all 'Trade Taken' trades"
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          {showUnverified ? 'All trades' : 'Verified only'}
        </button>
        <BhavcopySync onSynced={onSynced} />
        <span className="text-[10px] text-muted-foreground ml-auto">{filtered.length} shown</span>
      </div>

      {/* Master / detail — list left, context right */}
      {loading && trades.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Loading trade data status…</div>
      ) : error && trades.length === 0 ? (
        <div className="text-center py-12 text-red-600 dark:text-red-400 text-sm">
          Failed to load the trade list: {error} — click &ldquo;Refresh list&rdquo; to retry.
        </div>
      ) : (
        <div className="flex gap-3 items-start">
          <aside className="w-72 shrink-0 sticky top-2 max-h-[calc(100vh-8.5rem)] overflow-y-auto">
            <TradeList trades={filtered} selectedKey={effectiveKey} onSelect={(t) => setSelectedKey(tradeKey(t))} />
          </aside>
          <main className="flex-1 min-w-0">
            <TradeContextView trade={selectedTrade} refreshToken={refreshToken} />
          </main>
        </div>
      )}
    </div>
  );
}
