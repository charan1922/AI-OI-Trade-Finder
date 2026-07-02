'use client';

import { CloudDownload, MousePointerClick } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TradeContextData, TradeDataStatus } from '../_lib/types';
import { DailyBarChart, fmtOI, fmtTurnover } from './daily-bar-chart';
import { DailyContextTable } from './daily-context-table';
import { HumanVerifiedBadge } from './human-verified-badge';
import { TradeRationale } from './trade-rationale';
import { tradeKey } from './trade-list';

interface TradeContextViewProps {
  trade: TradeDataStatus | null;
  /** Bump to force a re-fetch (after a bhavcopy sync). */
  refreshToken: number;
}

export function TradeContextView({ trade, refreshToken }: TradeContextViewProps) {
  const [ctx, setCtx] = useState<TradeContextData | null>(null);
  const [ctxKey, setCtxKey] = useState<string | null>(null);
  // Keyed like ctx so an error for trade A never shows while trade B is loading.
  const [ctxError, setCtxError] = useState<{ key: string; message: string } | null>(null);

  const hasData = !!trade && trade.status !== 'missing';
  const key = trade ? tradeKey(trade) : null;

  useEffect(() => {
    if (!trade || !hasData) return;
    const t = trade;
    const k = tradeKey(t);
    let ignore = false;
    (async () => {
      try {
        const res = await fetch('/api/backtest/tf-validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'trade-context',
            symbol: t.symbol,
            date: t.date,
            optionType: t.optionType,
            strike: t.strike,
            days: 30,
            expiry: t.expiry,
          }),
        });
        const d = await res.json();
        if (ignore) return;
        if (d.success) {
          setCtx(d.context as TradeContextData);
          setCtxKey(k);
          setCtxError(null);
        } else {
          setCtxError({ key: k, message: (d.error as string) ?? `Request failed (HTTP ${res.status})` });
        }
      } catch (e) {
        if (!ignore) setCtxError({ key: k, message: (e as Error).message });
      }
    })();
    return () => {
      ignore = true;
    };
    // refreshToken in deps to re-fetch after a download completes
  }, [trade, hasData, refreshToken]);

  if (!trade) {
    return (
      <div className="rounded-xl bg-card border border-border border-dashed px-4 py-16 text-center">
        <MousePointerClick className="w-5 h-5 text-muted-foreground mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">Select a trade to see the OI & turnover buildup behind it.</p>
      </div>
    );
  }

  if (trade.status === 'missing') {
    return (
      <div className="space-y-3">
        <Header trade={trade} />
        <div className="flex items-center gap-3 px-4 py-6 rounded-xl bg-amber-100 dark:bg-amber-500/10 border-2 border-amber-400 dark:border-amber-500/30 border-dashed">
          <CloudDownload className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
          <div className="flex-1">
            <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
              No NSE bhavcopy data for {trade.symbol} on {trade.date}
            </span>
            <p className="text-[11px] text-amber-600/70 dark:text-amber-400/60 mt-0.5">
              Click <strong>Sync NSE data</strong> (top of the page) — one file fills the trade day + ~30 sessions for
              every stock: equity, futures &amp; total option OI, and the traded {trade.optionType} {trade.strike} strike.
              If it stays empty, NSE doesn&apos;t serve it (symbol left F&amp;O, or a date outside bhavcopy coverage).
            </p>
          </div>
        </div>
      </div>
    );
  }

  const matches = ctx && ctxKey === key;
  if (!matches) {
    return (
      <div className="space-y-3">
        <Header trade={trade} />
        {ctxError && ctxError.key === key ? (
          <div className="rounded-xl bg-card border border-red-300 dark:border-red-500/30 px-4 py-6 text-center text-xs text-red-600 dark:text-red-400">
            Failed to load trade context: {ctxError.message} — select another trade and back (or reload the page) to
            retry.
          </div>
        ) : (
          <div className="rounded-xl bg-card border border-border px-4 py-16 text-center text-xs text-muted-foreground">
            Loading context…
          </div>
        )}
      </div>
    );
  }

  const days = ctx.days;

  return (
    <div className="space-y-3">
      <Header trade={trade} />

      <TradeRationale ctx={ctx} />

      <CalendarNote ctx={ctx} />

      <LegCoverageNote trade={trade} />

      {trade.status === 'partial' && (
        <div className="text-[11px] text-amber-600 dark:text-amber-400">
          Some sessions are missing{!trade.hasOptions && <> (option {trade.optionType} {trade.strike})</>} — click{' '}
          <strong>Sync NSE data</strong>. If it persists, NSE doesn&apos;t serve it: symbols that have left F&amp;O, or
          strikes/dates outside bhavcopy coverage, are unavailable.
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
        <DailyBarChart
          title="Total Option OI · CE+PE"
          hint="Total end-of-day open interest across ALL option strikes (calls + puts), official NSE bhavcopy. The stock-wide options positioning — far more telling than any single strike."
          mode="diff"
          data={days.map((d) => ({ date: d.date, value: d.optOITotal, isTradeDate: d.isTradeDate }))}
          format={fmtOI}
        />
        <DailyBarChart
          title="Futures OI"
          hint="Total end-of-day open interest across ALL futures contracts (official NSE bhavcopy) — the true open interest in this stock's futures, immune to single-contract maturation/rollover artifacts"
          mode="diff"
          data={days.map((d) => ({ date: d.date, value: d.futOI, isTradeDate: d.isTradeDate }))}
          format={fmtOI}
        />
        <DailyBarChart
          title="Futures Turnover"
          hint="Total futures traded value across all contracts (official NSE bhavcopy TtlTrfVal)"
          mode="solid"
          accent="rgba(14,165,233,0.85)"
          data={days.map((d) => ({ date: d.date, value: d.futTurnover, isTradeDate: d.isTradeDate }))}
          format={fmtTurnover}
        />
        <DailyBarChart
          title="Equity Turnover"
          hint="Official NSE equity traded value (bhavcopy)."
          mode="solid"
          accent="rgba(139,92,246,0.85)"
          data={days.map((d) => ({ date: d.date, value: d.eqTurnover, isTradeDate: d.isTradeDate }))}
          format={fmtTurnover}
        />
      </div>

      <DailyContextTable ctx={ctx} />
    </div>
  );
}

/**
 * Per-trade, per-SOURCE data coverage — every leg is NSE bhavcopy, filled by the
 * one "Sync NSE data" button. Green = covered, amber = partial, red = missing.
 * Gaps render as empty bars, never an estimate.
 */
function LegCoverageNote({ trade }: { trade: TradeDataStatus }) {
  const legs = trade.legs?.filter((l) => l.applicable) ?? [];
  if (legs.length === 0) return null;
  const needsSync = legs.some((l) => l.status !== 'ok');
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]">
      {legs.map((l) => {
        const ok = l.status === 'ok';
        const partial = l.status === 'partial';
        const cls = ok
          ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-100 dark:bg-emerald-500/10 border-emerald-300 dark:border-emerald-500/20'
          : partial
            ? 'text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-500/10 border-amber-300 dark:border-amber-500/20'
            : 'text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-500/10 border-red-300 dark:border-red-500/20';
        const icon = ok ? '✓' : partial ? '⚠' : '✗';
        const count =
          l.key === 'tradedOption'
            ? ok
              ? 'trade-day ✓'
              : 'trade-day missing'
            : l.sessionsKnown > 0
              ? `${l.daysPresent}/${l.sessionsKnown} sessions`
              : 'no data';
        const fix = ok ? '' : ' → Sync';
        return (
          <span
            key={l.key}
            title={`${l.label} — filled by the Sync NSE data button (official NSE bhavcopy)`}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-medium ${cls}`}
          >
            {icon} {l.label} · {count}
            {fix}
          </span>
        );
      })}
      {needsSync && (
        <span className="text-muted-foreground">
          Fill gaps: <strong>Sync NSE data</strong> (gaps shown as empty bars, never estimated).
        </span>
      )}
    </div>
  );
}

/**
 * Session accounting for the comparison window — makes weekend/holiday handling
 * explicit and flags symbol data gaps (market open, our data missing) that would
 * silently skew the 20-day baselines.
 */
function CalendarNote({ ctx }: { ctx: TradeContextData }) {
  const cal = ctx.calendar;
  if (!cal) return null;
  const md = (d: string) => d.slice(5); // YYYY-MM-DD → MM-DD
  return (
    <div className="text-[10px] text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span>
        Window <span className="font-mono">{cal.spanFrom} → {cal.spanTo}</span>: {cal.sessions} traded sessions
        (averages use sessions only)
      </span>
      <span className="text-border">·</span>
      <span>{cal.weekendsSkipped} weekend days skipped</span>
      {cal.holidays.length > 0 && (
        <>
          <span className="text-border">·</span>
          <span
            title={cal.holidays.map((h) => `${h.date}${h.occasion ? ` — ${h.occasion}` : ''}`).join(', ')}
            className="cursor-help"
          >
            {cal.holidays.length} market holiday{cal.holidays.length > 1 ? 's' : ''} skipped (
            {cal.holidays.map((h) => `${md(h.date)}${h.occasion ? ` ${h.occasion}` : ''}`).join(', ')})
          </span>
        </>
      )}
      {cal.specialSessions.length > 0 && (
        <>
          <span className="text-border">·</span>
          <span className="text-sky-600 dark:text-sky-400">
            includes weekend special session{cal.specialSessions.length > 1 ? 's' : ''}{' '}
            {cal.specialSessions.map(md).join(', ')}
          </span>
        </>
      )}
      {cal.symbolGaps.length > 0 && (
        <>
          <span className="text-border">·</span>
          <span className="text-amber-600 dark:text-amber-400 font-medium" title={cal.symbolGaps.join(', ')}>
            ⚠ {cal.symbolGaps.length} data gap{cal.symbolGaps.length > 1 ? 's' : ''} (market traded, no data:{' '}
            {cal.symbolGaps.map(md).join(', ')})
          </span>
        </>
      )}
      {cal.noDataDays.length > 0 && (
        <>
          <span className="text-border">·</span>
          <span title={cal.noDataDays.join(', ')} className="cursor-help">
            {cal.noDataDays.length} weekday{cal.noDataDays.length > 1 ? 's' : ''} with no market data (not on official
            holiday list: {cal.noDataDays.map(md).join(', ')})
          </span>
        </>
      )}
    </div>
  );
}

function Header({ trade }: { trade: TradeDataStatus }) {
  const ret =
    trade.entryPrice && trade.exitPrice && trade.entryPrice > 0
      ? ((trade.exitPrice - trade.entryPrice) / trade.entryPrice) * 100
      : null;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <HumanVerifiedBadge show={trade.humanReview} />
      <span className="text-sm font-bold text-foreground">{trade.symbol}</span>
      <span
        className={`text-xs font-medium ${
          trade.optionType === 'CE' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
        }`}
      >
        {trade.optionType} {trade.strike}
      </span>
      <span className="text-[11px] text-muted-foreground font-mono">{trade.date}</span>
      <span
        className={`text-xs font-mono font-bold ${trade.pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
      >
        {trade.pnl >= 0 ? '+' : ''}₹{(trade.pnl / 1000).toFixed(1)}K
      </span>
      {trade.entryPrice && trade.exitPrice && (
        <span className="text-[11px] text-muted-foreground font-mono">
          ₹{trade.entryPrice} → ₹{trade.exitPrice}
          {ret != null && <span className="ml-1">({ret >= 0 ? '+' : ''}{ret.toFixed(0)}%)</span>}
        </span>
      )}
    </div>
  );
}

