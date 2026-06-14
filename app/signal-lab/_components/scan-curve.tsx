'use client';

/**
 * Cumulative net-% staircase across trades in entry-date order (equal capital
 * per trade, so percentage points add). Plain SVG, same approach as the
 * backtest page's equity curve.
 */
export function ScanCurve({ curve }: { curve: { date: string; cum: number }[] }) {
  if (curve.length === 0) return null;

  const W = 800;
  const H = 200;
  const padX = 8;
  const padY = 16;
  const ys = curve.map((p) => p.cum);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(0, ...ys);
  const spanY = maxY - minY || 1;
  const spanX = curve.length - 1 || 1;
  const xAt = (i: number) => padX + (i / spanX) * (W - 2 * padX);
  const yAt = (v: number) => padY + (1 - (v - minY) / spanY) * (H - 2 * padY);
  const zeroY = yAt(0);
  const path = curve.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(1)} ${yAt(p.cum).toFixed(1)}`).join(' ');
  const final = ys[ys.length - 1];
  const stroke = final >= 0 ? '#22c55e' : '#ef4444';

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-1 text-xs font-bold uppercase text-muted-foreground">
        Cumulative result{' '}
        <span className="text-[10px] font-normal normal-case text-muted-foreground/70">
          running sum of per-trade net % (equal capital per trade) — the dashed line is break-even
        </span>
      </h3>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height: H }} role="img" aria-label="Cumulative return curve">
        <line x1={padX} x2={W - padX} y1={zeroY} y2={zeroY} stroke="rgba(148,163,184,0.35)" strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        <path d={path} fill="none" stroke={stroke} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground">
        <span>{curve[0].date}</span>
        <span className={final >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
          Final: {final >= 0 ? '+' : ''}
          {final.toFixed(1)}% points over {curve.length} trades
        </span>
        <span>{curve[curve.length - 1].date}</span>
      </div>
    </div>
  );
}
