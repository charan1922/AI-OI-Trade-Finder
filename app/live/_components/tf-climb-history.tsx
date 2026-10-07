'use client';

import { Clock3, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { TF_BOARD_ENDPOINTS } from '@/lib/tf-live/endpoints';

interface ClimbInterval {
  symbol: string;
  enteredAt: number;
  exitedAt: number | null;
  entryRank: number;
  exitRank: number | null;
}

interface RaceResponse {
  success: boolean;
  hasRace: boolean;
  climbHistory?: ClimbInterval[];
  captureStatus?: Record<string, { successCount: number; lastSuccessAt: string | null }>;
  error?: string;
}

function timeIST(value: number): string {
  return new Date(value).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function TfClimbHistory() {
  const [data, setData] = useState<RaceResponse | null>(null);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const response = await fetch('/api/tf/race', { cache: 'no-store' });
        const next = (await response.json()) as RaceResponse;
        if (!stopped) setData(next);
      } catch {
        // The next poll retries.
      }
    };
    void load();
    const timer = setInterval(load, 5 * 60_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  const intervals = data?.climbHistory ?? [];
  // Board captures today, whichever feed carried them (TF_BOARD_ENDPOINTS).
  const boardCaptures = TF_BOARD_ENDPOINTS.reduce((n, e) => n + (data?.captureStatus?.[e]?.successCount ?? 0), 0);
  const marketPulse = data?.captureStatus?.market_pulse;

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center gap-1.5 border-b border-border px-2 py-1">
        <Clock3 className="h-3.5 w-3.5 text-violet-500" />
        <h2 className="text-[12px] font-semibold tracking-wide text-foreground uppercase">Climbed stocks</h2>
        <span className="ml-auto text-[9px] text-muted-foreground">entry / exit IST</span>
      </header>
      <div className="p-2">
        {!data ? (
          <p className="flex items-center justify-center gap-2 py-4 text-[11px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </p>
        ) : !data.success ? (
          <p className="py-3 text-center text-[10px] text-red-600">{data.error ?? 'Unavailable'}</p>
        ) : intervals.length > 0 ? (
          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {intervals.map((item, index) => (
              <button
                type="button"
                key={`${item.symbol}-${item.enteredAt}-${index}`}
                onClick={() =>
                  window.open(
                    `https://in.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(item.symbol)}&interval=5`,
                    '_blank',
                    'noopener,noreferrer'
                  )
                }
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded border border-border bg-muted/20 px-2 py-1 text-left hover:bg-muted/50"
              >
                <span>
                  <span className="block truncate text-[11px] font-semibold text-foreground">{item.symbol}</span>
                  <span className="text-[9px] text-muted-foreground">entered #{item.entryRank}</span>
                </span>
                <span className="text-right text-[9px] tabular-nums">
                  <span className="text-emerald-600 dark:text-emerald-400">{timeIST(item.enteredAt)}</span>
                  <span className="mx-1 text-muted-foreground">→</span>
                  <span className={item.exitedAt == null ? 'font-semibold text-violet-600 dark:text-violet-400' : 'text-muted-foreground'}>
                    {item.exitedAt == null ? 'active' : timeIST(item.exitedAt)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-1 py-3 text-center text-[10px] text-muted-foreground">
            <p>No climbed-stock interval is available yet.</p>
            {boardCaptures === 0 &&
            (marketPulse?.successCount ?? 0) > 0 ? (
              <p className="rounded border border-amber-300/50 bg-amber-50 px-2 py-1 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                Market Pulse is capturing, but no TradeFinder R-Factor board response has been captured today.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
