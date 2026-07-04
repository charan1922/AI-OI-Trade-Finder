'use client';

import { AlertTriangle, Loader2, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

/**
 * Global daily reminder: NSE EOD (bhavcopy) data is the baseline for R-Factor,
 * the heatmap, EOD movers and trade suggestions — if it hasn't been synced for
 * the latest completed session, everything comparing "today vs 20-day average"
 * silently degrades. This banner appears on every page while the data is
 * stale, with a one-click sync. Dismissing hides it until the NEXT expected
 * session (i.e. it comes back tomorrow — the "first thing every day" nudge).
 */

interface BhavStatus {
  latestDate: string | null;
  expectedDate: string;
  stale: boolean;
  dates: number;
}

const CHECK_MS = 15 * 60 * 1000;
const DISMISS_KEY = 'bhavcopy-reminder-dismissed-for';

export function BhavcopyReminder() {
  const [status, setStatus] = useState<BhavStatus | null>(null);
  // Lazy init: read once on the client; during SSR the banner renders nothing
  // anyway (status is null until the first fetch), so no hydration mismatch.
  const [dismissedFor, setDismissedFor] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : localStorage.getItem(DISMISS_KEY),
  );
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const check = useCallback(async () => {
    try {
      const res = await fetch('/api/bhavcopy');
      const j = (await res.json()) as { success: boolean; data?: BhavStatus };
      if (j.success && j.data) setStatus(j.data);
    } catch {
      // dev server hiccup — try again next interval
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (delay: number) => {
      timer = setTimeout(async () => {
        if (stopped) return;
        await check();
        if (stopped) return;
        schedule(CHECK_MS);
      }, delay);
    };
    schedule(0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [check]);

  const sync = useCallback(async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch('/api/bhavcopy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: 10 }),
      });
      const j = (await res.json()) as { success: boolean; error?: string; status?: { latestDate?: string } };
      if (j.success) {
        setSyncMsg(`Synced — latest session now ${j.status?.latestDate ?? 'updated'}.`);
        await check();
      } else {
        setSyncMsg(`Sync failed: ${j.error ?? 'unknown error'} — NSE may be slow; retry in a minute.`);
      }
    } catch (e) {
      setSyncMsg(`Sync failed: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  }, [check]);

  const dismiss = useCallback(() => {
    if (status) {
      localStorage.setItem(DISMISS_KEY, status.expectedDate);
      setDismissedFor(status.expectedDate);
    }
  }, [status]);

  if (!status?.stale || dismissedFor === status.expectedDate) return null;

  return (
    <div className="sticky top-0 z-50 flex flex-wrap items-center gap-2 border-b border-amber-300/50 bg-amber-50 px-3 py-1.5 text-[12px] text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span>
        NSE EOD data is outdated — latest synced <b>{status.latestDate ?? 'none'}</b>, expected{' '}
        <b>{status.expectedDate}</b>. R-Factor baselines, heatmap, EOD movers &amp; trade suggestions depend on it.
      </span>
      <button
        type="button"
        onClick={() => void sync()}
        disabled={syncing}
        className="flex items-center gap-1 rounded border border-amber-400 px-2 py-0.5 font-medium hover:bg-amber-100 disabled:opacity-60 dark:hover:bg-amber-500/20"
      >
        {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        {syncing ? 'Syncing… (can take a minute)' : 'Sync now'}
      </button>
      {syncMsg && <span className="font-medium">{syncMsg}</span>}
      <button
        type="button"
        onClick={dismiss}
        title="Hide until the next expected session"
        className="ml-auto rounded p-0.5 hover:bg-amber-100 dark:hover:bg-amber-500/20"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
