'use client';

/**
 * /logs — the raw server console, live. Exactly what `pnpm dev` / `docker logs`
 * prints (teed to data/logs/app-<date>.log by lib/ops/file-log.ts so it
 * survives redeploys). Terminal-style: dark, monospace, newest at the bottom,
 * auto-refreshing every 3s with auto-scroll (pausable). Admin-only, read-only.
 */

import { ArrowDownToLine, Pause, Play, Terminal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

interface LogsResponse {
  success: boolean;
  date?: string;
  totalLines?: number;
  lines?: string[];
  error?: string;
}

const lineClass = (l: string): string => {
  // Zero-count summary fields ("0 errors", "0 failed", "0 skipped") are good
  // news, not a failure — strip them before testing so a clean cycle-summary line
  // doesn't turn red just because it reports how many errors it DIDN'T have.
  //
  // Only a genuine COUNT FIELD is stripped — the zero must open one, i.e. follow
  // a line start or a `,` / `:` / `(` the way every summary emitter writes it
  // ("…498 calls, 0 errors, 174999ms", "(12 graded, 0 skipped)"). That keeps a
  // zero that NAMES something rather than counting nothing fully alarming:
  // "attempt 0 failed", "worker 0 failed", "v1.0 failed", "chunk-0 failed" all
  // stay red. A count can never be misread either — the field must begin at the
  // 0, so "10 errors" and "20 errors" are untouched. The leading delimiter is
  // captured and put back instead of using a lookbehind, so the regex parses on
  // any browser that can open this page; a SyntaxError here would break the log
  // viewer exactly when it is needed. The ERROR level tag is tested on the raw
  // line, so a tagged line is never quieted by this at all.
  const scrubbed = l.replace(/(^|[,:(]\s*)0\s+(errors?|failed|failures?|crashed|skipped)\b/gi, '$1');
  if (/ ERROR /.test(l) || /error|failed|FAIL|crashed/i.test(scrubbed)) return 'text-red-400';
  if (/ WARN /.test(l) || /warn|skip/i.test(scrubbed)) return 'text-yellow-300';
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
  const [followTail, setFollowTail] = useState(true);
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

  // Auto-scroll only while the reader is already following the tail. Scrolling
  // up suspends follow mode; reaching the bottom again resumes it.
  useEffect(() => {
    if (!paused && followTail && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [lines, paused, followTail]);

  const handleLogScroll = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    const distanceFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
    setFollowTail(distanceFromBottom <= 24);
  }, []);

  const jumpToLatest = useCallback(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
    setFollowTail(true);
  }, []);

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
              onChange={(e) => {
                setDate(e.target.value);
                setFollowTail(true);
              }}
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
            onChange={(e) => {
              setCount(Number(e.target.value));
              setFollowTail(true);
            }}
            className="h-7 rounded-md border border-border bg-background px-2 text-xs tabular-nums"
          >
            {[200, 300, 500, 1000, 2000].map((n) => (
              <option key={n} value={n}>
                last {n}
              </option>
            ))}
          </select>
          {!followTail && (
            <Button type="button" variant="outline" size="sm" onClick={jumpToLatest} className="h-7 text-xs">
              <ArrowDownToLine data-icon="inline-start" />
              Latest
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPaused((p) => !p)}
            className="h-7 text-xs"
            title={paused ? 'Resume live tail' : 'Pause (stops refresh + auto-scroll so you can read)'}
          >
            {paused ? <Play data-icon="inline-start" /> : <Pause data-icon="inline-start" />}
            {paused ? 'Resume' : 'Pause'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <div
        ref={boxRef}
        onScroll={handleLogScroll}
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
