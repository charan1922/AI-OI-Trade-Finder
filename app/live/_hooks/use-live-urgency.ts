'use client';

import { useCallback, useEffect, useState } from 'react';
import type { LiveQuoteResponse, LiveUrgencyRow } from '../_lib/types';

/** Quote API is 1 req/sec; one request covers the whole watchlist, so a few
 *  seconds between polls is comfortably within budget. */
const POLL_MS = 4000;

export function useLiveUrgency(symbols: string[]) {
  const symbolsKey = symbols.join(',');
  const [rows, setRows] = useState<LiveUrgencyRow[]>([]);
  const [marketOpen, setMarketOpen] = useState<boolean | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchOnce = useCallback(async () => {
    // No watchlist yet (auto-pick still loading or cleared) — nothing to poll.
    if (!symbolsKey) {
      setRows([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/live/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols: symbolsKey.split(',') }),
      });
      const d = (await res.json()) as LiveQuoteResponse;
      if (d.success) {
        setMarketOpen(d.marketOpen);
        setRows(d.rows ?? []);
        setAsOf(d.asOf ?? null);
        setError(null);
      } else {
        setError(d.error ?? 'Failed to fetch live quotes');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [symbolsKey]);

  useEffect(() => {
    let stopped = false;
    const tick = () => {
      if (!stopped) void fetchOnce();
    };
    tick(); // immediate fetch on mount / watchlist change
    const id = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [fetchOnce]);

  return { rows, marketOpen, asOf, loading, error, refresh: fetchOnce };
}
