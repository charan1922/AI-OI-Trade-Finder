'use client';

import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { setupScore, type SetupVerdict } from '../_lib/setup-score';
import type { LiveUrgencyRow } from '../_lib/types';

const num = (n: number | null, d = 2): string => (n == null ? '—' : n.toFixed(d));

/** Compact Indian-style magnitude for OI / turnover (K / L / Cr). */
function fmtCompact(n: number | null): string {
  if (n == null || n <= 0) return '—';
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

/** Spread %: tight = liquid/cheap to trade (green); wide = illiquid (red). */
function spreadCls(p: number | null): string {
  if (p == null) return 'text-muted-foreground/50';
  if (p < 0.1) return 'text-emerald-600 dark:text-emerald-400';
  if (p < 0.3) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

/**
 * Intraday OI-build cell — the session's OI change so far, colored by urgency
 * (rate of build). Distinct from the static OI level. "—" until enough intraday
 * snapshots have accumulated today (never fabricated).
 */
function OiBuild({ r }: { r: LiveUrgencyRow }) {
  if (r.oiUrgency == null || r.sessionOiChangePct == null) {
    return <span className="text-muted-foreground/50">—</span>;
  }
  const up = r.sessionOiChangePct >= 0;
  const cls =
    r.oiUrgency >= 5
      ? 'font-semibold text-emerald-600 dark:text-emerald-400'
      : r.oiUrgency >= 3
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-muted-foreground';
  return (
    <span
      className={`tabular-nums ${cls}`}
      title={`urgency ${r.oiUrgency.toFixed(1)}/10 · velocity ${r.oiVelocity?.toFixed(2) ?? '—'}‰/min · accel ${r.oiAccel?.toFixed(2) ?? '—'} — rate of fresh OI build this session`}
    >
      {up ? '+' : ''}
      {r.sessionOiChangePct.toFixed(1)}% {up ? '▲' : '▼'}
    </span>
  );
}

/** Order-book imbalance bar: bid-heavy (green) vs ask-heavy (red). */
function Imbalance({ v }: { v: number | null }) {
  if (v == null) return <span className="text-muted-foreground/50">—</span>;
  const bidPct = Math.round(v * 100);
  const cls = v > 0.55 ? 'bg-emerald-500' : v < 0.45 ? 'bg-red-500' : 'bg-slate-400';
  const label = v > 0.55 ? 'bid-heavy' : v < 0.45 ? 'ask-heavy' : 'balanced';
  return (
    <div className="flex items-center justify-end gap-1.5" title={`${bidPct}% resting bid — ${label}`}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${cls}`} style={{ width: `${bidPct}%` }} />
      </div>
      <span className="w-9 text-right tabular-nums text-muted-foreground">{bidPct}%</span>
    </div>
  );
}

const SETUP_STYLE: Record<SetupVerdict['level'], { cls: string; label: string }> = {
  strong: { cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300', label: 'Strong' },
  watch: { cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300', label: 'Watch' },
  quiet: { cls: 'bg-slate-500/10 text-slate-600 dark:text-slate-400', label: 'Quiet' },
  illiquid: { cls: 'bg-muted text-muted-foreground', label: 'Illiquid' },
};

function SetupBadge({ v }: { v: SetupVerdict }) {
  const s = SETUP_STYLE[v.level];
  const arrow = v.bias === 'bullish' ? ' ↑' : v.bias === 'bearish' ? ' ↓' : '';
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${s.cls}`}
      title={v.reasons.join(' · ')}
    >
      {s.label}
      {arrow}
    </span>
  );
}

type SortKey =
  | 'setup'
  | 'symbol'
  | 'ltp'
  | 'changePctOpen'
  | 'spreadPct'
  | 'imbalance'
  | 'futOi'
  | 'oiLevel'
  | 'oiUrgency'
  | 'turnover';
type Row = LiveUrgencyRow & { verdict: SetupVerdict };

/** Sortable header cell — top-level so React doesn't remount it every render. */
function Th({
  label,
  col,
  align = 'right',
  title,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  col: SortKey;
  align?: 'left' | 'right' | 'center';
  title?: string;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
}) {
  const active = sortKey === col;
  const justify = align === 'left' ? 'justify-start' : align === 'center' ? 'justify-center' : 'justify-end';
  const textAlign = align === 'left' ? 'text-left' : align === 'center' ? 'text-center' : 'text-right';
  return (
    <th className={`px-2 py-2 font-semibold ${textAlign}`} title={title}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={`flex w-full items-center gap-1 ${justify} hover:text-foreground ${active ? 'text-foreground' : ''}`}
      >
        <span>{label}</span>
        {active ? (
          sortDir === 'asc' ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ChevronsUpDown className="h-3 w-3 opacity-30" />
        )}
      </button>
    </th>
  );
}

const sortValue = (r: Row, key: SortKey): number | string => {
  if (key === 'setup') return r.verdict.rank;
  if (key === 'symbol') return r.symbol;
  return (r[key] as number | null) ?? Number.NEGATIVE_INFINITY;
};

export function UrgencyTable({ rows, sectors }: { rows: LiveUrgencyRow[]; sectors?: Record<string, string> }) {
  const [sortKey, setSortKey] = useState<SortKey>('setup');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'symbol' || key === 'spreadPct' ? 'asc' : 'desc');
    }
  };

  const sorted = useMemo<Row[]>(() => {
    const withVerdict: Row[] = rows.map((r) => ({ ...r, verdict: setupScore(r) }));
    const dir = sortDir === 'asc' ? 1 : -1;
    return withVerdict.sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      let cmp = typeof av === 'string' || typeof bv === 'string' ? String(av).localeCompare(String(bv)) : av - bv;
      // Tie-break: stronger setup first, then tighter spread.
      if (cmp === 0) cmp = b.verdict.rank - a.verdict.rank;
      if (cmp === 0) cmp = (a.spreadPct ?? Infinity) - (b.spreadPct ?? Infinity);
      return cmp * dir;
    });
  }, [rows, sortKey, sortDir]);

  const th = { sortKey, sortDir, onSort };

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full text-xs">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <Th label="Symbol" col="symbol" align="left" {...th} />
            <Th label="Setup" col="setup" align="left" title="Combined verdict — see 'How to read'. Default sort." {...th} />
            <Th label="LTP" col="ltp" align="right" title="Last price" {...th} />
            <Th label="Chg%" col="changePctOpen" align="right" title="Change since the day's open" {...th} />
            <Th label="Spread%" col="spreadPct" align="right" title="(ask − bid) ÷ mid. Tight = liquid / cheap to execute." {...th} />
            <Th label="Bid/Ask" col="imbalance" align="right" title="Resting bid ÷ (bid+ask) — order-flow pressure." {...th} />
            <Th label="Fut OI" col="futOi" align="right" title="Live futures open interest" {...th} />
            <Th label="OI Lvl" col="oiLevel" align="right" title="Live futures OI ÷ 20-session average (conviction)" {...th} />
            <Th
              label="OI Build"
              col="oiUrgency"
              align="right"
              title="Intraday OI build this session (% since first snapshot), colored by urgency = rate of fresh OI piling on now. Distinct from the static OI level."
              {...th}
            />
            <Th label="Turnover" col="turnover" align="right" title="Live futures turnover ≈ VWAP × volume (quality)" {...th} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.symbol} className="border-t border-border hover:bg-muted/30">
              <td className="px-3 py-2 font-medium text-foreground">
                {r.symbol}
                {sectors?.[r.symbol] && (
                  <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[9px] font-normal text-muted-foreground">
                    {sectors[r.symbol]}
                  </span>
                )}
              </td>
              <td className="px-2 py-2">
                <div className="flex items-center gap-1">
                  <SetupBadge v={r.verdict} />
                  {r.verdict.extended && (
                    <span
                      className="inline-block rounded bg-orange-500/15 px-1 py-0.5 text-[9px] font-semibold text-orange-700 dark:text-orange-300"
                      title="Already moved a lot today — the move is behind you. Chasing it is risky; wait for a pullback."
                    >
                      moved
                    </span>
                  )}
                </div>
              </td>
              <td className="px-2 py-2 text-right tabular-nums">{r.ltp != null ? `₹${num(r.ltp)}` : '—'}</td>
              <td
                className={`px-2 py-2 text-right tabular-nums ${
                  r.changePctOpen == null
                    ? 'text-muted-foreground/50'
                    : r.changePctOpen >= 0
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-red-600 dark:text-red-400'
                }`}
              >
                {r.changePctOpen != null ? `${r.changePctOpen >= 0 ? '+' : ''}${num(r.changePctOpen)}%` : '—'}
              </td>
              <td className={`px-2 py-2 text-right font-medium tabular-nums ${spreadCls(r.spreadPct)}`}>
                {r.spreadPct != null ? `${num(r.spreadPct, 3)}%` : '—'}
              </td>
              <td className="px-2 py-2">
                <Imbalance v={r.imbalance} />
              </td>
              <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{fmtCompact(r.futOi)}</td>
              <td
                className={`px-2 py-2 text-right tabular-nums ${
                  (r.oiLevel ?? 0) >= 1.25 ? 'font-semibold text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
                }`}
              >
                {r.oiLevel != null ? `${num(r.oiLevel)}×` : '—'}
              </td>
              <td className="px-2 py-2 text-right">
                <OiBuild r={r} />
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{fmtCompact(r.turnover)}</td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">
                No data.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
