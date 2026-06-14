'use client';

import { Download, MousePointerClick, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TradeContextData, TradeContractIds, TradeDataStatus } from '../_lib/types';
import { DailyBarChart, fmtOI, fmtTurnover } from './daily-bar-chart';
import { DailyContextTable } from './daily-context-table';
import { HumanVerifiedBadge } from './human-verified-badge';
import { TradeRationale } from './trade-rationale';
import { tradeKey } from './trade-list';

interface TradeContextViewProps {
  trade: TradeDataStatus | null;
  isDownloading: boolean;
  onDownload: (t: TradeDataStatus) => void;
  /** Bump to force a re-fetch (after a download completes). */
  refreshToken: number;
}

export function TradeContextView({ trade, isDownloading, onDownload, refreshToken }: TradeContextViewProps) {
  const [ctx, setCtx] = useState<TradeContextData | null>(null);
  const [contracts, setContracts] = useState<TradeContractIds | null>(null);
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
          }),
        });
        const d = await res.json();
        if (ignore) return;
        if (d.success) {
          setCtx(d.context as TradeContextData);
          setContracts((d.contracts as TradeContractIds | null) ?? null);
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
        <Header trade={trade} onDownload={onDownload} isDownloading={isDownloading} />
        <div className="flex items-center gap-3 px-4 py-6 rounded-xl bg-amber-100 dark:bg-amber-500/10 border-2 border-amber-400 dark:border-amber-500/30 border-dashed">
          <Download className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
          <div className="flex-1">
            <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
              No data for {trade.symbol} on {trade.date}
            </span>
            <p className="text-[11px] text-amber-600/70 dark:text-amber-400/60 mt-0.5">
              One click fetches everything for this trade (trade day + ~30 sessions): equity + futures + {trade.optionType}{' '}
              {trade.strike} option from Dhan, plus the NSE bhavcopy OI totals behind the charts.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onDownload(trade)}
            disabled={isDownloading}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-100 dark:bg-amber-500/20 hover:bg-amber-200 dark:hover:bg-amber-500/30 text-amber-700 dark:text-amber-300 border border-amber-400 dark:border-amber-500/40 text-xs font-semibold disabled:opacity-50 shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            {isDownloading ? 'Getting data…' : 'Get all data'}
          </button>
        </div>
      </div>
    );
  }

  const matches = ctx && ctxKey === key;
  if (!matches) {
    return (
      <div className="space-y-3">
        <Header trade={trade} onDownload={onDownload} isDownloading={isDownloading} />
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
      <Header trade={trade} onDownload={onDownload} isDownloading={isDownloading} />

      <TradeRationale ctx={ctx} />

      <ContractChips contracts={contracts} />

      <CalendarNote ctx={ctx} />

      <LegCoverageNote trade={trade} />

      {trade.status === 'partial' && (
        <div className="text-[11px] text-amber-600 dark:text-amber-400">
          Some legs are missing{!trade.hasOptions && <> (option {trade.optionType} {trade.strike})</>} — try Get all
          data. If it persists, the source doesn&apos;t serve that data: expired options beyond the ATM±3 band, and
          bhavcopy OI for symbols that have left F&O, are unavailable.
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
          hint="Official NSE equity traded value (bhavcopy). Falls back to Σ(5-min volume × close) from Dhan candles only for days bhavcopy hasn't covered."
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
 * Preserved Dhan contract IDs (resolved at download time, reused on Re-sync —
 * no fresh master-contract lookup needed). Transparency: exactly which
 * instruments back this trade's data.
 */
function ContractChips({ contracts }: { contracts: TradeContractIds | null }) {
  if (!contracts) return null;
  const chips: { id: string; text: string; title: string }[] = [];
  if (contracts.eqSecurityId)
    chips.push({ id: 'eq', text: `EQ #${contracts.eqSecurityId}`, title: 'Equity securityId (Dhan)' });
  if (contracts.futSecurityId)
    chips.push({
      id: 'fut',
      text: `FUT #${contracts.futSecurityId}${contracts.futExpiry ? ` · exp ${contracts.futExpiry.slice(0, 10)}` : ''}${
        contracts.futLotSize ? ` · lot ${contracts.futLotSize}` : ''
      }`,
      title: 'Futures contract securityId resolved for this trade window',
    });
  if (contracts.optSecurityId)
    chips.push({ id: 'opt', text: `OPT #${contracts.optSecurityId}`, title: 'Option contract securityId (Dhan)' });
  else if (contracts.optVia)
    chips.push({
      id: 'opt-via',
      text: `OPT via ${contracts.optVia.split('(')[0]}`,
      title: `Expired contract — fetched via ${contracts.optVia}`,
    });
  if (chips.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap text-[10px] font-mono">
      <span className="text-muted-foreground/70">Contracts:</span>
      {chips.map((c) => (
        <span
          key={c.id}
          title={c.title}
          className="px-1.5 py-0.5 rounded border bg-muted/50 text-muted-foreground border-border cursor-help"
        >
          {c.text}
        </span>
      ))}
      <span className="text-muted-foreground/50">preserved {contracts.resolvedAt.slice(0, 10)} · reused on Re-sync</span>
    </div>
  );
}

/**
 * Per-trade, per-SOURCE data coverage. Each leg is filled by a different action,
 * so the report says which: equity / futures / traded option come from the
 * per-trade Download button (Dhan); the OI charts come from the separate Sync
 * button (NSE bhavcopy). Green = covered, amber = partial, red = missing — with
 * the exact button to click. Gaps render as empty bars, never an estimate.
 */
function LegCoverageNote({ trade }: { trade: TradeDataStatus }) {
  const legs = trade.legs?.filter((l) => l.applicable) ?? [];
  if (legs.length === 0) return null;
  const needsSync = legs.some((l) => l.status !== 'ok' && l.fixedBy === 'sync');
  const needsDownload = legs.some((l) => l.status !== 'ok' && l.fixedBy === 'download');
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
        const fix = ok ? '' : l.fixedBy === 'sync' ? ' → Sync' : ' → Download';
        return (
          <span
            key={l.key}
            title={`${l.label} — filled by ${
              l.fixedBy === 'sync' ? 'the Sync button (NSE bhavcopy)' : 'the per-trade Download button (Dhan)'
            }`}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border font-medium ${cls}`}
          >
            {icon} {l.label} · {count}
            {fix}
          </span>
        );
      })}
      {(needsSync || needsDownload) && (
        <span className="text-muted-foreground">
          Fill gaps:{' '}
          {needsDownload && <strong>Download</strong>}
          {needsDownload && needsSync && ' + '}
          {needsSync && <strong>Sync</strong>} (gaps shown as empty bars, never estimated).
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

function Header({
  trade,
  onDownload,
  isDownloading,
}: {
  trade: TradeDataStatus;
  onDownload: (t: TradeDataStatus) => void;
  isDownloading: boolean;
}) {
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
      <button
        type="button"
        onClick={() => onDownload(trade)}
        disabled={isDownloading}
        className="ml-auto flex items-center gap-1 px-2 py-1 rounded-md bg-muted hover:bg-accent text-muted-foreground text-[11px] disabled:opacity-50"
        title={`Re-fetch ALL data for this trade (${trade.symbol} ${trade.optionType} ${trade.strike}, ${trade.date}): equity + futures + option from Dhan, plus NSE bhavcopy OI totals. One click, both sources.`}
      >
        <RefreshCw className={`w-3 h-3 ${isDownloading ? 'animate-spin' : ''}`} />
        {isDownloading ? 'Getting data…' : 'Get all data'}
      </button>
    </div>
  );
}

