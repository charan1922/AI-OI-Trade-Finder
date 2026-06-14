'use client';

import { CalendarDays, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

interface HolidayRow {
  date: string;
  weekday: string;
  occasion: string | null;
  source: string;
}

interface CalendarData {
  holidays: HolidayRow[];
  specialWeekendSessions: { date: string; weekday: string }[];
  dataCoverage: { from: string; to: string; tradingDays: number } | null;
}

export default function HolidaysPage() {
  const [data, setData] = useState<CalendarData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    fetch('/api/market-calendar')
      .then((r) => r.json())
      .then((d) => {
        if (ignore) return;
        if (d.success) setData(d.data as CalendarData);
        else setError(d.error ?? 'Failed to load calendar');
      })
      .catch((e) => {
        if (!ignore) setError((e as Error).message);
      });
    return () => {
      ignore = true;
    };
  }, []);

  const years = data ? [...new Set(data.holidays.map((h) => h.date.slice(0, 4)))].sort() : [];

  return (
    <div className="p-4 mx-auto max-w-4xl space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2.5">
        <CalendarDays className="w-4 h-4 text-primary" />
        <h1 className="text-base font-bold text-foreground">Market Holidays</h1>
        {data?.dataCoverage && (
          <span className="text-[11px] text-muted-foreground ml-2">
            data coverage <span className="font-mono">{data.dataCoverage.from} → {data.dataCoverage.to}</span> ·{' '}
            {data.dataCoverage.tradingDays} observed trading days
          </span>
        )}
      </div>

      {/* Weekend rule + sources */}
      <div className="rounded-lg bg-card border border-border px-3 py-2.5 text-[11px] text-muted-foreground space-y-1">
        <p>
          <strong className="text-foreground">Weekends:</strong> all Saturdays &amp; Sundays are non-trading days —
          except the special sessions listed below where the market actually traded (verified from candle data).
        </p>
        <p className="flex items-center gap-1">
          <ShieldCheck className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
          <span>
            <strong className="text-foreground">Source:</strong> official NSE trading-holiday calendar
            (HolidaycalenderData.csv) — no inferred or derived entries.
          </span>
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-100 dark:bg-red-500/10 border border-red-300 dark:border-red-500/30 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}
      {!data && !error && <div className="text-center py-10 text-sm text-muted-foreground">Loading calendar…</div>}

      {/* Special weekend sessions */}
      {data && data.specialWeekendSessions.length > 0 && (
        <div className="rounded-lg bg-sky-50 dark:bg-sky-500/5 border border-sky-300 dark:border-sky-500/20 px-3 py-2.5">
          <h2 className="text-[11px] font-bold text-sky-700 dark:text-sky-300 uppercase tracking-wide mb-1">
            Special weekend trading sessions (observed)
          </h2>
          <div className="flex flex-wrap gap-2">
            {data.specialWeekendSessions.map((s) => (
              <span
                key={s.date}
                className="text-[11px] font-mono px-2 py-0.5 rounded bg-sky-100 dark:bg-sky-500/10 text-sky-700 dark:text-sky-300 border border-sky-300 dark:border-sky-500/20"
                title="Market traded this weekend day — full candle data present (e.g. Union Budget session)"
              >
                {s.date} ({s.weekday})
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Holidays grouped by year */}
      {data &&
        years.map((year) => {
          const rows = data.holidays.filter((h) => h.date.startsWith(year));
          return (
            <div key={year} className="rounded-lg bg-card border border-border overflow-hidden">
              <h2 className="px-3 py-2 bg-muted/50 text-[11px] font-bold text-muted-foreground uppercase tracking-wide">
                {year} · {rows.length} holidays
              </h2>
              <table className="w-full text-xs">
                <thead className="bg-muted/30 text-[9px] text-muted-foreground uppercase">
                  <tr>
                    <th className="text-left font-medium px-3 py-1.5 w-28">Date</th>
                    <th className="text-left font-medium px-2 py-1.5 w-24">Day</th>
                    <th className="text-left font-medium px-2 py-1.5">Occasion</th>
                    <th className="text-right font-medium px-3 py-1.5 w-20">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((h) => (
                    <tr key={h.date} className="border-t border-border/30 hover:bg-accent/30">
                      <td className="px-3 py-1.5 font-mono text-foreground">{h.date}</td>
                      <td className="px-2 py-1.5 text-muted-foreground">{h.weekday}</td>
                      <td className="px-2 py-1.5 text-foreground">
                        {h.occasion}
                        {h.occasion?.includes('*') && (
                          <span className="ml-1 text-[10px] text-amber-600 dark:text-amber-400">
                            Muhurat trading held
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-500/10 border-emerald-300 dark:border-emerald-500/20">
                          official
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
    </div>
  );
}
