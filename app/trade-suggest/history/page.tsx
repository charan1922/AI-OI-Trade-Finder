'use client';

import { ChevronDown, ChevronRight, ExternalLink, Loader2, NotebookText, RefreshCw } from 'lucide-react';
import { Fragment, useCallback, useEffect, useState } from 'react';

/** Mirrors lib/trade-suggest/store.ts StoredSuggestion (the persisted row). */
interface StoredRow {
  date: string;
  symbol: string;
  optionType: 'CE' | 'PE';
  strike: number;
  expiryDate: string;
  spotAtSuggest: number;
  slSpot: number | null;
  targetSpot: number | null;
  lotSize: number;
  sector: string;
  rFactor: number;
  confidence: number;
  oiLevel: number;
  oiUrgency: number | null;
  score: number;
  rank: number;
  reasons: string[];
  premiumAtSuggest: number | null;
  premiumSl: number | null;
  premiumTarget: number | null;
  suggestedAt: string;
  lastSeenAt: string;
  timesSeen: number;
  maxUpPct: number | null;
  maxDownPct: number | null;
  closePct: number | null;
  outcomeAt: string | null;
}
interface DayGroup {
  date: string;
  suggestions: StoredRow[];
  reviewed: number;
  hits: number;
}
interface HistoryResp {
  success: boolean;
  days: number;
  days_returned: number;
  board: DayGroup[];
  error?: string;
}

const DAY_OPTIONS = [7, 30, 90] as const;

const pctCls = (v: number | null) =>
  v == null ? 'text-muted-foreground' : v >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
const fmtPct = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

/** ISO instant → IST clock time (HH:mm). */
const fmtIST = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';

/** YYYY-MM-DD → "Wed, 09 Jul 2026" for the day header. */
const fmtDate = (d: string) => {
  const dt = new Date(`${d}T00:00:00+05:30`);
  return Number.isNaN(dt.getTime())
    ? d
    : dt.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
};

const tvUrl = (symbol: string) => `https://in.tradingview.com/chart/?symbol=NSE%3A${encodeURIComponent(symbol)}&interval=5`;

function SymbolLink({ symbol }: { symbol: string }) {
  return (
    <a
      href={tvUrl(symbol)}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${symbol} chart on TradingView`}
      className="group inline-flex items-center gap-0.5 hover:text-primary hover:underline"
    >
      {symbol}
      <ExternalLink className="h-2.5 w-2.5 opacity-0 transition-opacity group-hover:opacity-70" />
    </a>
  );
}

/** Favorable / adverse move in the SUGGESTED direction (CE up, PE down). */
function outcomeCells(s: StoredRow): { fav: number | null; adv: number | null; close: number | null; pending: boolean } {
  if (s.outcomeAt == null) return { fav: null, adv: null, close: null, pending: true };
  const fav = s.optionType === 'PE' ? -(s.maxDownPct ?? 0) : (s.maxUpPct ?? 0);
  const adv = s.optionType === 'PE' ? (s.maxUpPct ?? 0) : -(s.maxDownPct ?? 0);
  const close = (s.closePct ?? 0) * (s.optionType === 'PE' ? -1 : 1);
  return { fav, adv, close, pending: false };
}

function DaySection({ day }: { day: DayGroup }) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleRow = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const hitRate = day.reviewed > 0 ? Math.round((day.hits / day.reviewed) * 100) : null;

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <span className="text-[12px] font-semibold">{fmtDate(day.date)}</span>
        <span className="text-[10px] text-muted-foreground">
          {day.suggestions.length} {day.suggestions.length === 1 ? 'trade' : 'trades'}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {day.reviewed > 0 ? (
            <>
              reviewed {day.reviewed}/{day.suggestions.length} ·{' '}
              <span className={hitRate != null && hitRate >= 50 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
                {day.hits} hit{day.hits === 1 ? '' : 's'} {hitRate != null && `(${hitRate}%)`}
              </span>
            </>
          ) : (
            'not yet reviewed'
          )}
        </span>
      </button>

      {open && (
        <div className="overflow-x-auto border-t border-border/60">
          <table className="w-full text-[10px]">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="px-1.5 py-1 font-medium">Start</th>
                <th className="px-1.5 py-1 font-medium">Last seen</th>
                <th className="px-1.5 py-1 font-medium">Contract</th>
                <th className="px-1.5 py-1 font-medium">Sector</th>
                <th className="px-1.5 py-1 text-right font-medium">Spot@call</th>
                <th className="px-1.5 py-1 text-right font-medium">SL / Target</th>
                <th className="px-1.5 py-1 text-right font-medium">Premium</th>
                <th className="px-1.5 py-1 text-right font-medium">R / Score</th>
                <th className="px-1.5 py-1 text-right font-medium">Max fav / adv</th>
                <th className="px-1.5 py-1 text-right font-medium">Close</th>
                <th className="px-1.5 py-1 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {day.suggestions.map((s) => {
                const key = `${s.symbol}-${s.optionType}-${s.strike}`;
                const isOpen = expanded.has(key);
                const o = outcomeCells(s);
                const ce = s.optionType === 'CE';
                return (
                  <Fragment key={key}>
                    <tr className="border-b border-border/30 align-top">
                      <td className="px-1.5 py-0.5 tabular-nums text-muted-foreground">{fmtIST(s.suggestedAt)}</td>
                      <td className="px-1.5 py-0.5 tabular-nums text-muted-foreground">
                        {fmtIST(s.lastSeenAt)} <span className="opacity-60">×{s.timesSeen}</span>
                      </td>
                      <td className="px-1.5 py-0.5 font-mono font-medium">
                        <SymbolLink symbol={s.symbol} />{' '}
                        <span
                          className={`rounded px-1 py-0.5 text-[9px] font-bold ${
                            ce
                              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                              : 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
                          }`}
                        >
                          {s.strike} {s.optionType}
                        </span>
                        <span className="ml-1 text-muted-foreground">lot {s.lotSize}</span>
                      </td>
                      <td className="px-1.5 py-0.5 text-muted-foreground">{s.sector || '—'}</td>
                      <td className="px-1.5 py-0.5 text-right tabular-nums">{s.spotAtSuggest || '—'}</td>
                      <td className="px-1.5 py-0.5 text-right tabular-nums">
                        {s.slSpot ?? '—'} / {s.targetSpot ?? '—'}
                      </td>
                      <td className="px-1.5 py-0.5 text-right tabular-nums">
                        {s.premiumAtSuggest != null ? `₹${s.premiumAtSuggest}` : '—'}
                      </td>
                      <td className="px-1.5 py-0.5 text-right tabular-nums">
                        {s.rFactor.toFixed(2)} / {s.score.toFixed(3)}
                      </td>
                      <td className="px-1.5 py-0.5 text-right tabular-nums">
                        {o.pending ? (
                          <span className="text-muted-foreground">pending</span>
                        ) : (
                          <>
                            <span className={pctCls(o.fav)}>{fmtPct(o.fav)}</span> /{' '}
                            <span className={pctCls(o.adv == null ? null : -o.adv)}>{fmtPct(o.adv)}</span>
                          </>
                        )}
                      </td>
                      <td className={`px-1.5 py-0.5 text-right tabular-nums ${o.pending ? 'text-muted-foreground' : pctCls(o.close)}`}>
                        {o.pending ? '—' : fmtPct(o.close)}
                      </td>
                      <td className="px-1.5 py-0.5">
                        {s.reasons.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => toggleRow(key)}
                            className="text-muted-foreground hover:text-foreground"
                            title={isOpen ? 'Hide reasons' : `Show ${s.reasons.length} reasons`}
                          >
                            {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                          </button>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-border/30 bg-muted/30">
                        <td colSpan={11} className="px-3 py-1.5">
                          <ul className="space-y-0.5 text-[10px] leading-relaxed text-muted-foreground">
                            {s.reasons.map((r) => (
                              <li key={r}>· {r}</li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function TradeLogPage() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<HistoryResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/trade-suggest?view=history&days=${days}`);
      const j = (await res.json()) as HistoryResp;
      if (j.success) {
        setData(j);
        setError(null);
      } else {
        setError(j.error ?? 'Failed to load history');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    let stopped = false;
    const t = setTimeout(() => {
      if (!stopped) void refresh();
    }, 0);
    return () => {
      stopped = true;
      clearTimeout(t);
    };
  }, [refresh]);

  const totalTrades = (data?.board ?? []).reduce((n, d) => n + d.suggestions.length, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-sm font-semibold">
          <NotebookText className="h-4 w-4 text-primary" />
          Trade Log — daywise history
        </h1>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-lg border border-border p-0.5">
            {DAY_OPTIONS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                  days === d ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Refresh"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <p className="text-[10.5px] text-muted-foreground">
        Every pick the <code className="rounded bg-muted px-1">/trade-suggest</code> scan persisted, grouped by trading day
        (newest first). <b>Start</b> = first sighting, <b>Last seen</b> = last scan it re-appeared in (×N = times seen).
        Outcomes (max favorable / adverse move, close) fill after the same-day 15:30 review. Signal analysis only — no order
        is ever placed.
      </p>

      {error && <div className="rounded border border-red-300 px-3 py-2 text-[11px] text-red-600">{error}</div>}
      {loading && !data && (
        <div className="flex items-center gap-2 px-3 py-6 text-[11px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" /> Loading…
        </div>
      )}

      {data && (
        <>
          <div className="text-[10px] text-muted-foreground">
            {totalTrades} {totalTrades === 1 ? 'trade' : 'trades'} across {data.board.length}{' '}
            {data.board.length === 1 ? 'day' : 'days'} (last {data.days}d)
          </div>
          {data.board.length === 0 ? (
            <div className="rounded-lg border border-border bg-card px-3 py-6 text-center text-[11px] text-muted-foreground">
              No suggestions persisted in this window yet. Run <code className="rounded bg-muted px-1">/trade-suggest</code>{' '}
              during the 09:40–11:00 window and picks will land here.
            </div>
          ) : (
            <div className="space-y-2">
              {data.board.map((day) => (
                <DaySection key={day.date} day={day} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
