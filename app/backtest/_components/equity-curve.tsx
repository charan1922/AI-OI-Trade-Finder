'use client';

import type { BtTradeRow } from '../_lib/bt-types';
import { inr } from '../_lib/format';

/**
 * Running net-P&L across the evaluated trades (chronological) — the "staircase".
 * Plain SVG polyline (no chart dependency); x = trade order.
 */
export function EquityCurve({ results }: { results: BtTradeRow[] }) {
  const evaluated = results.filter((r) => r.status === 'ok' && r.netPnl != null);

  const pts = evaluated.map((r, i) => ({
    i,
    cum: evaluated.slice(0, i + 1).reduce((sum, x) => sum + (x.netPnl ?? 0), 0),
    date: r.date,
  }));

  if (pts.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
        No evaluated trades to plot yet.
      </div>
    );
  }

  const W = 800;
  const H = 220;
  const padX = 8;
  const padY = 16;
  const ys = pts.map((p) => p.cum);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(0, ...ys);
  const spanY = maxY - minY || 1;
  const spanX = pts.length - 1 || 1;
  const xAt = (i: number) => padX + (i / spanX) * (W - 2 * padX);
  const yAt = (v: number) => padY + (1 - (v - minY) / spanY) * (H - 2 * padY);
  const zeroY = yAt(0);
  const path = pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${xAt(p.i).toFixed(1)} ${yAt(p.cum).toFixed(1)}`).join(' ');
  const finalCum = ys[ys.length - 1];
  const stroke = finalCum >= 0 ? '#22c55e' : '#ef4444';

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-3 text-xs font-bold uppercase text-muted-foreground">
        Equity Curve <span className="text-[10px] normal-case text-muted-foreground/70">running net P&L across trades</span>
      </h3>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height: H }}>
        <line x1={padX} x2={W - padX} y1={zeroY} y2={zeroY} stroke="rgba(148,163,184,0.35)" strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        <path d={path} fill="none" stroke={stroke} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>{pts[0].date}</span>
        <span className={finalCum >= 0 ? 'text-green-600 dark:text-green-500' : 'text-red-600 dark:text-red-500'}>
          Final: {inr(finalCum)}
        </span>
        <span>{pts[pts.length - 1].date}</span>
      </div>
    </div>
  );
}
