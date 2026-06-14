'use client';

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export interface BarDatum {
  date: string;
  value: number;
  isTradeDate?: boolean;
}

interface DailyBarChartProps {
  title: string;
  /** Hover tooltip explaining how the metric is computed (data provenance). */
  hint?: string;
  /** 'diff' colors each bar green/red vs the previous day (OI buildup/decline); 'solid' uses one accent. */
  mode?: 'diff' | 'solid';
  data: BarDatum[];
  format: (v: number) => string;
  /** CSS color (rgba/hex) for solid mode. */
  accent?: string;
  height?: number;
}

const UP = '#10b981'; // emerald-500
const DOWN = '#f43f5e'; // rose-500
const TRADE = '#f59e0b'; // amber-500
const AXIS = '#94a3b8'; // slate-400 — readable on light + dark
const NO_PREV = '#94a3b8'; // first bar in diff mode — no previous day to compare against

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function mmdd(date: string): string {
  const [, m, d] = date.split('-');
  return `${m}/${d}`;
}
function fullLabel(date: string): string {
  const [, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m}`;
}

/** Indian-style compact number (K / L / Cr). */
export function fmtOI(v: number): string {
  if (v >= 1e7) return `${(v / 1e7).toFixed(2)}Cr`;
  if (v >= 1e5) return `${(v / 1e5).toFixed(2)}L`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return `${Math.round(v)}`;
}
export function fmtTurnover(v: number): string {
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(1)}Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)}L`;
  if (v >= 1e3) return `₹${(v / 1e3).toFixed(1)}K`;
  return `₹${Math.round(v)}`;
}

interface Row {
  date: string;
  mmdd: string;
  full: string;
  value: number;
  fill: string;
  isTradeDate: boolean;
}

/**
 * Compact daily bar chart (Recharts). Readable small-font date axis, per-bar
 * green/red diff coloring (or a solid accent), amber trade-day bar, hover tooltip.
 */
export function DailyBarChart({ title, hint, mode = 'solid', data, format, accent = '#38bdf8', height = 104 }: DailyBarChartProps) {
  const hasData = data.some((d) => d.value > 0);

  const rows: Row[] = data.map((d, i) => {
    const prev = i > 0 ? data[i - 1].value : d.value;
    const fill = d.isTradeDate ? TRADE : mode === 'diff' ? (i === 0 ? NO_PREV : d.value >= prev ? UP : DOWN) : accent;
    return { date: d.date, mmdd: mmdd(d.date), full: fullLabel(d.date), value: d.value, fill, isTradeDate: !!d.isTradeDate };
  });

  const trade = rows.find((r) => r.isTradeDate) ?? rows[rows.length - 1];

  return (
    <div className="rounded-md bg-card border border-border/60 px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <h4 className="text-[10px] font-semibold text-muted-foreground/80 uppercase tracking-wide truncate" title={hint}>
          {title}
          {hint && <span className="ml-0.5 text-muted-foreground/40 cursor-help">ⓘ</span>}
        </h4>
        {hasData && trade && (
          <span className="text-xs font-mono font-semibold text-foreground tabular-nums shrink-0">
            {format(trade.value)}
            <span className="ml-1 text-[9px] font-normal text-muted-foreground/60">{trade.full}</span>
          </span>
        )}
      </div>

      {hasData ? (
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={rows} margin={{ top: 2, right: 2, bottom: 0, left: 2 }} barCategoryGap="12%">
            <XAxis
              dataKey="mmdd"
              interval={0}
              angle={-90}
              textAnchor="end"
              tick={{ fontSize: 8, fill: AXIS }}
              tickLine={false}
              axisLine={{ stroke: AXIS, strokeOpacity: 0.25 }}
              height={34}
            />
            <YAxis hide domain={[0, 'dataMax']} />
            <Tooltip
              cursor={{ fill: 'currentColor', fillOpacity: 0.06 }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const r = payload[0].payload as Row;
                return (
                  <div className="rounded-md border border-border bg-popover px-2 py-1 shadow-md">
                    <div className="text-[9px] font-mono text-muted-foreground">{r.full}</div>
                    <div className="text-[11px] font-mono font-semibold text-foreground">{format(r.value)}</div>
                  </div>
                );
              }}
            />
            <Bar dataKey="value" radius={[2, 2, 0, 0]} isAnimationActive={false}>
              {rows.map((r) => (
                <Cell key={r.date} fill={r.fill} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div className="flex items-center justify-center text-[10px] text-muted-foreground/50" style={{ height }}>
          no data
        </div>
      )}
    </div>
  );
}
