'use client';

import { CalendarClock, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { UrgencyTable } from '../_components/urgency-table';
import type { LiveUrgencyRow } from '../_lib/types';

interface HistoryResponse {
  success: boolean;
  date?: string;
  count?: number;
  rows?: LiveUrgencyRow[];
  error?: string;
}

const navCls = (disabled: boolean) =>
  `flex h-7 w-7 items-center justify-center rounded-md border border-border ${
    disabled ? 'opacity-30' : 'hover:bg-accent'
  }`;

export default function LiveUrgencyHistoryPage() {
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState<string>('');
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load the available captured session dates once, default to the latest.
  useEffect(() => {
    fetch('/api/live/urgency-history?dates=true')
      .then((r) => r.json())
      .then((d: { success: boolean; dates?: string[]; error?: string }) => {
        if (d.success && d.dates?.length) {
          setDates(d.dates);
          setDate(d.dates[0]);
        } else {
          setError(d.error ?? 'No EOD board captured yet');
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
        const res = await fetch(`/api/live/urgency-history?date=${date}`);
        const json = (await res.json()) as HistoryResponse;
        if (stopped) return;
        if (json.success) {
          setData(json);
          setError(null);
        } else {
          setError(json.error ?? 'Failed to load session');
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

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const withRFactor = useMemo(() => rows.filter((r) => r.rFactor != null).length, [rows]);

  return (
    <div className="mx-auto max-w-7xl space-y-2 p-3">
      {/* Header + date picker */}
      <div className="flex flex-wrap items-center gap-2">
        <CalendarClock className="h-5 w-5 text-primary" />
        <h1 className="text-base font-bold text-foreground">Live Urgency — EOD History</h1>
        <span
          className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-500/10 dark:text-sky-400"
          title="A permanent, frozen copy of the /live board captured automatically the first time a post-market poll ran that session. Never recomputed after capture."
        >
          live_urgency_eod · frozen at close
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" aria-label="Older session" onClick={goOlder} className={navCls(idx >= dates.length - 1)}>
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
          <button type="button" aria-label="Newer session" onClick={goNewer} className={navCls(idx <= 0)}>
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
        {data?.count ?? 0} symbols captured{withRFactor > 0 ? ` (${withRFactor} scored)` : ''} · every name any /live
        category section tracked that session, not just one panel&apos;s picks.
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-border p-8 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          Loading session…
        </div>
      )}

      {data && rows.length > 0 && <UrgencyTable rows={rows} />}

      {data && rows.length === 0 && !loading && (
        <div className="rounded-lg border border-border bg-card px-3 py-6 text-center text-[11px] text-muted-foreground">
          No rows for this session.
        </div>
      )}

      <p className="text-[10px] text-muted-foreground">
        Each row is the LAST value recorded before close that day: R-Factor, OI urgency, spread and imbalance come
        from the persisted <span className="font-mono">oi_intraday</span> per-minute series; day high/low come from
        Fyers 5-min bars (same-day only — unavailable if the board was captured a day late). Bid/Ask show &ldquo;—&rdquo;
        because the order book no longer exists after close — never synthesized. For live intraday depth, see{' '}
        <span className="font-mono">Live Urgency</span>.
      </p>
    </div>
  );
}
