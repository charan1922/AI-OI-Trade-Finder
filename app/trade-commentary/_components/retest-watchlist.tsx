'use client';

/**
 * Today's order-block RETEST plans — the clear calls: which zone, what to buy,
 * where the stop sits, and whether it is still waiting, triggered, missed,
 * broken or expired. Written by each 5-min scan (lib/order-blocks/retest.ts).
 */

import { Crosshair } from 'lucide-react';
import { useEffect, useState } from 'react';

interface Item {
  symbol: string;
  side: 'CE' | 'PE';
  zoneLow: number;
  zoneHigh: number;
  zoneConfirmedAt: string;
  stopSpot: number;
  status: 'waiting' | 'triggered' | 'missed' | 'broken' | 'expired';
  triggeredAt: string | null;
  ltp: number | null;
  call: string;
}

const clock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

const STATUS_STYLE: Record<Item['status'], string> = {
  triggered: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  waiting: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-300',
  missed: 'bg-muted text-muted-foreground',
  broken: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  expired: 'bg-muted text-muted-foreground',
};

export function RetestWatchlist({ pollMs = 60_000 }: { pollMs?: number }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ window: { startMin: number; endMin: number }; targetR: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch('/api/order-blocks/watchlist', { cache: 'no-store' })
        .then(async (res) => {
          const j = (await res.json().catch(() => null)) as {
            success?: boolean;
            data?: { asOf: string | null; items: Item[]; meta: { window: { startMin: number; endMin: number }; targetR: number } | null };
            error?: string;
          } | null;
          if (cancelled) return;
          if (!res.ok || !j?.success || !j.data) {
            setError(j?.error ?? `HTTP ${res.status}`);
            return;
          }
          setError(null);
          setItems(j.data.items);
          setAsOf(j.data.asOf);
          setMeta(j.data.meta);
        })
        .catch((err: Error) => {
          if (!cancelled) setError(err.message);
        });
    void load();
    const t = setInterval(() => void load(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [pollMs]);

  const order: Item['status'][] = ['triggered', 'waiting', 'missed', 'broken', 'expired'];
  const sorted = [...(items ?? [])].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));

  return (
    <div className="rounded-xl border bg-card p-2.5 shadow-sm">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
        <Crosshair className="h-3.5 w-3.5 text-primary" />
        <span className="font-semibold text-foreground">Retest watch-list</span>
        <span className="text-muted-foreground">
          order-block pullback plans
          {meta ? ` · entries ${clock(meta.window.startMin)}–${clock(meta.window.endMin)} · stop at the zone edge · ${meta.targetR}R target` : ''}
          {asOf ? ` · updated ${new Date(asOf).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })} IST` : ''}
        </span>
      </div>
      {error ? (
        <div className="text-[11px] text-muted-foreground">Watch-list unavailable: {error}</div>
      ) : items === null ? (
        <div className="text-[11px] text-muted-foreground">Loading…</div>
      ) : sorted.length === 0 ? (
        <div className="text-[11px] text-muted-foreground">
          No retest plans yet today — a name appears once it passes the TF checks and forms an order-block zone inside the entry window.
        </div>
      ) : (
        <ul className="space-y-1">
          {sorted.map((w) => (
            <li key={`${w.symbol}-${w.side}`} className="flex items-start gap-2 text-[11.5px] leading-snug">
              <span className={`mt-px shrink-0 rounded px-1.5 py-px text-[9.5px] font-bold uppercase ${STATUS_STYLE[w.status]}`}>{w.status}</span>
              <span className="text-foreground">{w.call}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1.5 text-[9.5px] text-muted-foreground">
        Zones are our documented order-block rule set (not institutional orders, not yet proven). A triggered plan becomes a
        pick for the AI trader, which still has to pass every liquidity and daily-limit gate. Paper mode.
      </div>
    </div>
  );
}
