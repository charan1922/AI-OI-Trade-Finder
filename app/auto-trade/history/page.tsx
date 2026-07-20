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
  /** Would-have figures for failed entries (backfilled from real candles) —
   *  hypothetical, shown in muted italics, never in the day's real P&L. */
  shadowEntryPremium: number | null;
  shadowExitPremium: number | null;
  shadowExitReason: string | null;
  shadowPnlRupees: number | null;
  /** Quant SHADOW metrics (measurement only — never gates a live entry/exit).
   *  See lib/auto-trade/quant/reanchor.ts. */
  entryChangePctOpen: number | null;
  entryForwardRR: number | null;
  shadowMfeR: number | null;
  shadowMaeR: number | null;
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

const fmtR = (n: number | null) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}R`);

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
                <th
                  className="p-2 text-left"
                  title="SHADOW measurement only — never gated this trade's entry or exit. chgOpen = how far the stock had already moved from the day's open when the fill confirmed (late-chase signal). fwdRR = reward:risk still available to the stored target from that fill. mfe/mae = best/worst spot-R reached after entry (candle high/low, entry candle excluded)."
                >
                  Entry timing (shadow)
                </th>
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
                  <td className="p-2 text-right tabular-nums">
                    {r.entryFillPremium != null ? (
                      `₹${r.entryFillPremium}`
                    ) : r.shadowEntryPremium != null ? (
                      <span className="text-muted-foreground italic" title="Would-have (paper) — hypothetical, replayed from real candles">
                        ₹{r.shadowEntryPremium}*
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="p-2 text-right tabular-nums">
                    {r.exitFillPremium != null ? (
                      `₹${r.exitFillPremium}`
                    ) : r.shadowExitPremium != null ? (
                      <span className="text-muted-foreground italic" title="Would-have (paper) — hypothetical, replayed from real candles">
                        ₹{r.shadowExitPremium}*
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className={`p-2 text-right font-semibold tabular-nums ${pnlClass(r.realizedPnlRupees ?? r.shadowPnlRupees)}`}>
                    {r.realizedPnlRupees != null ? (
                      inr(r.realizedPnlRupees)
                    ) : r.shadowPnlRupees != null ? (
                      <span className="italic" title="Would-have (paper) — not counted in the day's P&L">
                        {inr(r.shadowPnlRupees)}*
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="p-2 text-xs text-muted-foreground">{r.status}</td>
                  <td className="p-2 text-xs text-muted-foreground">
                    {r.exitReason ?? '—'}
                    {r.realizedPnlRupees == null && r.shadowExitReason && (
                      <span className="mt-0.5 block text-[10px] italic opacity-80">would-have: {r.shadowExitReason}</span>
                    )}
                  </td>
                  <td className="p-2 text-[11px] tabular-nums text-muted-foreground">
                    {r.entryChangePctOpen == null && r.entryForwardRR == null && r.shadowMfeR == null && r.shadowMaeR == null ? (
                      '—'
                    ) : (
                      <>
                        {r.entryChangePctOpen != null && (
                          <span className={Math.abs(r.entryChangePctOpen) >= 3 ? 'font-medium text-amber-600 dark:text-amber-400' : ''}>
                            {r.entryChangePctOpen >= 0 ? '+' : ''}
                            {r.entryChangePctOpen.toFixed(1)}% from open
                          </span>
                        )}
                        {r.entryForwardRR != null && <span className="ml-1.5">fwdRR {r.entryForwardRR.toFixed(2)}</span>}
                        {(r.shadowMfeR != null || r.shadowMaeR != null) && (
                          <span className="mt-0.5 block text-[10px] opacity-80">
                            mfe {fmtR(r.shadowMfeR)} · mae {fmtR(r.shadowMaeR)}
                          </span>
                        )}
                      </>
                    )}
                  </td>
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
        console, see <span className="font-mono">Auto Trade</span>.{' '}
        <span className="italic">
          Values marked <span className="font-semibold">*</span> are would-have (paper) figures for entries that failed
          to reach the broker — replayed from real candles and NOT counted in the day&apos;s P&amp;L.
        </span>{' '}
        <span className="italic">
          &ldquo;Entry timing (shadow)&rdquo; is measurement only — recorded AFTER the fill, it never changed this
          trade&apos;s entry or exit. Hover the column header for what each number means.
        </span>
      </p>
    </div>
  );
}
