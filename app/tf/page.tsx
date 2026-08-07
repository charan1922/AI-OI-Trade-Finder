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
 * `lt` is itself a JWT with its own `exp` claim — decoded server-side at
 * paste time so this page can show a real countdown, not a guess. Confirmed
 * live: this token's lifetime is ~8 HOURS, not the ~30-day NextAuth login
 * session it's easy to mistake it for. `at` appears to rotate independently
 * and can go stale even faster — paste failures should be expected and easy
 * to recover from, not treated as exceptional.
 */

import { AlertTriangle, Check, Copy, KeyRound, Loader2, RefreshCw, Zap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRole } from '@/lib/auth/use-role';
import { summarizeTfHealth } from '@/lib/tf-live/status';

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

function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'expired';
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

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

/** One line the operator pastes into DevTools console on a signed-in
 *  tradefinder.in tab — copies both values to the clipboard as JSON so
 *  there's nothing to misread or mistype. */
const CONSOLE_SNIPPET =
  "copy(JSON.stringify({lt: localStorage.getItem('lt'), at: sessionStorage.getItem('at')}))";

/** Accepts the JSON the snippet copies, but also tolerates a few things a
 *  human might paste by hand: raw `lt=...&at=...`, or two lines. Never
 *  silently invents a value — anything it can't parse is a clear error. */
function parsePastedTokens(raw: string): { lt: string; at: string } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: 'nothing pasted' };
  try {
    const parsed = JSON.parse(trimmed) as { lt?: unknown; at?: unknown };
    if (typeof parsed.lt === 'string' && typeof parsed.at === 'string' && parsed.lt && parsed.at) {
      return { lt: parsed.lt, at: parsed.at };
    }
    return { error: 'JSON parsed but is missing a non-empty "lt" or "at" field' };
  } catch {
    /* fall through to the tolerant formats below */
  }
  const kv: Record<string, string> = {};
  for (const part of trimmed.split(/[&\n]/)) {
    const eq = part.indexOf('=');
    if (eq > 0) kv[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  if (kv.lt && kv.at) return { lt: kv.lt, at: kv.at };
  return { error: 'could not find both lt and at — paste the exact output of the console snippet' };
}

export default function TfPage() {
  const { readOnly } = useRole();
  const [data, setData] = useState<TfSession | null>(null);
  const [nowMs, setNowMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'bad' } | null>(null);
  const [pasted, setPasted] = useState('');
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [browserSession, setBrowserSession] = useState<TfBrowserSession | null>(null);
  const [pastedCurl, setPastedCurl] = useState('');
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserNotice, setBrowserNotice] = useState<{ text: string; tone: 'ok' | 'bad' } | null>(null);

  const copySnippet = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(CONSOLE_SNIPPET);
      setSnippetCopied(true);
      setTimeout(() => setSnippetCopied(false), 2000);
    } catch {
      /* clipboard permission denied — the code block is still selectable by hand */
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/tf/session', { cache: 'no-store' });
      const j = (await res.json()) as TfSession;
      if (j.success) {
        setData(j);
        setNowMs(Date.now());
      }
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

  const save = useCallback(async () => {
    const parsed = parsePastedTokens(pasted);
    if ('error' in parsed) {
      setNotice({ text: parsed.error, tone: 'bad' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch('/api/tf/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const j = (await res.json()) as { success: boolean; error?: string };
      setNotice(
        j.success
          ? { text: 'saved — verified against a real TradeFinder call', tone: 'ok' }
          : { text: j.error ?? 'save failed', tone: 'bad' }
      );
      if (j.success) setPasted('');
      await refresh();
    } catch (e) {
      setNotice({ text: (e as Error).message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }, [pasted, refresh]);

  const captureNow = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch('/api/tf/capture', { method: 'POST' });
      const j = (await res.json()) as TfSession;
      if (j.success) {
        setData(j);
        setNowMs(Date.now());
        const failed = j.captures.filter((c) => c.status === 'error');
        setNotice(
          failed.length === 0
            ? { text: 'captured — all endpoints OK', tone: 'ok' }
            : { text: `${failed.length}/${j.captures.length} endpoint(s) failed: ${failed.map((f) => `${f.endpoint} (${f.error})`).join('; ')}`, tone: 'bad' }
        );
      } else {
        setNotice({ text: (j as unknown as { error?: string }).error ?? 'capture failed', tone: 'bad' });
      }
    } catch (e) {
      setNotice({ text: (e as Error).message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }, []);

  const clearHistory = useCallback(async () => {
    if (!confirm('Clear all captured history? This only wipes the capture log — your saved lt/at and browser cookie session are untouched.')) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch('/api/tf/session', { method: 'DELETE' });
      const j = (await res.json()) as TfSession;
      if (j.success) {
        setData(j);
        setNowMs(Date.now());
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

  const s = data?.session;
  const jwtExpiresMs = s?.jwtExpiresAt ? new Date(s.jwtExpiresAt).getTime() : null;
  const jwtRemainingMs = jwtExpiresMs != null && nowMs ? jwtExpiresMs - nowMs : null;
  const jwtTone: 'ok' | 'warn' | 'bad' | 'neutral' =
    jwtRemainingMs == null ? 'neutral' : jwtRemainingMs <= 0 ? 'bad' : jwtRemainingMs <= 30 * 60_000 ? 'warn' : 'ok';

  /** Today's tally + the newest capture that actually LANDED, across all feeds
   *  — the two facts that decide whether a failure is worth worrying about. */
  //  `nowMs` is the component's ticking clock state — deliberately used instead
  //  of Date.now(), which is impure during render. Before the first tick it is
  //  0, so the memo falls back to the newest capture date in the payload rather
  //  than computing an IST date from the epoch.
  const health = useMemo(() => {
    const rows = data?.history ?? [];
    const todayIST = nowMs
      ? new Date(nowMs + 5.5 * 3600_000).toISOString().slice(0, 10)
      : (rows[0]?.captureDate ?? '');
    const today = rows.filter((row) => row.captureDate === todayIST);
    const lastSuccessAt = today.reduce<string | null>(
      (newest, row) => (row.lastSuccessAt && (!newest || row.lastSuccessAt > newest) ? row.lastSuccessAt : newest),
      null
    );
    return summarizeTfHealth({
      configured: s?.configured ?? false,
      jwtExpiresAt: s?.jwtExpiresAt ?? null,
      lastError: s?.lastError ?? null,
      lastSuccessAt,
      successesToday: today.reduce((sum, row) => sum + row.success, 0),
      attemptsToday: today.reduce((sum, row) => sum + row.total, 0),
      nowMs: nowMs || Date.parse(rows[0]?.lastCapturedAt ?? '') || 0,
    });
  }, [data, s, nowMs]);

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
        {s && (
          <>
            <Badge tone={s.configured ? 'ok' : 'neutral'}>{s.configured ? 'lt/at stored' : 'not configured'}</Badge>
            {jwtRemainingMs != null && (
              <Badge tone={jwtTone}>
                {jwtRemainingMs > 0 ? `token expires in ${fmtCountdown(jwtRemainingMs)}` : `token expired ${fmtDateTime(s.jwtExpiresAt)}`}
              </Badge>
            )}
            {/* ONE health verdict, not the raw lastError string. The raw
                string read "TradeFinder rejected it (AT_ERROR: INVALID TOKEN)"
                seconds after a capture had stored 210 stocks — it looked like
                total failure when nothing needed doing. summarizeTfHealth
                separates "you must act" from "it heals itself". */}
            <Badge tone={health.level === 'ok' ? 'ok' : health.level === 'error' ? 'bad' : 'warn'}>
              {health.headline}
            </Badge>
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

      {/* The health explanation. Amber states say plainly that nothing needs
          doing, because the previous raw-error banner made a self-healing
          throttle look identical to a dead token. Only `error` shows an action. */}
      {s && health.level !== 'ok' && (
        <div
          className={`flex items-start gap-2 rounded-md border p-2 text-xs ${
            health.level === 'error'
              ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400'
              : 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400'
          }`}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <strong>{health.headline}.</strong> {health.detail}
            {health.action ? (
              <>
                {' '}
                <strong>{health.action}</strong>
              </>
            ) : (
              ' No action needed.'
            )}
          </span>
        </div>
      )}
      {jwtTone === 'warn' && (
        <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Token expires soon — re-paste from a signed-in tab before it lapses.
        </div>
      )}
      {jwtTone === 'bad' && jwtRemainingMs != null && jwtRemainingMs <= 0 && (
        <div className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Token has expired — captures will fail until you paste a fresh pair.
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
            {browserSession?.session && (
              <Badge tone={browserSession.session.configured ? 'ok' : 'neutral'}>
                {browserSession.session.configured ? 'cookies stored' : 'not configured'}
              </Badge>
            )}
            {browserSession && (
              <Badge tone={browserSession.running ? 'ok' : 'neutral'}>{browserSession.running ? 'browser running' : 'browser stopped'}</Badge>
            )}
            {browserSession?.session.lastError && (
              <Badge tone="warn">{browserSession.session.lastError.slice(0, 70)}</Badge>
            )}
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            TradeFinder&apos;s access token is minted fresh by their own page for every single request and cannot be
            copied and reused (confirmed 2026-08-08) — so a real headless browser runs on the server instead, logged
            in with cookies from your own session. On a signed-in tab, open DevTools Network tab, right-click any
            request to <span className="font-mono">tradefinder.in</span>, choose <strong>Copy → Copy as cURL</strong>,
            and paste the whole thing below. This should keep working for as long as your TradeFinder login session
            lasts (their own <span className="font-mono">/api/auth/session</span> reports ~30 days) — not the few
            seconds a copied access token survives.
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

      {!readOnly && (
        <section className="space-y-2 rounded-lg border border-border bg-card p-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Update lt / at <span className="font-normal normal-case text-muted-foreground/70">(legacy — dies within seconds, not recommended)</span>
          </h2>
          <p className="text-[11px] leading-snug text-muted-foreground">
            On a signed-in tab at{' '}
            <a href="https://tradefinder.in" target="_blank" rel="noreferrer" className="underline">
              tradefinder.in
            </a>
            , open DevTools console and run:
          </p>
          <div className="flex items-center gap-1.5">
            <code className="block flex-1 overflow-x-auto rounded bg-muted px-2 py-1.5 text-[11px]">{CONSOLE_SNIPPET}</code>
            <button
              type="button"
              onClick={() => void copySnippet()}
              title="Copy this line to your clipboard"
              className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1.5 text-[11px] hover:bg-muted"
            >
              {snippetCopied ? <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            That copies both values as one JSON blob to your clipboard. Paste the whole thing into the box below —
            do not split it into two fields, this one box parses it for you.
          </p>
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder='{"lt":"...","at":"..."}'
            rows={3}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px]"
          />
          <button
            type="button"
            disabled={busy || !pasted.trim()}
            onClick={() => void save()}
            className="rounded-md bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            Save &amp; verify
          </button>
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
                title="Wipe the capture log below — does not touch your saved lt/at or browser cookie session"
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
                    <td className="py-1 tabular-nums">{fmtDateTime(c.capturedAt)}</td>
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
                  <th className="py-1 text-left font-medium">Date (IST)</th>
                  <th className="py-1 text-right font-medium">Attempts</th>
                  <th className="py-1 text-right font-medium">Success</th>
                  <th className="py-1 text-right font-medium">Failed</th>
                  <th className="py-1 text-left font-medium">Last capture</th>
                </tr>
              </thead>
              <tbody>
                {historyByDate.map(([date, stats]) => (
                  <tr key={date} className="border-b border-border/60">
                    <td className="py-1 font-medium">{fmtDate(date)}</td>
                    <td className="py-1 text-right tabular-nums">{stats.total}</td>
                    <td className="py-1 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{stats.success}</td>
                    <td className={`py-1 text-right tabular-nums ${stats.error > 0 ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}>
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
