'use client';

/**
 * /tf — TradeFinder capture panel, sibling of /dhan and /fyers.
 *
 * A headless browser on the worker host (deploy/tf-worker) opens TradeFinder
 * logged in with the cookies pasted here and stores what TradeFinder's own page
 * fetches: `market_pulse` and `sector_scope` (lib/tf-live/endpoints.ts). This
 * page shows the session, the last capture per feed and TODAY's data; earlier
 * days are on /tf/history.
 *
 * ONE endpoint (/api/tf/browser-session?data=1) backs the whole page.
 */

import { AlertTriangle, KeyRound, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRole } from '@/lib/auth/use-role';
import { TF_ENDPOINTS } from '@/lib/tf-live/endpoints';
import { isPriceList, type TfPulseList as PulseList, type TfStockRow as StockRow } from '@/lib/tf-live/parse';

const POLL_MS = 15_000;
/** A board older than this is shown amber — it is not live any more. */
const STALE_MIN = 10;

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

const fmtNum = (v: number | string | null | undefined) =>
  v == null ? '—' : typeof v === 'number' ? v.toLocaleString('en-IN') : v;

const fmtPct = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

const pctTone = (v: number | null) =>
  v == null ? '' : v >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';

const listTitle = (name: string) => name.replace(/_/g, ' ');

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

interface TfStatus {
  success: boolean;
  session: { configured: boolean; updatedAt: string | null; verifiedAt: string | null; lastError: string | null };
  running: boolean;
  captures: { endpoint: string; capturedAt: string; status: string; error: string | null }[];
  /** Today's (IST) successes and errors per feed. */
  counts: { endpoint: string; success: number; error: number }[];
  today?: {
    date: string;
    sectorScope: { capturedAt: string; rows: StockRow[] } | null;
    marketPulse: { capturedAt: string; lists: PulseList[] } | null;
  };
  error?: string;
}

export default function TfPage() {
  const { readOnly } = useRole();
  const [data, setData] = useState<TfStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'bad' } | null>(null);
  const [pastedCurl, setPastedCurl] = useState('');
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserNotice, setBrowserNotice] = useState<{ text: string; tone: 'ok' | 'bad' } | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [tab, setTab] = useState('sector_scope');

  /**
   * Never fail silently. This used to be `if (j.success) setData(j)` wrapped in
   * an empty catch, so THREE different failures all rendered as an unexplained
   * blank page: an expired browser login (the API answers 401
   * `{success:false,error:'Authentication required.'}`), a 500 from the API, and
   * a dropped network request. The operator's report was exactly that — "it
   * failed, I could not know the reason" (2026-08-10). Whatever went wrong now
   * says so on screen, and the last good data stays visible underneath instead
   * of vanishing.
   */
  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/tf/browser-session?data=1', { cache: 'no-store' });
      if (res.status === 401 || res.status === 403) {
        setStatusError('Your app login expired — reload the page and sign in again to see the TradeFinder status.');
        return;
      }
      const j = (await res.json().catch(() => null)) as TfStatus | null;
      if (!res.ok || !j?.success) {
        setStatusError(j?.error ?? `Status check failed (HTTP ${res.status}).`);
        return;
      }
      setData(j);
      setStatusError(null);
    } catch (e) {
      setStatusError(`Could not reach the server: ${(e as Error).message}`);
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

  const clearHistory = useCallback(async () => {
    if (!confirm('Clear all captured history? This only wipes the capture log — your saved browser cookie session is untouched.')) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch('/api/tf/browser-session', { method: 'DELETE' });
      const j = (await res.json()) as TfStatus;
      if (j.success) {
        setData(j);
        setNotice({ text: 'capture history cleared', tone: 'ok' });
      } else {
        setNotice({ text: j.error ?? 'clear failed', tone: 'bad' });
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
      await refresh();
    } catch (e) {
      setBrowserNotice({ text: (e as Error).message, tone: 'bad' });
    } finally {
      setBrowserBusy(false);
    }
  }, [pastedCurl, refresh]);

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
        await refresh();
      } catch (e) {
        setBrowserNotice({ text: (e as Error).message, tone: 'bad' });
      } finally {
        setBrowserBusy(false);
      }
    },
    [refresh]
  );

  // One row per captured feed, ALWAYS — a feed that has never landed shows as
  // such instead of vanishing. The log still holds rows for retired feeds.
  const feeds = useMemo(
    () =>
      TF_ENDPOINTS.map((endpoint) => ({
        endpoint,
        last: data?.captures.find((c) => c.endpoint === endpoint) ?? null,
        today: data?.counts?.find((c) => c.endpoint === endpoint) ?? { success: 0, error: 0 },
      })),
    [data]
  );
  const hasLog = feeds.some((f) => f.last != null);
  const sectorRows = useMemo(
    () => [...(data?.today?.sectorScope?.rows ?? [])].sort((x, y) => (y.rFactor ?? -1) - (x.rFactor ?? -1)),
    [data]
  );
  const pulseLists = data?.today?.marketPulse?.lists ?? [];
  const activePulse = pulseLists.find((l) => l.name === tab) ?? null;
  const activeAt = tab === 'sector_scope' ? data?.today?.sectorScope?.capturedAt : data?.today?.marketPulse?.capturedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), POLL_MS);
    return () => clearInterval(t);
  }, []);
  const ageMin = activeAt ? (now - Date.parse(activeAt)) / 60_000 : null;

  return (
    <div className="mx-auto max-w-5xl space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="h-4 w-4 text-primary" />
        <h1 className="text-base font-bold">TradeFinder Session</h1>
        <a href="/tf/history" className="text-[11px] text-muted-foreground underline hover:text-foreground">
          EOD history →
        </a>
        {data && (
          <>
            <Badge tone={data.session.configured ? 'ok' : 'neutral'}>
              {data.session.configured ? 'cookies stored' : 'not configured'}
            </Badge>
            {/* "running" alone is not "working" — on 2026-08-10 the browser
                stayed up for 3h20m after TradeFinder signed the session out,
                rejecting every request while this badge sat green. When
                there's a live error, say so here rather than imply health. */}
            <Badge tone={data.running ? (data.session.lastError ? 'warn' : 'ok') : 'neutral'}>
              {data.running ? (data.session.lastError ? 'running, not capturing' : 'browser running') : 'browser stopped'}
            </Badge>
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

      {/* Why the page couldn't load its own status — shown ABOVE everything
          else, because when this is set the rest of the screen may be stale or
          empty and the operator needs to know that's the reason. */}
      {statusError && (
        <div className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>
            {statusError}
            {data && ' Showing the last status that loaded successfully.'}
          </span>
        </div>
      )}

      {/* A missing/broken cookie session is the ONE state that needs action —
          everything else (a failed tick, the browser being off outside market
          hours) heals itself, so it isn't raised as a banner here. */}
      {data && !data.session.configured && (
        <div className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> No browser session configured — paste a &quot;Copy as cURL&quot; below to start capturing.
        </div>
      )}
      {data?.session.lastError && (
        <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {data.session.lastError}
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
              Browser session
            </h2>
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">
            On a signed-in <span className="font-mono">tradefinder.in</span> tab: DevTools → Network → right-click any
            request → <strong>Copy → Copy as cURL</strong>, then paste it below.
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
              disabled={browserBusy || !data?.session.configured}
              onClick={() => void browserAction(data?.running ? 'stop' : 'start')}
              title={data?.running ? 'Stop the headless browser' : 'Start the headless browser now (bypasses the 09:22–15:30 window, for testing)'}
              className="rounded-md border border-border px-3 py-1.5 text-[11px] hover:bg-muted disabled:opacity-50"
            >
              {data?.running ? 'Stop browser' : 'Start now'}
            </button>
            {data?.session.verifiedAt && (
              <span className="text-[11px] text-muted-foreground">last confirmed working: {fmtDateTime(data.session.verifiedAt)}</span>
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
            {!readOnly && hasLog && (
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
          <table className="w-full text-[11px]">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-1 pr-3 text-left font-medium">Endpoint</th>
                <th className="py-1 pr-3 text-right font-medium">Success today</th>
                <th className="py-1 pr-3 text-right font-medium">Errors today</th>
                <th className="py-1 pr-3 text-left font-medium">Last capture (IST)</th>
                <th className="py-1 pr-3 text-left font-medium">Status</th>
                <th className="py-1 text-left font-medium">Error</th>
              </tr>
            </thead>
            <tbody>
              {feeds.map((f) => (
                <tr key={f.endpoint} className="border-b border-border/60">
                  <td className="py-1 pr-3 font-medium">{f.endpoint}</td>
                  <td className="py-1 pr-3 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                    {f.today.success}
                  </td>
                  <td
                    className={`py-1 pr-3 text-right tabular-nums ${f.today.error > 0 ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}
                  >
                    {f.today.error}
                  </td>
                  <td className="py-1 pr-3 tabular-nums">{f.last ? fmtDateTime(f.last.capturedAt) : 'never'}</td>
                  <td
                    className={`py-1 pr-3 ${
                      !f.last
                        ? 'text-muted-foreground'
                        : f.last.status === 'success'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-red-600 dark:text-red-400'
                    }`}
                  >
                    {f.last?.status ?? '—'}
                  </td>
                  <td className="py-1 text-muted-foreground">{f.last?.error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {data && (
        <section className="space-y-2 rounded-lg border border-border bg-card p-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Today&apos;s data</h2>
            {activeAt && (
              <span
                className={`text-[11px] ${ageMin != null && ageMin > STALE_MIN ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
              >
                captured {fmtDateTime(activeAt)} IST
                {ageMin != null && ageMin > STALE_MIN && ` · ${Math.round(ageMin)} min old`}
              </span>
            )}
          </div>
          {!data.today?.sectorScope && pulseLists.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Nothing captured today yet. Earlier days are on{' '}
              <a href="/tf/history" className="underline hover:text-foreground">
                EOD history
              </a>
              .
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1">
                {[
                  { key: 'sector_scope', label: 'sector scope', n: sectorRows.length },
                  ...pulseLists.map((l) => ({ key: l.name, label: listTitle(l.name), n: l.rows.length })),
                ].map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTab(t.key)}
                    className={`rounded-md border px-2 py-1 text-[11px] ${
                      tab === t.key ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted'
                    }`}
                  >
                    {t.label} <span className="opacity-70">{t.n}</span>
                  </button>
                ))}
              </div>
              <div className="max-h-[28rem] overflow-auto">
                {tab === 'sector_scope' ? (
                  sectorRows.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">No sector scope capture today yet.</p>
                  ) : (
                    <table className="w-full text-[11px]">
                      <thead className="sticky top-0 bg-card text-muted-foreground">
                        <tr className="border-b border-border">
                          <th className="py-1 pr-3 text-left font-medium">Symbol</th>
                          <th className="py-1 pr-3 text-left font-medium">Sectors</th>
                          <th className="py-1 pr-3 text-right font-medium">LTP</th>
                          <th className="py-1 pr-3 text-right font-medium">Prev close</th>
                          <th className="py-1 pr-3 text-right font-medium">Change</th>
                          <th className="py-1 text-right font-medium">R-Factor</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sectorRows.map((r) => (
                          <tr key={r.symbol} className="border-b border-border/60">
                            <td className="py-1 pr-3 font-mono font-medium">{r.symbol}</td>
                            <td className="py-1 pr-3 text-muted-foreground">{r.baskets.join(', ')}</td>
                            <td className="py-1 pr-3 text-right tabular-nums">{fmtNum(r.ltp)}</td>
                            <td className="py-1 pr-3 text-right tabular-nums">{fmtNum(r.previousClose)}</td>
                            <td className={`py-1 pr-3 text-right tabular-nums ${pctTone(r.pctChange)}`}>
                              {fmtPct(r.pctChange)}
                            </td>
                            <td className="py-1 text-right font-semibold tabular-nums">{fmtNum(r.rFactor)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                ) : activePulse ? (
                  <PulseTable list={activePulse} />
                ) : (
                  <p className="text-[11px] text-muted-foreground">That list is not in today&apos;s capture.</p>
                )}
              </div>
            </>
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

/** One market_pulse list, in TradeFinder's own order. Columns are labelled only
 *  where isPriceList() proved their meaning; param_3 is never labelled — its
 *  meaning differs by list and has not been confirmed. */
function PulseTable({ list }: { list: PulseList }) {
  const priced = isPriceList(list);
  const heads = priced ? ['LTP', 'Prev close', 'Change', 'param_3'] : ['param_0', 'param_1', 'param_2', 'param_3'];
  return (
    <table className="w-full text-[11px]">
      <thead className="sticky top-0 bg-card text-muted-foreground">
        <tr className="border-b border-border">
          <th className="py-1 pr-3 text-left font-medium">#</th>
          <th className="py-1 pr-3 text-left font-medium">Symbol</th>
          {heads.map((h) => (
            <th
              key={h}
              className="py-1 pr-3 text-right font-medium"
              title={h.startsWith('param_') ? 'TradeFinder field — meaning not confirmed yet' : undefined}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {list.rows.map((r, i) => (
          <tr key={`${r.symbol}-${i}`} className="border-b border-border/60">
            <td className="py-1 pr-3 tabular-nums text-muted-foreground">{i + 1}</td>
            <td className="py-1 pr-3 font-mono font-medium">{r.symbol}</td>
            {r.params.map((v, j) =>
              priced && j === 2 && typeof v === 'number' ? (
                <td key={j} className={`py-1 pr-3 text-right tabular-nums ${pctTone(v)}`}>
                  {fmtPct(v)}
                </td>
              ) : (
                <td key={j} className="py-1 pr-3 text-right tabular-nums">
                  {fmtNum(v)}
                </td>
              )
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
