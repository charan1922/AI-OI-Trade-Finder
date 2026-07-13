'use client';

/**
 * /dhan — Dhan token & feed panel, the /fyers page's sibling. Dhan has no
 * dedicated download loop (the pre-open token warm-up rides the Fyers poller;
 * quotes are fetched on demand by /live, the scanner, and the auto-trader), so
 * this panel is about the TOKEN: status chips, manual regenerate, and a
 * one-quote "Test call" that proves the token works end-to-end.
 *
 * Polls GET /api/dhan/status (strictly passive — never call GET /api/dhan/token
 * from a poll: that route GENERATES a token as a side effect).
 */

import { Banknote, KeyRound, Loader2, RefreshCw, Zap } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRole } from '@/lib/auth/use-role';

const POLL_MS = 10_000;

const fmtTime = (ts: number | null | undefined) =>
  ts
    ? new Date(ts).toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata',
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border/50 px-2 py-1">
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-[12px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/** Mirror of GET /api/dhan/status. */
interface DhanStatus {
  success: boolean;
  marketOpen: boolean;
  configured: boolean;
  token: { cached: boolean; expiresAt: number | null };
  lastWarmup: { date: string; at: number; fyers: string; dhan: string } | null;
}

/** Mirror of POST /api/dhan/status {action:'test-call'}. */
interface TestCallResult {
  success: boolean;
  symbol?: string;
  ltp?: number | null;
  tookMs?: number;
  at?: string;
  error?: string;
}

export default function DhanPage() {
  const { readOnly } = useRole();
  const [status, setStatus] = useState<DhanStatus | null>(null);
  const [nowMs, setNowMs] = useState(0); // captured per poll — avoids Date.now() in render
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [test, setTest] = useState<TestCallResult | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/dhan/status', { cache: 'no-store' });
      const j = (await res.json()) as DhanStatus;
      if (j.success) {
        setStatus(j);
        setNowMs(Date.now());
      }
    } catch {
      /* transient — next poll retries */
    }
  }, []);

  // Self-scheduling poll chain (same idiom as /fyers).
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

  const regenToken = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch('/api/dhan/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j = (await res.json()) as { success: boolean; expiresAt?: string | null; error?: string };
      setNotice(j.success ? `token regenerated — expires ${j.expiresAt ? fmtTime(Date.parse(j.expiresAt)) : '?'}` : (j.error ?? 'regeneration failed'));
      await refresh();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const testCall = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch('/api/dhan/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test-call' }),
      });
      setTest((await res.json()) as TestCallResult);
      await refresh();
    } catch (e) {
      setTest({ success: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const s = status;
  const warm = s?.lastWarmup;
  const expiresInMin =
    s?.token.expiresAt && nowMs ? Math.max(0, Math.round((s.token.expiresAt - nowMs) / 60_000)) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-3 p-3">
      {/* Header: title + status chips + actions (mirrors /fyers) */}
      <div className="flex flex-wrap items-center gap-2">
        <Banknote className="h-4 w-4 text-primary" />
        <h1 className="text-base font-bold">Dhan Feed &amp; Token</h1>
        {s && (
          <>
            <Badge ok={s.marketOpen} okLabel="market open" badLabel="market closed" />
            <Badge ok={s.configured} okLabel="creds ok" badLabel="no credentials" />
            <Badge ok={s.token.cached} okLabel={`token · exp ${fmtTime(s.token.expiresAt)}`} badLabel="no token" />
            <Badge
              ok={warm?.dhan === 'ok'}
              okLabel={`warmed ${fmtTime(warm?.at)}`}
              badLabel={warm ? `warm-up: ${warm.dhan.slice(0, 40)}` : 'no warm-up yet'}
            />
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {!readOnly && (
            <>
              <button
                type="button"
                disabled={busy || !s?.configured}
                onClick={() => void testCall()}
                title="Fetch one RELIANCE quote through the normal rate-gated Dhan path — proves the token works end-to-end (works off-hours too: returns the last close)"
                className="flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-[11px] hover:bg-muted disabled:opacity-50"
              >
                <Zap className="h-3.5 w-3.5" /> Test call
              </button>
              <button
                type="button"
                disabled={busy || !s?.configured}
                onClick={() => void regenToken()}
                title="Clear the cached token and run the TOTP chain now. Dhan rate-limits generation to ~1 per 2 minutes."
                className="flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-[11px] hover:bg-muted disabled:opacity-50"
              >
                <KeyRound className="h-3.5 w-3.5" /> New token
              </button>
            </>
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

      {s && (
        <div className="grid gap-3 sm:grid-cols-2">
          {/* Token card */}
          <section className="space-y-2 rounded-lg border border-border bg-card p-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Token</h2>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Cached" value={s.token.cached ? 'yes' : 'no'} />
              <Stat label="Expires (IST)" value={fmtTime(s.token.expiresAt)} />
              <Stat label="Expires in" value={expiresInMin != null ? `${expiresInMin} min` : '—'} />
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Auto-created before the open: the Fyers 5-min poller&apos;s <b>08:40–09:15 IST</b> ticks warm BOTH broker
              tokens on trading days — no page needs to be open. Last warm-up:{' '}
              {warm ? (
                <>
                  {warm.date} {fmtTime(warm.at)} · fyers <b>{warm.fyers}</b> · dhan <b>{warm.dhan}</b>
                </>
              ) : (
                'none this server session yet'
              )}
              . Loop controls live on <a href="/fyers" className="underline">/fyers</a>.
            </p>
          </section>

          {/* Test-call card */}
          <section className="space-y-2 rounded-lg border border-border bg-card p-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Last test call</h2>
            {test ? (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <Stat label="Symbol" value={test.symbol ?? '—'} />
                  <Stat label="LTP" value={test.ltp != null ? `₹${test.ltp}` : '—'} />
                  <Stat label="Took" value={test.tookMs != null ? `${test.tookMs} ms` : '—'} />
                </div>
                {test.success ? (
                  <p className="text-[11px] text-emerald-600 dark:text-emerald-400">Token verified — real quote returned.</p>
                ) : (
                  <p className="text-[11px] text-red-600 dark:text-red-400">{test.error ?? 'test failed'}</p>
                )}
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                No test call yet this session{readOnly ? ' (operator action)' : ' — click Test call to verify the token with one real quote'}.
              </p>
            )}
          </section>
        </div>
      )}

      {!s && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" /> Loading Dhan status…
        </div>
      )}
    </div>
  );
}
