'use client';

import { classifyFuturesOI, type FuturesQuadrant } from '@/lib/signals/oi-direction';
import type { TradeContextData } from '../_lib/types';
import { fmtOI, fmtTurnover } from './daily-bar-chart';

function pct(prev: number, cur: number): number | null {
  return prev > 0 ? ((cur - prev) / prev) * 100 : null;
}

const QUADRANT_ABBR: Record<FuturesQuadrant, string> = {
  'long-buildup': 'LB',
  'short-buildup': 'SB',
  'short-covering': 'SC',
  'long-unwinding': 'LU',
  flat: '—',
};

/** Per-day futures price+OI quadrant badge. Direction needs price WITH OI. */
function DirBadge({ priceDelta, oiDelta }: { priceDelta: number | null; oiDelta: number | null }) {
  const c = classifyFuturesOI({ priceChangePct: priceDelta, oiChangePct: oiDelta });
  if (c.quadrant === 'flat') return <span className="text-muted-foreground/50">—</span>;
  const cls =
    c.bias === 'bullish'
      ? 'text-emerald-600 dark:text-emerald-400'
      : c.bias === 'bearish'
        ? 'text-red-600 dark:text-red-400'
        : 'text-muted-foreground';
  return (
    <span className={`${cls} cursor-help`} title={c.label}>
      {QUADRANT_ABBR[c.quadrant]}
    </span>
  );
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function weekday(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

function Delta({ v }: { v: number | null }) {
  if (v == null) return <span className="text-muted-foreground/50">—</span>;
  const cls = v >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
  return (
    <span className={cls}>
      {v >= 0 ? '▲' : '▼'}
      {Math.abs(v).toFixed(0)}%
    </span>
  );
}

/** Full per-day breakdown of the downloaded context, newest first, trade day highlighted. */
export function DailyContextTable({ ctx }: { ctx: TradeContextData }) {
  const days = ctx.days; // oldest first
  const rows = days
    .map((d, i) => ({
      ...d,
      optOIDelta: i > 0 ? pct(days[i - 1].optOITotal, d.optOITotal) : null,
      futOIDelta: i > 0 ? pct(days[i - 1].futOI, d.futOI) : null,
      priceDelta: i > 0 ? pct(days[i - 1].eqClose, d.eqClose) : null,
    }))
    .reverse(); // newest first

  return (
    <div className="rounded-lg bg-card border border-border overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-muted/50">
        <h4 className="text-[11px] font-bold text-muted-foreground uppercase tracking-wide">Daily Detail</h4>
        <span className="text-[10px] text-muted-foreground">
          {days.length} sessions · newest first · option OI = CE+PE total
        </span>
      </div>
      <div className="max-h-80 overflow-y-auto">
        <table className="w-full text-[11px] font-mono">
          <thead className="sticky top-0 bg-muted/40 text-[9px] text-muted-foreground uppercase">
            <tr>
              <th className="text-left font-medium px-3 py-1.5">Date</th>
              <th className="text-right font-medium px-2 py-1.5">Opt OI</th>
              <th className="text-right font-medium px-2 py-1.5">Δ</th>
              <th className="text-right font-medium px-2 py-1.5">Fut OI</th>
              <th className="text-right font-medium px-2 py-1.5">Δ</th>
              <th className="text-center font-medium px-2 py-1.5" title="Futures price+OI quadrant: LB long buildup · SB short buildup · SC short covering · LU long unwinding">
                Dir
              </th>
              <th className="text-right font-medium px-2 py-1.5">Opt Vol</th>
              <th className="text-right font-medium px-2 py-1.5">Fut Turn</th>
              <th className="text-right font-medium px-3 py-1.5">Eq Turn</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.date}
                className={`border-b border-border/30 ${
                  r.isTradeDate ? 'bg-amber-100 dark:bg-amber-500/10 font-semibold' : 'hover:bg-accent/30'
                }`}
              >
                <td className="text-left px-3 py-1 text-muted-foreground whitespace-nowrap">
                  {r.date} <span className="text-muted-foreground/50">{weekday(r.date)}</span>
                  {r.isTradeDate && <span className="ml-1 text-amber-600 dark:text-amber-400">◀ trade</span>}
                </td>
                <td className="text-right px-2 py-1 text-foreground">{r.optOITotal > 0 ? fmtOI(r.optOITotal) : '—'}</td>
                <td className="text-right px-2 py-1">
                  <Delta v={r.optOIDelta} />
                </td>
                <td className="text-right px-2 py-1 text-foreground">{r.futOI > 0 ? fmtOI(r.futOI) : '—'}</td>
                <td className="text-right px-2 py-1">
                  <Delta v={r.futOIDelta} />
                </td>
                <td className="text-center px-2 py-1 font-semibold">
                  <DirBadge priceDelta={r.priceDelta} oiDelta={r.futOIDelta} />
                </td>
                <td className="text-right px-2 py-1 text-muted-foreground">{r.optVolumeTotal > 0 ? fmtOI(r.optVolumeTotal) : '—'}</td>
                <td className="text-right px-2 py-1 text-muted-foreground">
                  {r.futTurnover > 0 ? fmtTurnover(r.futTurnover) : '—'}
                </td>
                <td className="text-right px-3 py-1 text-muted-foreground">
                  {r.eqTurnover > 0 ? fmtTurnover(r.eqTurnover) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
