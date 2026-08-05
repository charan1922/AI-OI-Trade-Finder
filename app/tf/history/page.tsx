'use client';

/**
 * /tf/history — EOD TradeFinder capture browser, sibling of /nse/movers-history.
 * Reads whatever was actually captured on /tf for a given IST calendar date:
 * the per-stock `all_sector` table and the per-index `daily-index` bar values.
 *
 * Field names shown for `all_sector` are best-effort guesses (see
 * lib/tf-live/store.ts's pickNumber candidates) until a real successful
 * capture has been inspected — this page shows exactly what it finds, never
 * a fabricated value, so an unrecognized field reads as "—", not a guess.
 */

import { CalendarDays, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

interface EodResponse {
  success: boolean;
  date?: string;
  allSector?: { capturedAt: string; rows: Record<string, unknown>[] } | null;
  dailyIndex?: { capturedAt: string; rows: Record<string, unknown>[] } | null;
  error?: string;
}

const fmtDateTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

const pick = (obj: Record<string, unknown>, keys: string[]): number | null => {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
};
const fmtNum = (n: number | null): string => (n == null ? '—' : n.toFixed(2));

export default function TfHistoryPage() {
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState('');
  const [data, setData] = useState<EodResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/tf/eod?dates=true')
      .then((r) => r.json())
      .then((d: { success: boolean; dates?: string[]; error?: string }) => {
        if (d.success && d.dates?.length) {
          setDates(d.dates);
          setDate(d.dates[0]);
        } else {
          setError(d.error ?? 'No TradeFinder captures recorded yet — paste lt/at on /tf and let the collector run.');
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
    (async () => {
      try {
        const res = await fetch(`/api/tf/eod?date=${date}`);
        const json = (await res.json()) as EodResponse;
        if (stopped) return;
        if (json.success) {
          setData(json);
          setError(null);
        } else setError(json.error ?? 'Failed to load this date');
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        if (!stopped) setLoading(false);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [date]);

  const idx = dates.indexOf(date);
  const goOlder = () => idx >= 0 && idx < dates.length - 1 && setDate(dates[idx + 1]);
  const goNewer = () => idx > 0 && setDate(dates[idx - 1]);
  const navCls = (disabled: boolean) =>
    `flex h-7 w-7 items-center justify-center rounded-md border border-border ${disabled ? 'opacity-30' : 'hover:bg-accent'}`;

  const stockRows = useMemo(() => {
    const rows = data?.allSector?.rows ?? [];
    return rows
      .map((r) => ({
        symbol: String(r.symbol ?? r.Symbol ?? '—'),
        previousClose: pick(r, ['pc', 'prev_close', 'previousClose', 'prevClose', 'close']),
        pctChange: pick(r, ['pct', 'pct_change', 'pctChange', 'change_pct', 'chg_pct']),
        rFactor: pick(r, ['r_factor', 'rFactor', 'rfactor', 'param_2', 'r_fact', 'rFact']),
      }))
      .sort((a, b) => (b.rFactor ?? -Infinity) - (a.rFactor ?? -Infinity));
  }, [data]);

  const indexRows = useMemo(() => {
    const rows = data?.dailyIndex?.rows ?? [];
    return rows
      .map((r) => ({
        name: String(r.Symbol ?? r.symbol ?? '—'),
        value: pick(r, ['param_3', 'value']),
      }))
      .sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  }, [data]);

  return (
    <div className="mx-auto max-w-5xl space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <CalendarDays className="h-5 w-5 text-primary" />
        <h1 className="text-base font-bold text-foreground">TradeFinder EOD</h1>
        <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-500/10 dark:text-sky-400">
          last successful capture that day
        </span>
        {dates.length > 0 && (
          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" aria-label="Older" onClick={goOlder} className={navCls(idx >= dates.length - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </button>
            <select value={date} onChange={(e) => setDate(e.target.value)} className="h-7 rounded-md border border-border bg-background px-2 text-xs tabular-nums">
              {dates.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <button type="button" aria-label="Newer" onClick={goNewer} className={navCls(idx <= 0)}>
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-600 dark:text-red-400">{error}</div>}

      {loading && !data && (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-border p-8 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin text-primary" /> Loading…
        </div>
      )}

      {data && (
        <>
          <div className="rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-2.5 py-1">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide">Indices (daily-index)</h2>
              <span className="text-[10px] text-muted-foreground">captured {fmtDateTime(data.dailyIndex?.capturedAt)}</span>
            </div>
            {indexRows.length === 0 ? (
              <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">No daily-index capture that day.</p>
            ) : (
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 p-2 sm:grid-cols-3">
                {indexRows.map((r) => (
                  <div key={r.name} className="flex items-center justify-between gap-2 border-b border-border/30 py-0.5 text-[11px]">
                    <span className="truncate font-medium">{r.name}</span>
                    <span className={`tabular-nums font-semibold ${r.value != null && r.value < 0 ? 'text-red-500' : 'text-emerald-500'}`}>
                      {r.value != null ? `${r.value >= 0 ? '+' : ''}${r.value.toFixed(2)}` : '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-2.5 py-1">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide">Stocks (all_sector), sorted by R-Factor</h2>
              <span className="text-[10px] text-muted-foreground">captured {fmtDateTime(data.allSector?.capturedAt)}</span>
            </div>
            {stockRows.length === 0 ? (
              <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">No all_sector capture that day.</p>
            ) : (
              <div className="max-h-[60vh] overflow-auto">
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-card text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="px-2 py-1 text-left font-medium">Symbol</th>
                      <th className="px-2 py-1 text-right font-medium">Prev Close</th>
                      <th className="px-2 py-1 text-right font-medium">%</th>
                      <th className="px-2 py-1 text-right font-medium">R Factor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stockRows.map((r) => (
                      <tr key={r.symbol} className="border-b border-border/60">
                        <td className="px-2 py-1 font-medium">{r.symbol}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{fmtNum(r.previousClose)}</td>
                        <td className={`px-2 py-1 text-right tabular-nums ${r.pctChange != null && r.pctChange < 0 ? 'text-red-500' : 'text-emerald-500'}`}>
                          {r.pctChange != null ? `${r.pctChange >= 0 ? '+' : ''}${r.pctChange.toFixed(2)}%` : '—'}
                        </td>
                        <td className="px-2 py-1 text-right font-semibold tabular-nums">{fmtNum(r.rFactor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <p className="text-[10px] text-muted-foreground">
            Field names for all_sector are matched defensively against several likely candidates — the exact schema
            hasn&apos;t been confirmed from a real successful capture yet. A column reading &quot;—&quot; across every
            row (not just some) means none of the candidate names matched; check a raw capture and tighten
            lib/tf-live/store.ts&apos;s pickNumber() candidates.
          </p>
        </>
      )}
    </div>
  );
}
