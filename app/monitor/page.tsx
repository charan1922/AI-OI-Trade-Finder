'use client';

/**
 * /monitor — live view of the autonomous engine (admin-only). Polls
 * /api/monitor every 5s and shows poller + guard health, token status, the
 * day's AI/system decision feed (the closest thing to a live activity log), and
 * today's orders/trades. Read-only: it never places or changes anything.
 */

import { Activity, AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

const IST = 'Asia/Kolkata';
const fmtTime = (v: number | string | null | undefined) => {
  if (v == null) return '—';
  const d = typeof v === 'number' ? new Date(v) : new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-IN', { timeZone: IST, hour12: false });
};
interface Decision {
  id: number;
  at: string;
  pass: string;
  provider: string | null;
  model: string | null;
  summary: string;
}
interface MonitorData {
  success: boolean;
  now: string;
  marketOpen: boolean;
  settings: {
    mode: string;
    killSwitch: boolean;
    broker: string;
    aiProvider: string;
    liveEnvEnabled: boolean;
  };
  poller: {
    started: boolean;
    paused: boolean;
    cycles: number;
    cycleRunning: boolean;
    nextTickAt: number | null;
    captureRunning: boolean;
    captureSkips: number;
    lastCycle: {
      startedAt: string;
      durationMs: number;
      symbolsProcessed: number;
      universeSize: number;
      eqBars: number;
      futBars: number;
      oiAttached: number;
      apiCalls: number;
      errors: { symbol: string; stage: string; message: string }[];
      skipped?: string;
    } | null;
    lastCapture: {
      status: string;
      tickToScanMs: number | null;
      scanToDecisionMs: number | null;
      tickToDecisionMs: number | null;
      detail: string | null;
    } | null;
    lastWarmup: { date: string; at: number; fyers: string; dhan: string } | null;
  };
  guard: {
    started: boolean;
    ticks: number;
    lastTick: { at: string; openTrades: number } | null;
    lastActive: { at: string; openTrades: number; actions: string[] } | null;
  };
  tokens: {
    fyers: { cached: boolean; expiresAt: number | null };
    dhan: { cached: boolean; expiresAt: number | null };
  };
  decisions: Decision[];
  trades: {
    trade: {
      id: number;
      symbol: string;
      optionType: string;
      strike: number;
      lots: number;
      status: string;
      mode: string;
      entryFillPremium: number | null;
      exitFillPremium: number | null;
      realizedPnlRupees: number | null;
      aiReasonEntry: string;
    };
    orders: { id: number; side: string; status: string; brokerOrderId: string | null; error: string | null }[];
  }[];
  error?: string;
}

const Dot = ({ ok }: { ok: boolean }) => (
  <span className={`inline-block h-2 w-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`} />
);

const Chip = ({ label, tone = 'muted' }: { label: string; tone?: 'muted' | 'green' | 'amber' | 'red' | 'sky' }) => {
  const cls = {
    muted: 'bg-muted text-muted-foreground',
    green: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
    red: 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400',
    sky: 'bg-sky-100 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400',
  }[tone];
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>{label}</span>;
};

const passTone = (p: string): 'green' | 'amber' | 'sky' | 'muted' =>
  p === 'ai' ? 'sky' : p === 'guard' ? 'amber' : p === 'approval' ? 'green' : 'muted';

export default function MonitorPage() {
  const [data, setData] = useState<MonitorData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/monitor', { cache: 'no-store' });
      const json = (await res.json()) as MonitorData;
      if (json.success) {
        setData(json);
        setError(null);
      } else {
        setError(json.error ?? 'failed to load');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const run = async () => {
      if (!active) return;
      await load();
      if (active) timer.current = setTimeout(run, 5000);
    };
    // Defer the first load to a macrotask so the effect body itself does not
    // trigger setState synchronously (react-hooks/set-state-in-effect).
    timer.current = setTimeout(run, 0);
    return () => {
      active = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  const s = data?.settings;
  const p = data?.poller;
  const armed = s?.mode === 'live' && !s?.killSwitch && s?.liveEnvEnabled;

  return (
    <div className="mx-auto max-w-5xl space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Activity className="h-5 w-5 text-primary" />
        <h1 className="text-base font-bold text-foreground">Live Monitor</h1>
        {data && (
          <>
            <Chip label={data.marketOpen ? 'market OPEN' : 'market closed'} tone={data.marketOpen ? 'green' : 'muted'} />
            {s && (
              <Chip
                label={`mode: ${s.mode}${s.killSwitch ? ' · KILL' : ''}`}
                tone={s.killSwitch ? 'red' : s.mode === 'live' ? 'green' : s.mode === 'off' ? 'muted' : 'amber'}
              />
            )}
            {armed && <Chip label="LIVE ARMED" tone="red" />}
          </>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <RefreshCw className="h-3 w-3 animate-spin" style={{ animationDuration: '5s' }} />
          auto 5s{data && ` · ${fmtTime(data.now)}`}
        </span>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-600 dark:text-red-400">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}
      {loading && !data && (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-border p-8 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin text-primary" /> Loading…
        </div>
      )}

      {data && p && (
        <>
          {/* Health cards */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-card p-3 text-xs">
              <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-foreground">
                <Dot ok={p.started && !p.paused} /> Poller
              </div>
              <div className="space-y-0.5 text-muted-foreground">
                <div>cycles: <span className="text-foreground">{p.cycles}</span>{p.cycleRunning && ' (running)'}</div>
                <div>next tick: <span className="text-foreground">{fmtTime(p.nextTickAt)}</span></div>
                {p.lastCycle && (
                  <>
                    <div>
                      last: <span className="text-foreground">{p.lastCycle.symbolsProcessed}/{p.lastCycle.universeSize}</span> syms · {(p.lastCycle.durationMs / 1000).toFixed(0)}s
                    </div>
                    <div>
                      bars: {p.lastCycle.eqBars}eq/{p.lastCycle.futBars}fut · OI {p.lastCycle.oiAttached}
                    </div>
                    <div className={p.lastCycle.errors.length ? 'text-red-500' : ''}>
                      errors: {p.lastCycle.errors.length}
                      {p.lastCycle.skipped ? ` · skipped: ${p.lastCycle.skipped}` : ''}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-card p-3 text-xs">
              <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-foreground">
                <Dot ok={data.tokens.fyers.cached} /> Tokens
              </div>
              <div className="space-y-0.5 text-muted-foreground">
                <div>fyers: <span className="text-foreground">{data.tokens.fyers.cached ? 'cached' : 'none'}</span> · exp {fmtTime(data.tokens.fyers.expiresAt)}</div>
                <div>dhan: <span className="text-foreground">{data.tokens.dhan.cached ? 'cached' : 'none'}</span> · exp {fmtTime(data.tokens.dhan.expiresAt)}</div>
                {p.lastWarmup && (
                  <div className="pt-1">
                    warmup {fmtTime(p.lastWarmup.at)}: fyers <span className={p.lastWarmup.fyers === 'ok' ? 'text-emerald-500' : 'text-red-500'}>{p.lastWarmup.fyers}</span> · dhan <span className={p.lastWarmup.dhan === 'ok' ? 'text-emerald-500' : 'text-red-500'}>{p.lastWarmup.dhan}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-card p-3 text-xs">
              <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-foreground">
                <Dot ok={data.guard.started} /> Guard + latency
              </div>
              <div className="space-y-0.5 text-muted-foreground">
                <div>guard ticks: <span className="text-foreground">{data.guard.ticks}</span></div>
                <div>last tick: {fmtTime(data.guard.lastTick?.at)} · open {data.guard.lastTick?.openTrades ?? 0}</div>
                {p.lastCapture && (
                  <>
                    <div>tick→scan: <span className="text-foreground">{p.lastCapture.tickToScanMs != null ? `${(p.lastCapture.tickToScanMs / 1000).toFixed(1)}s` : '—'}</span></div>
                    <div>scan→decision: <span className="text-foreground">{p.lastCapture.scanToDecisionMs != null ? `${p.lastCapture.scanToDecisionMs}ms` : '—'}</span></div>
                    <div className="truncate" title={p.lastCapture.detail ?? ''}>{p.lastCapture.status}{p.lastCapture.detail ? ` · ${p.lastCapture.detail}` : ''}</div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Today's trades */}
          {data.trades.length > 0 && (
            <div className="rounded-lg border border-border">
              <div className="border-b border-border px-3 py-1.5 text-xs font-semibold text-foreground">Today&apos;s trades</div>
              <div className="divide-y divide-border/50">
                {data.trades.map(({ trade: t, orders }) => (
                  <div key={t.id} className="p-2.5 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{t.symbol} {t.strike}{t.optionType}</span>
                      <Chip label={t.status} tone={t.status === 'open' ? 'green' : t.status === 'failed' || t.status === 'rejected' ? 'red' : 'muted'} />
                      {t.mode !== 'paper' && <Chip label={t.mode} tone="amber" />}
                      <span className="text-muted-foreground">
                        entry {t.entryFillPremium != null ? `₹${t.entryFillPremium}` : '—'} · exit {t.exitFillPremium != null ? `₹${t.exitFillPremium}` : '—'}
                        {t.realizedPnlRupees != null && ` · P&L ₹${t.realizedPnlRupees}`}
                      </span>
                    </div>
                    {orders.map((o) => (
                      <div key={o.id} className="mt-1 pl-2 text-[11px] text-muted-foreground">
                        order #{o.id} {o.side} · {o.status}{o.brokerOrderId ? ` · id ${o.brokerOrderId}` : ''}
                        {o.error && <span className="text-red-500"> · {o.error}</span>}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Decision / activity feed — the live "log" */}
          <div className="rounded-lg border border-border">
            <div className="border-b border-border px-3 py-1.5 text-xs font-semibold text-foreground">
              Activity feed — today&apos;s decisions ({data.decisions.length})
            </div>
            {data.decisions.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
                No decisions recorded yet today. Passes appear here each poller cycle during market hours.
              </div>
            ) : (
              <div className="max-h-[50vh] divide-y divide-border/50 overflow-y-auto">
                {data.decisions.map((d) => (
                  <div key={d.id} className="flex gap-2 p-2 text-xs">
                    <span className="shrink-0 tabular-nums text-muted-foreground">{fmtTime(d.at)}</span>
                    <Chip label={d.pass} tone={passTone(d.pass)} />
                    <span className="text-foreground">
                      {d.summary}
                      {(d.provider || d.model) && (
                        <span className="ml-1 text-[10px] text-muted-foreground">[{[d.provider, d.model].filter(Boolean).join(' ')}]</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <p className="text-[10px] text-muted-foreground">
            Read-only monitor — it never places or changes orders. Poller status is in-memory (resets on a redeploy);
            decisions and trades are from the database. Times are IST.
          </p>
        </>
      )}
    </div>
  );
}
