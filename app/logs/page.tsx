'use client';

/**
 * /logs — the raw server console, live. Exactly what `pnpm dev` / `docker logs`
 * prints (teed to data/logs/app-<date>.log by lib/ops/file-log.ts so it
 * survives redeploys). Terminal-style: dark, monospace, newest at the bottom,
 * auto-refreshing every 3s with auto-scroll (pausable). Admin-only, read-only.
 */

import { Pause, Play, Terminal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

interface LogsResponse {
  success: boolean;
  date?: string;
  totalLines?: number;
  lines?: string[];
  error?: string;
}

const lineClass = (l: string): string => {
  if (/ ERROR /.test(l) || /error|failed|FAIL|crashed/i.test(l)) return 'text-red-400';
  if (/ WARN /.test(l) || /warn|skip/i.test(l)) return 'text-yellow-300';
  if (/TradeSuggest|auto-trade|AutoTrade/i.test(l)) return 'text-cyan-300';
  if (/FyersPoller|FastGuard|FileLog/.test(l)) return 'text-green-400';
  return 'text-neutral-200';
};

export default function LogsPage() {
  const [lines, setLines] = useState<string[]>([]);
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState<string>('');
  const [count, setCount] = useState(300);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (d: string, n: number) => {
    try {
      const res = await fetch(`/api/logs?${d ? `date=${d}&` : ''}lines=${n}`, { cache: 'no-store' });
      const json = (await res.json()) as LogsResponse;
      if (json.success && json.lines) {
        setLines(json.lines);
        setTotal(json.totalLines ?? json.lines.length);
        setError(null);
        if (!d && json.date) setDate(json.date);
      } else {
        setError(json.error ?? 'failed to load logs');
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Available dates once.
  useEffect(() => {
    fetch('/api/logs?dates=true')
      .then((r) => r.json())
      .then((j: { success: boolean; dates?: string[] }) => {
        if (j.success && j.dates) setDates(j.dates);
      })
      .catch(() => {});
  }, []);

  // Poll every 3s unless paused.
  useEffect(() => {
    let active = true;
    const run = async () => {
      if (!active) return;
      if (!paused) await load(date, count);
      if (active) timer.current = setTimeout(run, 3000);
    };
    timer.current = setTimeout(run, 0);
    return () => {
      active = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load, date, count, paused]);

  // Auto-scroll to the newest line (like a terminal) unless paused.
  useEffect(() => {
    if (!paused && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines, paused]);

  return (
    <div className="mx-auto max-w-6xl space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Terminal className="h-5 w-5 text-primary" />
        <h1 className="text-base font-bold text-foreground">Server Logs</h1>
        <span className="text-[11px] text-muted-foreground">
          raw console (as `pnpm dev` shows) · survives redeploys · IST · {total} lines today
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {dates.length > 0 && (
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
          )}
          <select
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="h-7 rounded-md border border-border bg-background px-2 text-xs tabular-nums"
          >
            {[200, 300, 500, 1000, 2000].map((n) => (
              <option key={n} value={n}>
                last {n}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-accent"
            title={paused ? 'Resume live tail' : 'Pause (stops refresh + auto-scroll so you can read)'}
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <div
        ref={boxRef}
        className="h-[72vh] overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950 p-3 font-mono text-[11.5px] leading-relaxed"
      >
        {lines.length === 0 ? (
          <div className="text-neutral-500">
            No log lines yet for this date. The file tee starts at server boot — lines appear as the app prints them.
          </div>
        ) : (
          lines.map((l, i) => (
            <div key={`${i}-${l.slice(0, 12)}`} className={`whitespace-pre-wrap break-all ${lineClass(l)}`}>
              {l}
            </div>
          ))
        )}
      </div>

      <p className="text-[10px] text-muted-foreground">
        Tail of <span className="font-mono">data/logs/app-{date || 'YYYY-MM-DD'}.log</span> — every console line the
        server prints (poller cycles, scans, auto-trade, errors), kept 7 days. Read-only; never touches the database.
      </p>
    </div>
  );
}
