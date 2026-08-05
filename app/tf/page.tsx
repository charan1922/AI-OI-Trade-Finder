'use client';

/**
 * /tf — TradeFinder auth panel, sibling of /dhan and /fyers.
 *
 * TradeFinder's own frontend authenticates its /api_be/* calls with two small
 * values pulled from browser storage — `localStorage.lt` and
 * `sessionStorage.at` — sent as the `jwtToken` / `accessToken` headers. No
 * cookie, no browser session needed server-side: confirmed live 2026-08-05
 * that a plain fetch with just these two headers (zero cookies) returns real
 * data from both `all_sector` and `daily-index`.
 *
 * So this page is a plain paste-and-store panel, same shape as /dhan's token
 * card: two fields, a save button, a manual "Capture now" test, and a small
 * table of the last capture per endpoint.
 */

import { KeyRound, Loader2, RefreshCw, Zap } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRole } from '@/lib/auth/use-role';

const POLL_MS = 15_000;

const fmtTime = (iso: string | null | undefined) =>
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

function Badge({ ok, okLabel, badLabel }: { ok: boolean; okLabel: string; badLabel: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
        ok
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
          : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-500/10 dark:text-zinc-400'
      }`}
    >
      {ok ? okLabel : badLabel}
    </span>
  );
}

/** Mirror of GET /api/tf/session. */
interface TfSession {
  success: boolean;
  session: { configured: boolean; updatedAt: string | null; verifiedAt: string | null; lastError: string | null };
  captures: { endpoint: string; capturedAt: string; status: string; error: string | null }[];
}

/** One line the operator pastes into DevTools console on a signed-in
 *  tradefinder.in tab — copies both values to the clipboard as JSON so
 *  there's nothing to misread or mistype. */
const CONSOLE_SNIPPET =
  "copy(JSON.stringify({lt: localStorage.getItem('lt'), at: sessionStorage.getItem('at')}))";

export default function TfPage() {
  const { readOnly } = useRole();
  const [data, setData] = useState<TfSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [lt, setLt] = useState('');
  const [at, setAt] = useState('');

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/tf/session', { cache: 'no-store' });
      const j = (await res.json()) as TfSession;
      if (j.success) setData(j);
    } catch {
      /* transient — next poll retries */
    }
  }, []);

  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped) return;
      await refreshRef.current();
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  const save = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch('/api/tf/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lt, at }),
      });
      const j = (await res.json()) as { success: boolean; error?: string };
      setNotice(j.success ? 'saved — verified against a real TradeFinder call' : (j.error ?? 'save failed'));
      if (j.success) {
        setLt('');
        setAt('');
      }
      await refresh();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [lt, at, refresh]);

  const captureNow = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch('/api/tf/capture', { method: 'POST' });
      const j = (await res.json()) as TfSession;
      if (j.success) setData(j);
      else setNotice((j as unknown as { error?: string }).error ?? 'capture failed');
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const s = data?.session;

  return (
    <div className="mx-auto max-w-5xl space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="h-4 w-4 text-primary" />
        <h1 className="text-base font-bold">TradeFinder Session</h1>
        {s && (
          <>
            <Badge ok={s.configured} okLabel="lt/at stored" badLabel="not configured" />
            <Badge
              ok={!!s.verifiedAt && !s.lastError}
              okLabel={`verified ${fmtTime(s.verifiedAt)}`}
              badLabel={s.lastError ? s.lastError.slice(0, 50) : 'never verified'}
            />
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {!readOnly && (
            <button
              type="button"
              disabled={busy || !s?.configured}
              onClick={() => void captureNow()}
              title="Fetch all_sector + daily-index right now with the stored lt/at — proves they still work, off-hours too"
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-[11px] hover:bg-muted disabled:opacity-50"
            >
              <Zap className="h-3.5 w-3.5" /> Capture now
            </button>
          )}
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

      {notice && <div className="rounded-md border border-border bg-muted/50 p-2 text-xs">{notice}</div>}

      {!readOnly && (
        <section className="space-y-2 rounded-lg border border-border bg-card p-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Update lt / at
          </h2>
          <p className="text-[11px] leading-snug text-muted-foreground">
            On a signed-in tab at{' '}
            <a href="https://tradefinder.in" target="_blank" rel="noreferrer" className="underline">
              tradefinder.in
            </a>
            , open DevTools console and run:
          </p>
          <code className="block overflow-x-auto rounded bg-muted px-2 py-1.5 text-[11px]">{CONSOLE_SNIPPET}</code>
          <p className="text-[11px] text-muted-foreground">
            That copies both values as JSON to your clipboard — paste the whole thing below, or split it into the
            two fields.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              value={lt}
              onChange={(e) => setLt(e.target.value)}
              placeholder="lt (localStorage)"
              className="rounded-md border border-border bg-background px-2 py-1.5 text-[11px] font-mono"
            />
            <input
              value={at}
              onChange={(e) => setAt(e.target.value)}
              placeholder="at (sessionStorage)"
              className="rounded-md border border-border bg-background px-2 py-1.5 text-[11px] font-mono"
            />
          </div>
          <button
            type="button"
            disabled={busy || !lt || !at}
            onClick={() => void save()}
            className="rounded-md bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            Save &amp; verify
          </button>
        </section>
      )}

      {data && (
        <section className="space-y-2 rounded-lg border border-border bg-card p-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Last capture per endpoint
          </h2>
          {data.captures.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No captures yet.</p>
          ) : (
            <table className="w-full text-[11px]">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-1 text-left font-medium">Endpoint</th>
                  <th className="py-1 text-left font-medium">When (IST)</th>
                  <th className="py-1 text-left font-medium">Status</th>
                  <th className="py-1 text-left font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {data.captures.map((c) => (
                  <tr key={c.endpoint} className="border-b border-border/60">
                    <td className="py-1 font-medium">{c.endpoint}</td>
                    <td className="py-1 tabular-nums">{fmtTime(c.capturedAt)}</td>
                    <td className={`py-1 ${c.status === 'success' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
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

      {!data && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" /> Loading TradeFinder session status…
        </div>
      )}
    </div>
  );
}
