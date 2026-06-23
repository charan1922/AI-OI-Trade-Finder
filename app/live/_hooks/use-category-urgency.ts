'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { scheduleQuote } from '../_lib/quote-scheduler';
import type {
  LiveQuoteResponse,
  LiveUrgencyRow,
  SectorLeadersResponse,
  SectorPick,
  WatchlistSource,
} from '../_lib/types';

// The mover LIST (which F&O names sit in this category) changes slowly — NSE's
// pulse feeds are cached ~30s server-side — so refresh it once a minute.
const LIST_POLL_MS = 60_000;
// Stagger each section's FIRST list fetch so four sections don't hit NSE's pulse
// feeds in the same instant on mount (mirrors the /nse/movers stagger).
const LIST_STAGGER_MS = 400;
// Live depth/urgency QUOTES are the fast signal. Per section; the shared scheduler
// serializes them to ≤ 1 Dhan req/sec and the in-flight guard below keeps at most
// one outstanding request per section, so the scheduler queue never grows beyond
// the section count.
const QUOTE_POLL_MS = 5_000;

export interface CategoryUrgency {
  /** The F&O-gated mover list for this category, in NSE's ranked order. */
  picks: SectorPick[];
  meta: SectorLeadersResponse['meta'] | null;
  /** Live depth rows (only while the market is open; never fabricated off-hours). */
  rows: LiveUrgencyRow[];
  sectors: Record<string, string>;
  marketOpen: boolean | null;
  asOf: string | null;
  listLoading: boolean;
  quoteLoading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * One Live Urgency category, loaded independently: its F&O-gated mover list (from
 * /api/live/nse-watchlist) on a slow staggered timer, and live depth quotes for
 * those names (via the rate-limited quote scheduler) on a fast timer. This mirrors
 * how /nse/movers runs each panel on its own feed.
 */
export function useCategoryUrgency(source: WatchlistSource, staggerIndex: number): CategoryUrgency {
  const [picks, setPicks] = useState<SectorPick[]>([]);
  const [meta, setMeta] = useState<SectorLeadersResponse['meta'] | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [rows, setRows] = useState<LiveUrgencyRow[]>([]);
  const [marketOpen, setMarketOpen] = useState<boolean | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  // ── Mover list (NSE pulse feed, F&O-gated server-side) ──────────────────────
  const fetchList = useCallback(async () => {
    try {
      const res = await fetch(`/api/live/nse-watchlist?source=${source}`);
      const d = (await res.json()) as SectorLeadersResponse;
      if (d.success) {
        setPicks(d.picks);
        setMeta(d.meta ?? null);
        setListError(null);
      } else {
        setListError(d.error ?? 'Failed to build this list');
      }
    } catch (e) {
      setListError((e as Error).message);
    } finally {
      setListLoading(false);
    }
  }, [source]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (delay: number) => {
      timer = setTimeout(async () => {
        if (stopped) return;
        await fetchList();
        if (stopped) return;
        schedule(LIST_POLL_MS);
      }, delay);
    };
    schedule(staggerIndex * LIST_STAGGER_MS); // staggered first fetch, then steady cadence
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [fetchList, staggerIndex]);

  // ── Live quotes (Dhan depth, via the rate-limited scheduler) ────────────────
  const symbolsKey = useMemo(() => picks.map((p) => p.symbol).join(','), [picks]);
  const inFlight = useRef(false);

  const fetchQuotes = useCallback(async () => {
    if (!symbolsKey) {
      setRows([]);
      return;
    }
    if (inFlight.current) return; // one outstanding quote per section bounds the scheduler queue
    inFlight.current = true;
    setQuoteLoading(true);
    try {
      const d: LiveQuoteResponse = await scheduleQuote(symbolsKey.split(','));
      if (d.success) {
        setMarketOpen(d.marketOpen);
        setRows(d.rows ?? []);
        setAsOf(d.asOf ?? null);
        setQuoteError(null);
      } else {
        setQuoteError(d.error ?? 'Failed to fetch live quotes');
      }
    } catch (e) {
      setQuoteError((e as Error).message);
    } finally {
      inFlight.current = false;
      setQuoteLoading(false);
    }
  }, [symbolsKey]);

  useEffect(() => {
    let stopped = false;
    const tick = () => {
      if (!stopped) void fetchQuotes();
    };
    tick(); // immediate fetch on mount / when this section's symbols change
    const id = setInterval(tick, QUOTE_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [fetchQuotes]);

  const sectors = useMemo(() => Object.fromEntries(picks.map((p) => [p.symbol, p.sector])), [picks]);

  const refresh = useCallback(() => {
    void fetchList();
    void fetchQuotes();
  }, [fetchList, fetchQuotes]);

  return {
    picks,
    meta,
    rows,
    sectors,
    marketOpen,
    asOf,
    listLoading,
    quoteLoading,
    error: listError ?? quoteError,
    refresh,
  };
}
