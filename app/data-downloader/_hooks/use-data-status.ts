import { useCallback, useEffect, useState } from 'react';
import type { DataSummary, TradeDataStatus } from '../_lib/types';

interface StatusResponse {
  success: boolean;
  trades: TradeDataStatus[];
  summary: DataSummary;
}

export function useDataStatus() {
  const [trades, setTrades] = useState<TradeDataStatus[]>([]);
  const [summary, setSummary] = useState<DataSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pure fetch — never touches state itself, so the effect below stays free of
  // synchronous setState (react-hooks/set-state-in-effect).
  const fetchStatus = useCallback(async (): Promise<{ data: StatusResponse | null; error: string | null }> => {
    try {
      const res = await fetch('/api/backtest/tf-validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'symbol-status' }),
      });
      const data = (await res.json()) as StatusResponse & { error?: string };
      if (!data.success) return { data: null, error: data.error ?? `Status request failed (HTTP ${res.status})` };
      return { data, error: null };
    } catch (e) {
      return { data: null, error: (e as Error).message };
    }
  }, []);

  // Manual refresh (button / post-download) — setState in a click handler is fine.
  const refresh = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await fetchStatus();
    if (data) {
      setTrades(data.trades);
      setSummary(data.summary);
    }
    setError(err);
    setLoading(false);
  }, [fetchStatus]);

  // Initial load — setState only inside the async callback (never synchronously
  // in the effect body) to avoid cascading renders.
  useEffect(() => {
    let ignore = false;
    fetchStatus().then(({ data, error: err }) => {
      if (ignore) return;
      if (data) {
        setTrades(data.trades);
        setSummary(data.summary);
      }
      setError(err);
      setLoading(false);
    });
    return () => {
      ignore = true;
    };
  }, [fetchStatus]);

  return { trades, summary, loading, error, refresh };
}
