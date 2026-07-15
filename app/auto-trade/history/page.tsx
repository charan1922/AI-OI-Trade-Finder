'use client';

/**
 * /auto-trade/history — EOD auto-trade history. Same day-picker pattern as the
 * other EOD pages (/live/history): a date dropdown + older/newer nav shows that
 * day's executed trades and its realized P&L. Admin-only (inherits the
 * /auto-trade sub-path rule in lib/auth/rbac.ts). Read-only; no broker/AI calls.
 */

import { CalendarClock, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

interface Trade {
  id: number;
  symbol: string;
  direction: string;
  optionType: string;
  strike: number;
  lots: number;
  mode: string;
  status: string;
  entryFillPremium: number | null;
  exitFillPremium: number | null;
  exitReason: string | null;
  realizedPnlRupees: number | null;
  openedAt: string | null;
}
interface Summary {
  trades: number;
  wins: number;
  losses: number;
  flat: number;
  pnl: number;
  winRatePct: number | null;
  avgPnl: number;
}
interface HistoryResponse {
  success: boolean;
  date?: string;
  trades?: Trade[];
  summary?: Summary;
  error?: string;
}

const inr = (n: number) => `${n >= 0 ? '+' : '−'}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
const pnlClass = (n: number | null) =>
  n == null || n === 0
    ? 'text-muted-foreground'
    : n > 0
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-red-600 dark:text-red-400';
const navCls = (disabled: boolean) =>
  `flex h-7 w-7 items-center justify-center rounded-md border border-border ${disabled ? 'opacity-30' : 'hover:bg-accent'}`;

export default function AutoTradeHistoryPage() {
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState<string>('');
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load the available trade dates once, default to the latest.
  useEffect(() => {
    fetch('/api/auto-trade/history?dates=true')
      .then((r) => r.json())
      .then((d: { success: boolean; dates?: string[]; error?: string }) => {
        if (d.success && d.dates?.length) {
          setDates(d.dates);
          setDate(d.dates[0]);
        } else {
          setError(d.error ?? 'No auto-trades recorded yet');
          setLoading(false);
        }
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!date) return;
    let stopped = false;
    const run = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/auto-trade/history?date=${date}`);
        const json = (await res.json()) as HistoryResponse;
        if (stopped) return;
        if (json.success) {
          setData(json);
          setError(null);
        } else {
          setError(json.error ?? 'Failed to load day');
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        if (!stopped) setLoading(false);
      }
    };
    void run();
    return () => {
      stopped = true;
    };
  }, [date]);

  const idx = dates.indexOf(date);
  const goOlder = () => idx >= 0 && idx < dates.length - 1 && setDate(dates[idx + 1]);
  const goNewer = () => idx > 0 && setDate(dates[idx - 1]);

  const trades = data?.trades ?? [];
  const s = data?.summary;

  return (
    <div className="mx-auto max-w-5xl space-y-2 p-3">
      {/* Header + date picker (same pattern as /live/history) */}
      <div className="flex flex-wrap items-center gap-2">
        <CalendarClock className="h-5 w-5 text-primary" />
        <h1 className="text-base font-bold text-foreground">Auto Trade — EOD History</h1>
        <span
          className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-500/10 dark:text-sky-400"
          title="Executed auto-trades per day (paper + live). Realized P&L is booked at close; open/pending rows show in the log but not the day stats."
        >
          auto_trades · per day
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" aria-label="Older day" onClick={goOlder} className={navCls(idx >= dates.length - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </button>
          <select
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-7 rounded-md border border-border bg-background px-2 text-xs tabular-nums"
          >
            {dates.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <button type="button" aria-label="Newer day" onClick={goNewer} className={navCls(idx <= 0)}>
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Day summary strip */}
      {s && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
          <span className="text-muted-foreground">
            <span className="font-semibold text-foreground">{s.trades}</span> closed
          </span>
          <span className="text-muted-foreground">
            W/L <span className="font-semibold text-foreground">{s.wins}</span>/{s.losses}
          </span>
          <span className="text-muted-foreground">
            win rate <span className="font-semibold text-foreground">{s.winRatePct == null ? '—' : `${s.winRatePct}%`}</span>
          </span>
          <span className="text-muted-foreground">
            avg <span className={`font-semibold ${pnlClass(s.avgPnl)}`}>{s.trades > 0 ? inr(s.avgPnl) : '—'}</span>
          </span>
          <span className="ml-auto text-muted-foreground">
            day P&L <span className={`text-sm font-bold ${pnlClass(s.pnl)}`}>{inr(s.pnl)}</span>
          </span>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-border p-8 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          Loading day…
        </div>
      )}

      {data && trades.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="p-2 text-left">Contract</th>
                <th className="p-2 text-left">Dir</th>
                <th className="p-2 text-right">Entry</th>
                <th className="p-2 text-right">Exit</th>
                <th className="p-2 text-right">P&L</th>
                <th className="p-2 text-left">Status</th>
                <th className="p-2 text-left">Exit reason</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((r) => (
                <tr key={r.id} className="border-b border-border/50 align-top last:border-0">
                  <td className="p-2">
                    <span className="font-medium">{r.symbol}</span>{' '}
                    <span className="text-muted-foreground">
                      {r.strike}
                      {r.optionType}
                    </span>
                    {r.mode !== 'paper' && <span className="ml-1 text-[10px] uppercase text-amber-600">{r.mode}</span>}
                  </td>
                  <td className="p-2 text-xs text-muted-foreground">{r.direction}</td>
                  <td className="p-2 text-right tabular-nums">{r.entryFillPremium != null ? `₹${r.entryFillPremium}` : '—'}</td>
                  <td className="p-2 text-right tabular-nums">{r.exitFillPremium != null ? `₹${r.exitFillPremium}` : '—'}</td>
                  <td className={`p-2 text-right font-semibold tabular-nums ${pnlClass(r.realizedPnlRupees)}`}>
                    {r.realizedPnlRupees != null ? inr(r.realizedPnlRupees) : '—'}
                  </td>
                  <td className="p-2 text-xs text-muted-foreground">{r.status}</td>
                  <td className="p-2 text-xs text-muted-foreground">{r.exitReason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && trades.length === 0 && !loading && (
        <div className="rounded-lg border border-border bg-card px-3 py-6 text-center text-[11px] text-muted-foreground">
          No auto-trades on this day.
        </div>
      )}

      <p className="text-[10px] text-muted-foreground">
        Each row is one executed auto-trade for the selected day. Entry/Exit are the actual fill premiums (never
        fabricated — &ldquo;—&rdquo; until the broker confirms); P&amp;L = (exit − entry) × lot size × lots, booked at
        close. Paper and live trades share this log; live rows are tagged. For today&apos;s open positions and the live
        console, see <span className="font-mono">Auto Trade</span>.
      </p>
    </div>
  );
}
