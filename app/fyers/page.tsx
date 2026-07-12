'use client';

import { Activity, ChevronDown, ChevronRight, Download, KeyRound, Loader2, Pause, Play, RefreshCw, Radio } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRole } from '@/lib/auth/use-role';

/** Mirror of lib/fyers/poller.ts CycleSummary / PollerStatus (API response shapes). */
interface CycleError {
  symbol: string;
  stage: string;
  message: string;
}
interface CycleSummary {
  date: string;
  startedAt: string;
  durationMs: number;
  trigger: string;
  universeSize: number;
  symbolsProcessed: number;
  apiCalls: number;
  eqBars: number;
  futBars: number;
  oiAttached: number;
  skipped?: string;
  errors: CycleError[];
}
interface CoverageRow {
  symbol: string;
  instrument: string;
  bars: number;
  lastBucketTs: number;
  lastOi: number;
  pdoi: number | null;
  oiPct: number | null;
  atp: number | null;
  dayVolume: number | null;
  buyQty: number | null;
  sellQty: number | null;
  futLtp: number | null;
  nseOiPct: number | null;
  eqTurnover: number | null;
  eqDayVolume: number | null;
}
interface PollerStatus {
  success: boolean;
  started: boolean;
  paused: boolean;
  cycleRunning: boolean;
  cycles: number;
  nextTickAt: number | null;
  lastCycle: CycleSummary | null;
  marketOpen: boolean;
  credentialsConfigured: boolean;
  token: { cached: boolean; expiresAt: number | null };
  universe: { date: string; symbols: string[] } | null;
  coverage?: CoverageRow[];
}

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

const fmtBucket = (bucketTs: number) => (bucketTs > 0 ? fmtTime(bucketTs * 1000) : '—');

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

/** One coverage line per symbol: EQ + FUT merged (OI/depth exist only on futures). */
interface MergedCoverage {
  symbol: string;
  eqBars: number;
  futBars: number;
  lastBucketTs: number;
  lastOi: number;
  oiPct: number | null;
  atp: number | null;
  dayVolume: number | null;
  /** Derived: atp × dayVolume (₹) — Fyers has no explicit turnover field. */
  turnover: number | null;
  /** Derived: Σ(close × volume) over today's recorded EQ bars (₹). */
  eqTurnover: number | null;
  /** Derived: buyQty ÷ (buyQty + sellQty), resting-book buy pressure [0,1]. */
  buyPressure: number | null;
  futLtp: number | null;
  /** NSE's combined OI %-change (futures + options) — NSE-sourced, not Fyers. */
  nseOiPct: number | null;
}

function mergeCoverage(rows: CoverageRow[]): MergedCoverage[] {
  const bySymbol = new Map<string, MergedCoverage>();
  for (const r of rows) {
    const m =
      bySymbol.get(r.symbol) ??
      ({
        symbol: r.symbol,
        eqBars: 0,
        futBars: 0,
        lastBucketTs: 0,
        lastOi: 0,
        oiPct: null,
        atp: null,
        dayVolume: null,
        turnover: null,
        eqTurnover: null,
        buyPressure: null,
        futLtp: null,
        nseOiPct: null,
      } as MergedCoverage);
    if (r.instrument === 'EQ') {
      m.eqBars = r.bars;
      m.eqTurnover = r.eqTurnover;
    } else {
      m.futBars = r.bars;
      m.oiPct = r.oiPct;
      m.atp = r.atp;
      m.dayVolume = r.dayVolume;
      m.turnover = r.atp != null && r.dayVolume != null ? r.atp * r.dayVolume : null;
      m.buyPressure = r.buyQty != null && r.sellQty != null && r.buyQty + r.sellQty > 0 ? r.buyQty / (r.buyQty + r.sellQty) : null;
      m.futLtp = r.futLtp;
      m.nseOiPct = r.nseOiPct;
    }
    m.lastBucketTs = Math.max(m.lastBucketTs, r.lastBucketTs);
    m.lastOi = Math.max(m.lastOi, r.lastOi);
    bySymbol.set(r.symbol, m);
  }
  return [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

const fmtCrore = (v: number | null) => (v == null ? '—' : `₹${(v / 1e7).toFixed(0)} Cr`);
const fmtPctSigned = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

export default function FyersPage() {
  const [status, setStatus] = useState<PollerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [universeOpen, setUniverseOpen] = useState(false);
  const { readOnly } = useRole();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/fyers/poller?coverage=1');
      const j = (await res.json()) as PollerStatus;
      if (j.success) {
        setStatus(j);
        setError(null);
      } else {
        setError('Failed to load status');
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Self-scheduling timer chain (same pattern as the movers page) — the first
  // fetch runs from a timeout callback, never synchronously inside the effect.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (delay: number) => {
      timer = setTimeout(async () => {
        if (stopped) return;
        await refresh();
        if (stopped) return;
        schedule(POLL_MS);
      }, delay);
    };
    schedule(0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [refresh]);

  const act = useCallback(
    async (action: 'pause' | 'resume' | 'run-once') => {
      setActing(action);
      try {
        await fetch('/api/fyers/poller', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        await refresh();
      } finally {
        setActing(null);
      }
    },
    [refresh],
  );

  // Force a fresh access token (clears cache, re-runs the TOTP login chain).
  // Daily regeneration is automatic — this is for on-demand recovery/inspection.
  const regenToken = useCallback(async () => {
    setActing('token');
    try {
      const res = await fetch('/api/fyers/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j = (await res.json()) as { success: boolean; error?: string };
      if (!j.success) setError(j.error ?? 'Token generation failed');
      else setError(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActing(null);
    }
  }, [refresh]);

  const last = status?.lastCycle;
  const merged = useMemo(() => mergeCoverage(status?.coverage ?? []), [status?.coverage]);
  // Freshest stored bar across all symbols — proves data exists even right after
  // a server restart, when the in-memory cycle counter reads zero.
  const latestStoredTs = useMemo(() => Math.max(0, ...merged.map((m) => m.lastBucketTs)), [merged]);

  return (
    <div className="mx-auto max-w-5xl space-y-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-sm font-semibold">
          <Radio className="h-4 w-4 text-primary" />
          Fyers Live F&O Downloader
        </h1>
        <div className="flex items-center gap-1.5">
          {status && (
            <>
              <Badge ok={status.started && !status.paused} okLabel="running" badLabel={status.paused ? 'paused' : 'stopped'} />
              <Badge ok={status.marketOpen} okLabel="market open" badLabel="market closed" />
              <Badge ok={status.credentialsConfigured} okLabel="creds ok" badLabel="no credentials" />
              <Badge ok={status.token.cached} okLabel={`token · exp ${fmtTime(status.token.expiresAt)}`} badLabel="no token" />
            </>
          )}
          <button
            type="button"
            onClick={() => void act(status?.paused ? 'resume' : 'pause')}
            disabled={!!acting || !status || readOnly}
            title={readOnly ? 'Read-only session — poller control needs the operator login' : undefined}
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-60"
          >
            {status?.paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            {status?.paused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            onClick={() => void act('run-once')}
            disabled={!!acting || !status || readOnly}
            title={readOnly ? 'Read-only session — poller control needs the operator login' : undefined}
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-60"
          >
            {acting === 'run-once' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
            Run once
          </button>
          <button
            type="button"
            onClick={() => void regenToken()}
            disabled={!!acting || !status?.credentialsConfigured || readOnly}
            title={
              readOnly
                ? 'Read-only session — token management needs the operator login'
                : 'Force a fresh Fyers access token via the TOTP login chain (daily regeneration is automatic)'
            }
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] hover:bg-accent disabled:opacity-60"
          >
            {acting === 'token' ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
            New token
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            title="Refresh status"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </div>
      </div>

      {error && <div className="rounded border border-red-300 px-3 py-2 text-[11px] text-red-600">{error}</div>}
      {!status && !error && (
        <div className="flex items-center gap-2 px-3 py-6 text-[11px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" /> Loading…
        </div>
      )}

      {status && (
        <>
          <div className="rounded-lg border border-border bg-card p-2.5">
            <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide">
              <Activity className="h-3.5 w-3.5" />
              Last cycle
              {status.cycleRunning && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
              <span className="ml-auto font-normal normal-case text-muted-foreground">
                #{status.cycles} · next tick {fmtTime(status.nextTickAt)} IST
              </span>
            </h2>
            {!last ? (
              <div className="px-1 py-2 text-[11px] text-muted-foreground">
                {latestStoredTs > 0
                  ? `No cycle since the server started — today's data through ${fmtBucket(latestStoredTs)} IST is already stored and the next tick continues from there.`
                  : 'No cycle has run yet.'}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                  <Stat label="date" value={last.date} />
                  <Stat label="universe" value={`${last.symbolsProcessed}/${last.universeSize}`} />
                  <Stat label="eq bars" value={String(last.eqBars)} />
                  <Stat label="fut bars" value={String(last.futBars)} />
                  <Stat label="OI attached" value={String(last.oiAttached)} />
                  <Stat label="duration" value={`${(last.durationMs / 1000).toFixed(1)}s`} />
                </div>
                <div className="mt-1.5 text-[10px] text-muted-foreground">
                  {last.trigger} · {last.apiCalls} API calls · started {fmtTime(Date.parse(last.startedAt))} IST
                  {last.skipped && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                      skipped: {last.skipped}
                    </span>
                  )}
                </div>
                {last.errors.length > 0 && (
                  <div className="mt-2 max-h-40 overflow-y-auto rounded border border-red-300/40">
                    {last.errors.map((e) => (
                      <div
                        key={`${e.symbol}-${e.stage}-${e.message}`}
                        className="flex gap-2 border-b border-border/30 px-2 py-1 text-[10px]"
                      >
                        <span className="w-24 shrink-0 font-mono font-medium">{e.symbol}</span>
                        <span className="w-20 shrink-0 text-muted-foreground">{e.stage}</span>
                        <span className="truncate text-red-600 dark:text-red-400" title={e.message}>
                          {e.message}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="rounded-lg border border-border bg-card p-2.5">
            <button
              type="button"
              onClick={() => setUniverseOpen((o) => !o)}
              className="flex w-full items-center gap-1.5 text-left text-[11px] font-semibold uppercase tracking-wide"
            >
              {universeOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              Tracked universe
              <span className="font-normal normal-case text-muted-foreground">
                {status.universe ? `${status.universe.symbols.length} symbols · ${status.universe.date}` : 'not built yet'}
              </span>
            </button>
            {universeOpen && (
              <div className="mt-2 flex flex-wrap gap-1">
                {(status.universe?.symbols ?? []).map((s) => (
                  <span key={s} className="rounded bg-accent px-1.5 py-0.5 font-mono text-[10px]">
                    {s}
                  </span>
                ))}
              </div>
            )}
          </div>

          {merged.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-2.5">
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide">
                Today&apos;s coverage
                <span className="ml-2 font-normal normal-case text-muted-foreground">
                  {merged.length} symbols · OI is a futures-contract metric (equities have none)
                </span>
              </h2>
              <div className="max-h-80 overflow-auto">
                <table className="w-full text-[10px]">
                  <thead className="sticky top-0 bg-card text-left text-muted-foreground">
                    <tr>
                      <th className="px-1.5 py-1 font-medium">Symbol</th>
                      <th className="px-1.5 py-1 text-right font-medium">EQ bars</th>
                      <th className="px-1.5 py-1 text-right font-medium">FUT bars</th>
                      <th className="px-1.5 py-1 text-right font-medium">Last bar</th>
                      <th className="px-1.5 py-1 text-right font-medium">Fut LTP</th>
                      <th className="px-1.5 py-1 text-right font-medium">Fut OI</th>
                      <th
                        className="px-1.5 py-1 text-right font-medium"
                        title="Fyers: near-month FUTURES contract OI %-change vs previous day"
                      >
                        Fut OI Δ%
                      </th>
                      <th
                        className="px-1.5 py-1 text-right font-medium"
                        title="NSE oi-spurts feed (futures + options combined) — NSE-sourced, matches /nse/movers"
                      >
                        NSE OI Δ%
                      </th>
                      <th className="px-1.5 py-1 text-right font-medium" title="Day VWAP of the future (atp)">
                        VWAP
                      </th>
                      <th className="px-1.5 py-1 text-right font-medium" title="Derived: VWAP × day volume (futures)">
                        Fut T/O
                      </th>
                      <th
                        className="px-1.5 py-1 text-right font-medium"
                        title="Derived: Σ(close × volume) over today's recorded equity 5-min bars"
                      >
                        EQ T/O
                      </th>
                      <th
                        className="px-1.5 py-1 text-right font-medium"
                        title="Resting-book buy pressure: totalbuyqty ÷ (buy+sell). >50% = bid-heavy"
                      >
                        Buy%
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {merged.map((r) => (
                      <tr key={r.symbol} className="border-b border-border/30">
                        <td className="px-1.5 py-0.5 font-mono font-medium">{r.symbol}</td>
                        <td className="px-1.5 py-0.5 text-right tabular-nums">{r.eqBars}</td>
                        <td className="px-1.5 py-0.5 text-right tabular-nums">{r.futBars}</td>
                        <td className="px-1.5 py-0.5 text-right tabular-nums">{fmtBucket(r.lastBucketTs)}</td>
                        <td className="px-1.5 py-0.5 text-right tabular-nums">{r.futLtp?.toLocaleString('en-IN') ?? '—'}</td>
                        <td className="px-1.5 py-0.5 text-right tabular-nums">
                          {r.lastOi > 0 ? r.lastOi.toLocaleString('en-IN') : '—'}
                        </td>
                        <td
                          className={`px-1.5 py-0.5 text-right tabular-nums ${
                            r.oiPct == null ? '' : r.oiPct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                          }`}
                        >
                          {fmtPctSigned(r.oiPct)}
                        </td>
                        <td
                          className={`px-1.5 py-0.5 text-right tabular-nums ${
                            r.nseOiPct == null ? '' : r.nseOiPct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                          }`}
                        >
                          {fmtPctSigned(r.nseOiPct)}
                        </td>
                        <td className="px-1.5 py-0.5 text-right tabular-nums">{r.atp?.toLocaleString('en-IN') ?? '—'}</td>
                        <td className="px-1.5 py-0.5 text-right tabular-nums">{fmtCrore(r.turnover)}</td>
                        <td className="px-1.5 py-0.5 text-right tabular-nums">{fmtCrore(r.eqTurnover)}</td>
                        <td className="px-1.5 py-0.5 text-right tabular-nums">
                          {r.buyPressure == null ? '—' : `${(r.buyPressure * 100).toFixed(0)}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
