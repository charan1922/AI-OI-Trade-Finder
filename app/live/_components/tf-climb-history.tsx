'use client';

/**
 * Climbed Stocks — every name that entered TF Climbers on a day (climbing inside
 * TF's Intraday Boost top 20), with WHEN it entered and when it left (operator,
 * 2026-10-08). Today updates live; any earlier day is rebuilt from the stored
 * captures, so the history needs no separate table.
 */
import { Clock3, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

interface ClimberInterval {
  symbol: string;
  enteredAt: number;
  exitedAt: number | null;
  bestRank: number;
}

interface ClimbersResponse {
  success: boolean;
  climbers?: ClimberInterval[];
  /** The day the climbers belong to. Off-hours, "today" falls back to the last session. */
  date?: string;
  /** True when "today" is really a retained earlier session (off-hours fallback). */
  stale?: boolean;
  error?: string;
}

const TODAY = 'today';
const POLL_SESSION_MS = 30_000;
const POLL_IDLE_MS = 5 * 60_000;

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** 09:15–15:30 on a weekday, IST. */
function inSession(): boolean {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const minute = Number(get('hour')) * 60 + Number(get('minute'));
  return get('weekday') !== 'Sat' && get('weekday') !== 'Sun' && minute >= 9 * 60 + 15 && minute <= 15 * 60 + 30;
}

export function TfClimbHistory() {
  const [day, setDay] = useState<string>(TODAY);
  const [dates, setDates] = useState<string[]>([]);
  const [data, setData] = useState<ClimbersResponse | null>(null);

  // Past days that have captures — for the day picker.
  useEffect(() => {
    void fetch('/api/tf/race?dates=true', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { success: boolean; dates?: string[] }) => setDates(j.success ? (j.dates ?? []) : []))
      .catch(() => setDates([]));
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const url = day === TODAY ? '/api/tf/race' : `/api/tf/race?date=${day}`;
        const next = (await (await fetch(url, { cache: 'no-store' })).json()) as ClimbersResponse;
        if (!stopped) setData(next);
      } catch {
        // The next poll retries.
      }
      // A past day does not change; only today keeps polling.
      if (!stopped && day === TODAY) timer = setTimeout(load, inSession() ? POLL_SESSION_MS : POLL_IDLE_MS);
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [day]);

  // Still in first, then the most recent entry.
  const climbers = [...(data?.climbers ?? [])].sort(
    (a, b) => Number(b.exitedAt == null) - Number(a.exitedAt == null) || b.enteredAt - a.enteredAt
  );
  const inCount = climbers.filter((c) => c.exitedAt == null).length;
  // "Live" only when the data really is today's — off-hours the route serves the last session.
  const live = day === TODAY && data?.stale !== true;

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1">
        <Clock3 className="h-3.5 w-3.5 text-violet-500" />
        <h2 className="text-[12px] font-semibold tracking-wide text-foreground uppercase">Climbed stocks</h2>
        {day === TODAY && data?.stale && data.date && (
          <span className="rounded bg-amber-100 px-1 text-[9px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
            {data.date} · not today
          </span>
        )}
        {climbers.length > 0 && (
          <span className="text-[9px] text-muted-foreground">
            {live ? `${inCount} in · ${climbers.length - inCount} out` : `${climbers.length} entries`}
          </span>
        )}
        <select
          value={day}
          onChange={(e) => {
            setData(null);
            setDay(e.target.value);
          }}
          aria-label="Day"
          className="ml-auto rounded border border-border bg-background px-1 py-0.5 text-[10px]"
        >
          <option value={TODAY}>Today</option>
          {dates.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </header>
      <div className="p-2">
        {!data ? (
          <p className="flex items-center justify-center gap-2 py-4 text-[11px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </p>
        ) : !data.success ? (
          <p className="py-3 text-center text-[10px] text-red-600">{data.error ?? 'Unavailable'}</p>
        ) : climbers.length > 0 ? (
          <div className="flex max-h-72 flex-wrap gap-1 overflow-y-auto">
            {climbers.map((c) => {
              const stillIn = c.exitedAt == null;
              return (
                <a
                  key={`${c.symbol}-${c.enteredAt}`}
                  href={`https://in.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(c.symbol)}&interval=5`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`${c.symbol} — entered TF Climbers at ${hhmm(c.enteredAt)}${
                    stillIn ? (live ? ', still in' : ', in until the last capture') : `, left at ${hhmm(c.exitedAt!)}`
                  }; best rank #${c.bestRank}. Open chart.`}
                  className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] hover:bg-muted/50 ${
                    stillIn ? 'border-violet-400/50 bg-violet-500/5' : 'border-border bg-muted/20'
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${stillIn && live ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
                  <span className="font-semibold text-foreground">{c.symbol}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {hhmm(c.enteredAt)}→{stillIn ? (live ? 'in' : 'close') : hhmm(c.exitedAt!)}
                  </span>
                  <span className="tabular-nums text-muted-foreground/70">#{c.bestRank}</span>
                </a>
              );
            })}
          </div>
        ) : (
          <p className="py-3 text-center text-[10px] text-muted-foreground">
            {live
              ? 'No stock has entered TF Climbers yet today.'
              : `No stock entered TF Climbers on ${day === TODAY ? (data.date ?? 'that day') : day}.`}
          </p>
        )}
      </div>
    </section>
  );
}
