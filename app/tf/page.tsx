'use client';

/**
 * /tf — TradeFinder auth panel, sibling of /dhan and /fyers.
 *
 * TradeFinder mints its own `accessToken` fresh, per request, from its own
 * frontend JS — a copied value cannot be replayed (confirmed 2026-08-08). So
 * this page runs a real headless browser on the server, logged in with
 * cookies from the operator's own TradeFinder session (see
 * lib/tf-live/browser.ts and parse-curl.ts for the full story), and simply
 * records whatever TradeFinder's own page fetches on its own polling loop.
 */

import { AlertTriangle, KeyRound, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRole } from '@/lib/auth/use-role';

const POLL_MS = 15_000;

const fmtDateTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—';

const fmtDate = (isoDate: string) =>
  new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-IN', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    weekday: 'short',
  });

function Badge({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'bad' | 'neutral';
  children: React.ReactNode;
}) {
  const cls = {
    ok: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
    warn: 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
    bad: 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400',
    neutral: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-500/10 dark:text-zinc-400',
  }[tone];
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>{children}</span>;
}

interface TfSession {
  success: boolean;
  session: {
    configured: boolean;
    updatedAt: string | null;
    verifiedAt: string | null;
    lastError: string | null;
    jwtExpiresAt: string | null;
  };
  captures: { endpoint: string; capturedAt: string; status: string; error: string | null }[];
  history: {
    captureDate: string;
    endpoint: string;
    total: number;
    success: number;
    error: number;
    lastCapturedAt: string;
    lastSuccessAt: string | null;
  }[];
}

interface TfBrowserSession {
  success: boolean;
  session: { configured: boolean; updatedAt: string | null; verifiedAt: string | null; lastError: string | null };
  running: boolean;
  error?: string;
}

export default function TfPage() {
  const { readOnly } = useRole();
  const [data, setData] = useState<TfSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'bad' } | null>(null);
  const [browserSession, setBrowserSession] = useState<TfBrowserSession | null>(null);
  const [pastedCurl, setPastedCurl] = useState('');
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserNotice, setBrowserNotice] = useState<{ text: string; tone: 'ok' | 'bad' } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/tf/session', { cache: 'no-store' });
      const j = (await res.json()) as TfSession;
      if (j.success) setData(j);
    } catch {
      /* transient — next poll retries */
    }
  }, []);

  const refreshBrowserSession = useCallback(async () => {
    try {
      const res = await fetch('/api/tf/browser-session', { cache: 'no-store' });
      const j = (await res.json()) as TfBrowserSession;
      if (j.success) setBrowserSession(j);
    } catch {
      /* transient — next poll retries */
    }
  }, []);

  const refreshRef = useRef(refresh);
  const refreshBrowserRef = useRef(refreshBrowserSession);
  useEffect(() => {
    refreshRef.current = refresh;
    refreshBrowserRef.current = refreshBrowserSession;
  }, [refresh, refreshBrowserSession]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped) return;
      await Promise.all([refreshRef.current(), refreshBrowserRef.current()]);
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  const clearHistory = useCallback(async () => {
    if (!confirm('Clear all captured history? This only wipes the capture log — your saved browser cookie session is untouched.')) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch('/api/tf/session', { method: 'DELETE' });
      const j = (await res.json()) as TfSession;
      if (j.success) {
        setData(j);
        setNotice({ text: 'capture history cleared', tone: 'ok' });
      } else {
        setNotice({ text: (j as unknown as { error?: string }).error ?? 'clear failed', tone: 'bad' });
      }
    } catch (e) {
      setNotice({ text: (e as Error).message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }, []);

  const saveBrowserCurl = useCallback(async () => {
    if (!pastedCurl.trim()) {
      setBrowserNotice({ text: 'paste a curl command first', tone: 'bad' });
      return;
    }
    setBrowserBusy(true);
    setBrowserNotice(null);
    try {
      const res = await fetch('/api/tf/browser-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ curl: pastedCurl }),
      });
      const j = (await res.json()) as { success: boolean; error?: string; running?: boolean };
      setBrowserNotice(
        j.success
          ? { text: `saved — browser ${j.running ? 'is starting up now' : 'will start at the next check'}`, tone: 'ok' }
          : { text: j.error ?? 'save failed', tone: 'bad' }
      );
      if (j.success) setPastedCurl('');
      await refreshBrowserSession();
    } catch (e) {
      setBrowserNotice({ text: (e as Error).message, tone: 'bad' });
    } finally {
      setBrowserBusy(false);
    }
  }, [pastedCurl, refreshBrowserSession]);

  const browserAction = useCallback(
    async (action: 'start' | 'stop') => {
      setBrowserBusy(true);
      setBrowserNotice(null);
      try {
        const res = await fetch('/api/tf/browser-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        const j = (await res.json()) as { success: boolean; error?: string; running?: boolean };
        setBrowserNotice(
          j.success
            ? { text: action === 'start' ? (j.running ? 'browser is running' : 'starting…') : 'browser stopped', tone: 'ok' }
            : { text: j.error ?? `${action} failed`, tone: 'bad' }
        );
        await refreshBrowserSession();
      } catch (e) {
        setBrowserNotice({ text: (e as Error).message, tone: 'bad' });
      } finally {
        setBrowserBusy(false);
      }
    },
    [refreshBrowserSession]
  );

  const historyByDate = useMemo(() => {
    const grouped = new Map<string, { total: number; success: number; error: number; lastCapturedAt: string }>();
    for (const row of data?.history ?? []) {
      const existing = grouped.get(row.captureDate) ?? { total: 0, success: 0, error: 0, lastCapturedAt: row.lastCapturedAt };
      existing.total += row.total;
      existing.success += row.success;
      existing.error += row.error;
      if (row.lastCapturedAt > existing.lastCapturedAt) existing.lastCapturedAt = row.lastCapturedAt;
      grouped.set(row.captureDate, existing);
    }
    return [...grouped.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [data]);

  return (
    <div className="mx-auto max-w-5xl space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="h-4 w-4 text-primary" />
        <h1 className="text-base font-bold">TradeFinder Session</h1>
        <a href="/tf/history" className="text-[11px] text-muted-foreground underline hover:text-foreground">
          EOD history →
        </a>
        {browserSession && (
          <>
            <Badge tone={browserSession.session.configured ? 'ok' : 'neutral'}>
              {browserSession.session.configured ? 'cookies stored' : 'not configured'}
            </Badge>
            <Badge tone={browserSession.running ? 'ok' : 'neutral'}>{browserSession.running ? 'browser running' : 'browser stopped'}</Badge>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            title="Refresh status"
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* A missing/broken cookie session is the ONE state that needs action —
          everything else (a failed tick, the browser being off outside market
          hours) heals itself, so it isn't raised as a banner here. */}
      {browserSession && !browserSession.session.configured && (
        <div className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> No browser session configured — paste a &quot;Copy as cURL&quot; below to start capturing.
        </div>
      )}
      {browserSession?.session.lastError && (
        <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {browserSession.session.lastError}
        </div>
      )}
      {notice && (
        <div
          className={`rounded-md border p-2 text-xs ${
            notice.tone === 'ok'
              ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400'
              : 'border-red-300 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400'
          }`}
        >
          {notice.text}
        </div>
      )}

      {!readOnly && (
        <section className="space-y-2 rounded-lg border border-emerald-300/60 bg-card p-3 dark:border-emerald-500/30">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Browser session (recommended)
            </h2>
            {browserSession?.session.lastError && (
              <Badge tone="warn">{browserSession.session.lastError.slice(0, 70)}</Badge>
            )}
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            TradeFinder&apos;s access token is minted fresh by their own page for every single request and cannot be
            copied and reused (confirmed 2026-08-08) — so a real headless browser runs on the server instead, logged
            in with cookies from your own session. On a signed-in tab, open DevTools Network tab, right-click any
            request to <span className="font-mono">tradefinder.in</span>, choose <strong>Copy → Copy as cURL</strong>,
            and paste the whole thing below. This keeps working for as long as your TradeFinder login stays signed
            in — if your account logs you out daily (confirmed for at least one account, 2026-08-08), plan on
            re-pasting once a day too. Still far better than the old method, which died within seconds.
          </p>
          <textarea
            value={pastedCurl}
            onChange={(e) => setPastedCurl(e.target.value)}
            placeholder="curl --url &quot;https://tradefinder.in/...&quot; -H ... -b &quot;...&quot; ..."
            rows={4}
            className="w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-[11px]"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={browserBusy}
              onClick={() => void saveBrowserCurl()}
              className="rounded-md bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {browserBusy ? 'Saving…' : 'Save & start browser'}
            </button>
            <button
              type="button"
              disabled={browserBusy || !browserSession?.session.configured}
              onClick={() => void browserAction(browserSession?.running ? 'stop' : 'start')}
              title={browserSession?.running ? 'Stop the headless browser' : 'Start the headless browser now (bypasses the 09:22–15:30 window, for testing)'}
              className="rounded-md border border-border px-3 py-1.5 text-[11px] hover:bg-muted disabled:opacity-50"
            >
              {browserSession?.running ? 'Stop browser' : 'Start now'}
            </button>
            {browserSession?.session.verifiedAt && (
              <span className="text-[11px] text-muted-foreground">last confirmed working: {fmtDateTime(browserSession.session.verifiedAt)}</span>
            )}
          </div>
          {browserNotice && (
            <div
              className={`rounded-md border p-2 text-xs ${
                browserNotice.tone === 'ok'
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400'
                  : 'border-red-300 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400'
              }`}
            >
              {browserNotice.text}
            </div>
          )}
        </section>
      )}

      {data && (
        <section className="space-y-2 rounded-lg border border-border bg-card p-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Last capture per endpoint
            </h2>
            {!readOnly && (data.captures.length > 0 || historyByDate.length > 0) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void clearHistory()}
                title="Wipe the capture log below — does not touch your saved browser cookie session"
                className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                Clear history
              </button>
            )}
          </div>
          {data.captures.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No captures yet.</p>
          ) : (
            <table className="w-full text-[11px]">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-1 pr-3 text-left font-medium">Endpoint</th>
                  <th className="py-1 pr-3 text-left font-medium">When (IST)</th>
                  <th className="py-1 pr-3 text-left font-medium">Status</th>
                  <th className="py-1 text-left font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {data.captures.map((c) => (
                  <tr key={c.endpoint} className="border-b border-border/60">
                    <td className="py-1 pr-3 font-medium">{c.endpoint}</td>
                    <td className="py-1 pr-3 tabular-nums">{fmtDateTime(c.capturedAt)}</td>
                    <td className={`py-1 pr-3 ${c.status === 'success' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                      {c.status}
                    </td>
                    <td className="py-1 text-muted-foreground">{c.error ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {data && (
        <section className="space-y-2 rounded-lg border border-border bg-card p-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Capture history by date
          </h2>
          {historyByDate.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No captures recorded yet — history fills in as the collector runs.</p>
          ) : (
            <table className="w-full text-[11px]">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-1 pr-3 text-left font-medium">Date (IST)</th>
                  <th className="py-1 pr-3 text-right font-medium">Attempts</th>
                  <th className="py-1 pr-3 text-right font-medium">Success</th>
                  <th className="py-1 pr-3 text-right font-medium">Failed</th>
                  <th className="py-1 text-left font-medium">Last capture</th>
                </tr>
              </thead>
              <tbody>
                {historyByDate.map(([date, stats]) => (
                  <tr key={date} className="border-b border-border/60">
                    <td className="py-1 pr-3 font-medium">{fmtDate(date)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{stats.total}</td>
                    <td className="py-1 pr-3 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{stats.success}</td>
                    <td className={`py-1 pr-3 text-right tabular-nums ${stats.error > 0 ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}>
                      {stats.error}
                    </td>
                    <td className="py-1 tabular-nums text-muted-foreground">{fmtDateTime(stats.lastCapturedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {!data && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" /> Loading TradeFinder session status…
        </div>
      )}
    </div>
  );
}
