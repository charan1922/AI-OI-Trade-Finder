'use client';

import { ChevronDown, ChevronRight, ExternalLink, Loader2, NotebookText, RefreshCw } from 'lucide-react';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { CAPITAL_BUDGET, MAX_LOSS_PER_LOT_RUPEES } from '@/lib/trade-suggest/config';

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
  /** Honest path-dependent grade (grade.ts) — used directly so this page agrees
   *  with the backend stats. Null on legacy rows (old max/min fallback below). */
  spotOutcome: 'target' | 'stop' | 'timeout' | 'entry-ambiguous' | 'incomplete' | null;
  spotOutcomeR: number | null;
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

/** Position sizing for the log: ≥1 lot, capped at 2 (user's ₹50–60k account). */
const MAX_LOTS = 2;

const pctCls = (v: number | null) =>
  v == null ? 'text-muted-foreground' : v >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
const fmtPct = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
/** Signed ₹ (P/L). */
const fmtSignedRs = (v: number | null) =>
  v == null ? '—' : `${v >= 0 ? '+' : '−'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
/** Unsigned ₹ (cost). */
const fmtRs = (v: number | null) => (v == null ? '—' : `₹${Math.round(v).toLocaleString('en-IN')}`);

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

type Basis = 'TGT' | 'SL' | 'BOTH' | 'OPEN' | 'PENDING' | 'UNRESOLVED';

/** Lots to trade: capital ÷ per-lot cost, floored, ≥1, capped at MAX_LOTS. */
function lotsFor(s: StoredRow): number {
  const perLot = (s.premiumAtSuggest ?? 0) * s.lotSize;
  if (perLot <= 0) return 1;
  return Math.min(MAX_LOTS, Math.max(1, Math.floor(CAPITAL_BUDGET / perLot)));
}

/**
 * Plan outcome for the Trade Log row. Prefers the persisted HONEST path-dependent
 * grade (grade.ts / spotOutcome) so this page agrees with the backend stats
 * (PR#3 review): target/stop reflect which was reached FIRST; timeout = neither;
 * entry-ambiguous / incomplete = 5-min blind spots (no ₹ claimed). Only legacy
 * rows (graded before grade.ts, no spotOutcome) fall back to the old full-day
 * max/min calc — which is path-INDEPENDENT and can disagree with reality.
 */
function planOutcome(s: StoredRow): { basis: Basis; plPerShare: number | null } {
  if (s.outcomeAt == null) return { basis: 'PENDING', plPerShare: null };
  const tgtPL = s.premiumTarget != null && s.premiumAtSuggest != null ? s.premiumTarget - s.premiumAtSuggest : null;
  // Cap the modeled loss at the ₹ per-lot budget — a losing trade that hit the old
  // 40% stop necessarily passed through this tighter level first, so recomputing
  // historical rows at the cap is honest (and new rows are already stored capped).
  const capPerShare = s.lotSize > 0 ? MAX_LOSS_PER_LOT_RUPEES / s.lotSize : null;
  const rawSlPL = s.premiumSl != null && s.premiumAtSuggest != null ? s.premiumSl - s.premiumAtSuggest : null;
  const slPL = rawSlPL == null ? null : capPerShare == null ? rawSlPL : Math.max(rawSlPL, -capPerShare);

  if (s.spotOutcome != null) {
    switch (s.spotOutcome) {
      case 'target':
        return { basis: 'TGT', plPerShare: tgtPL };
      case 'stop':
        return { basis: 'SL', plPerShare: slPL };
      case 'timeout':
        return { basis: 'OPEN', plPerShare: null }; // no clean exit at a level → no ₹ claimed
      default:
        return { basis: 'UNRESOLVED', plPerShare: null }; // entry-ambiguous / incomplete
    }
  }

  // Legacy rows only: old path-INDEPENDENT full-day max/min.
  const ce = s.optionType === 'CE';
  const hi = s.maxUpPct == null ? null : s.spotAtSuggest * (1 + s.maxUpPct / 100);
  const lo = s.maxDownPct == null ? null : s.spotAtSuggest * (1 + s.maxDownPct / 100);
  const targetHit = s.targetSpot != null && (ce ? hi != null && hi >= s.targetSpot : lo != null && lo <= s.targetSpot);
  const slHit = s.slSpot != null && (ce ? lo != null && lo <= s.slSpot : hi != null && hi >= s.slSpot);
  if (targetHit && slHit) return { basis: 'BOTH', plPerShare: slPL };
  if (targetHit) return { basis: 'TGT', plPerShare: tgtPL };
  if (slHit) return { basis: 'SL', plPerShare: slPL };
  return { basis: 'OPEN', plPerShare: null };
}

/** Full P/L view for a row: lots, capital deployed, realized ₹ + basis. */
function plView(s: StoredRow): { lots: number; cost: number | null; rupees: number | null; basis: Basis } {
  const lots = lotsFor(s);
  const cost = s.premiumAtSuggest != null ? s.premiumAtSuggest * s.lotSize * lots : null;
  const { basis, plPerShare } = planOutcome(s);
  const rupees = plPerShare == null ? null : plPerShare * s.lotSize * lots;
  return { lots, cost, rupees, basis };
}

const BASIS_BADGE: Record<Basis, { label: string; cls: string }> = {
  TGT: { label: 'target', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' },
  SL: { label: 'stop', cls: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300' },
  BOTH: { label: '⚠ stop*', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300' },
  OPEN: { label: 'open', cls: 'bg-muted text-muted-foreground' },
  PENDING: { label: 'pending', cls: 'bg-muted text-muted-foreground' },
  UNRESOLVED: { label: '~ n/a', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300' },
};

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

  // Day total realized P/L (resolved rows only).
  const dayPL = day.suggestions.reduce((sum, s) => {
    const { rupees } = plView(s);
    return rupees == null ? sum : sum + rupees;
  }, 0);
  const hasRealized = day.suggestions.some((s) => plView(s).rupees != null);

  return (
    <div className="rounded-lg border border-border bg-card">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <span className="text-[12px] font-semibold">{fmtDate(day.date)}</span>
        <span className="text-[10px] text-muted-foreground">
          {day.suggestions.length} {day.suggestions.length === 1 ? 'trade' : 'trades'}
        </span>
        <span className="ml-auto flex items-center gap-3 text-[10px] text-muted-foreground">
          <span>reviewed {day.reviewed}/{day.suggestions.length}</span>
          {hasRealized && (
            <span className="font-semibold">
              Modeled day P/L <span className={pctCls(dayPL)}>{fmtSignedRs(dayPL)}</span>
            </span>
          )}
        </span>
      </button>

      {open && (
        <div className="overflow-x-auto border-t border-border/60">
          <table className="w-full text-[10.5px]">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b border-border/50">
                <th className="px-2 py-1.5 font-medium">Entry</th>
                <th className="px-2 py-1.5 font-medium">Outcome</th>
                <th className="px-2 py-1.5 font-medium">Option</th>
                <th className="px-2 py-1.5 font-medium">Strike</th>
                <th className="px-2 py-1.5 text-right font-medium">Spot@call</th>
                <th className="px-2 py-1.5 text-right font-medium">SL / Target</th>
                <th className="px-2 py-1.5 text-right font-medium">Lots</th>
                <th className="px-2 py-1.5 text-right font-medium">Cost</th>
                <th className="px-2 py-1.5 text-right font-medium">Modeled P/L</th>
                <th className="px-2 py-1.5 text-right font-medium">Move</th>
                <th className="px-2 py-1.5 text-right font-medium">R / Score</th>
                <th className="px-2 py-1.5 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {day.suggestions.map((s) => {
                const key = `${s.symbol}-${s.optionType}-${s.strike}`;
                const isOpen = expanded.has(key);
                const ce = s.optionType === 'CE';
                const { lots, cost, rupees, basis } = plView(s);
                const badge = BASIS_BADGE[basis];
                // Real tracked spot move at close, in the suggested direction.
                const spotFav = s.closePct == null ? null : s.closePct * (ce ? 1 : -1);
                return (
                  <Fragment key={key}>
                    <tr className="border-b border-border/30 align-top">
                      <td className="px-2 py-1 tabular-nums">{fmtIST(s.suggestedAt)}</td>
                      <td className="px-2 py-1 tabular-nums">
                        <span className={`rounded px-1 py-0.5 text-[9px] font-semibold ${badge.cls}`}>{badge.label}</span>
                        {s.outcomeAt && (
                          <span className="ml-1 text-muted-foreground" title="EOD grade time — not the exact moment the level was hit">
                            {fmtIST(s.outcomeAt)}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1 font-mono font-medium">
                        <SymbolLink symbol={s.symbol} />
                      </td>
                      <td className="px-2 py-1">
                        <span
                          className={`rounded px-1 py-0.5 font-mono text-[10px] font-bold ${
                            ce
                              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                              : 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
                          }`}
                        >
                          {s.strike} {s.optionType}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">{s.spotAtSuggest || '—'}</td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        <span className="text-red-600 dark:text-red-400">{s.slSpot ?? '—'}</span>
                        <span className="text-muted-foreground"> / </span>
                        <span className="text-emerald-600 dark:text-emerald-400">{s.targetSpot ?? '—'}</span>
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {lots}
                        <span className="ml-0.5 text-[9px] text-muted-foreground">×{s.lotSize}</span>
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {fmtRs(cost)}
                        {s.premiumAtSuggest != null && (
                          <div className="text-[9px] text-muted-foreground">@₹{s.premiumAtSuggest}</div>
                        )}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {rupees != null ? (
                          <>
                            <span className={`font-semibold ${pctCls(rupees)}`}>{fmtSignedRs(rupees)}</span>
                            {cost != null && cost > 0 && (
                              <div className={`text-[9px] ${pctCls(rupees)}`}>{fmtPct((rupees / cost) * 100)}</div>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                        {s.spotOutcomeR != null && (
                          <div
                            className={`text-[9px] ${pctCls(s.spotOutcomeR)}`}
                            title="Realised spot-R vs the plan's risk (honest path-dependent grade)"
                          >
                            {s.spotOutcomeR >= 0 ? '+' : ''}
                            {s.spotOutcomeR.toFixed(2)}R
                          </div>
                        )}
                      </td>
                      <td
                        className={`px-2 py-1 text-right tabular-nums ${spotFav == null ? 'text-muted-foreground' : pctCls(spotFav)}`}
                        title="Best spot move in the suggested direction, at close"
                      >
                        {spotFav == null ? '—' : fmtPct(spotFav)}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">
                        {s.rFactor.toFixed(2)}
                        <span className="text-[9px]"> / {s.score.toFixed(2)}</span>
                      </td>
                      <td className="px-2 py-1">
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
                        <td colSpan={12} className="px-3 py-1.5">
                          <div className="mb-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-muted-foreground">
                            <span>
                              Entry prem <b className="text-foreground">{s.premiumAtSuggest != null ? `₹${s.premiumAtSuggest}` : '—'}</b>
                            </span>
                            <span>
                              SL prem <b className="text-foreground">{s.premiumSl != null ? `₹${s.premiumSl}` : '—'}</b>
                            </span>
                            <span>
                              Target prem <b className="text-foreground">{s.premiumTarget != null ? `₹${s.premiumTarget}` : '—'}</b>
                            </span>
                            <span>
                              OI level <b className="text-foreground">{s.oiLevel ? `${s.oiLevel.toFixed(2)}×` : '—'}</b>
                            </span>
                            <span>{s.sector || '—'}</span>
                            <span>
                              last seen {fmtIST(s.lastSeenAt)} · ×{s.timesSeen}
                            </span>
                          </div>
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
    <div className="mx-auto max-w-5xl space-y-3 p-3">
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

      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
        Every pick the <code className="rounded bg-muted px-1">/trade-suggest</code> scan persisted, grouped by trading day
        (newest first). <b>Entry</b> = first call time · <b>Outcome</b> = which level the spot hit (target / stop / open); the
        time shown is the EOD grade time, not the exact hit time. <b>Lots</b> sized to ₹{(CAPITAL_BUDGET / 1000).toFixed(0)}k
        capital, capped at {MAX_LOTS}. <b>Modeled P/L</b> is the plan outcome (not real broker fills) — target hit →
        +₹5,000/lot; stop hit → loss capped at{' '}
        <b>₹{MAX_LOSS_PER_LOT_RUPEES.toLocaleString('en-IN')}/lot</b> (the spot SL sits at the structure level — last
        candle / support — this only bounds the ₹ if it&apos;s wide); <b>open</b> = neither touched (no ₹ claimed).{' '}
        <b>Move</b> = best spot move in the suggested direction at close. <b>⚠ stop*</b> = both target and stop were touched
        intraday — counted as the stop, since a disciplined exit takes the stop first. Signal analysis only; no order is placed.
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
