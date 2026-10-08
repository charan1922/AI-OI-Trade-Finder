'use client';

import { Clock3, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

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
  error?: string;
}

/** One chip per stock: a name that climbed twice shows once — active if any of
 *  its climbs is still running, with the rank of its latest climb. */
function chipsFrom(intervals: ClimbInterval[]): { symbol: string; rank: number; active: boolean }[] {
  const bySymbol = new Map<string, { symbol: string; rank: number; active: boolean; at: number }>();
  for (const i of intervals) {
    const prev = bySymbol.get(i.symbol);
    const active = (prev?.active ?? false) || i.exitedAt == null;
    if (!prev || i.enteredAt >= prev.at) bySymbol.set(i.symbol, { symbol: i.symbol, rank: i.entryRank, active, at: i.enteredAt });
    else prev.active = active;
  }
  // Active first, then the most recent climb.
  return [...bySymbol.values()].sort((x, y) => Number(y.active) - Number(x.active) || y.at - x.at);
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

  const chips = chipsFrom(data?.climbHistory ?? []);
  const activeCount = chips.filter((c) => c.active).length;

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center gap-1.5 border-b border-border px-2 py-1">
        <Clock3 className="h-3.5 w-3.5 text-violet-500" />
        <h2 className="text-[12px] font-semibold tracking-wide text-foreground uppercase">Climbed stocks</h2>
        {chips.length > 0 && (
          <span className="ml-auto text-[9px] text-muted-foreground">
            {activeCount} active · {chips.length - activeCount} out
          </span>
        )}
      </header>
      <div className="p-2">
        {!data ? (
          <p className="flex items-center justify-center gap-2 py-4 text-[11px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </p>
        ) : !data.success ? (
          <p className="py-3 text-center text-[10px] text-red-600">{data.error ?? 'Unavailable'}</p>
        ) : chips.length > 0 ? (
          <div className="flex max-h-72 flex-wrap gap-1 overflow-y-auto">
            {chips.map((c) => (
              <a
                key={c.symbol}
                href={`https://in.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(c.symbol)}&interval=5`}
                target="_blank"
                rel="noopener noreferrer"
                title={`${c.symbol} — climbed into #${c.rank}; ${c.active ? 'still climbing' : 'no longer climbing'}. Open chart.`}
                className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted/50 ${
                  c.active ? 'border-violet-400/50 bg-violet-500/5' : 'border-border bg-muted/20 opacity-60'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${c.active ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
                <span className="font-semibold text-foreground">{c.symbol}</span>
                <span className="tabular-nums text-muted-foreground">#{c.rank}</span>
              </a>
            ))}
          </div>
        ) : (
          <p className="py-3 text-center text-[10px] text-muted-foreground">No stock has climbed TF&apos;s board yet today.</p>
        )}
      </div>
    </section>
  );
}
