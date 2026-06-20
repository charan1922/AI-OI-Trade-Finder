import type { NseIndex } from '@/lib/nse/indices';
import { fmtNum, heatColor } from '@/app/nse/_lib/heat';

/** One colored index tile (used by the heatmap grids). */
export function IndexTile({ idx, label, big }: { idx: NseIndex; label: string; big?: boolean }) {
  const pct = idx.percentChange;
  return (
    <div
      className={`flex flex-col justify-between rounded-md p-2 ${big ? 'min-h-[72px]' : 'min-h-[58px]'}`}
      style={{ background: heatColor(pct) }}
      title={`${idx.symbol}\n${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%  (${idx.variation >= 0 ? '+' : ''}${fmtNum(idx.variation)} pts)\nlast ${fmtNum(idx.last)} · prev ${fmtNum(idx.previousClose)}${
        idx.advances != null && idx.declines != null
          ? `\n${idx.advances} up · ${idx.declines} down${idx.unchanged != null ? ` · ${idx.unchanged} flat` : ''}`
          : ''
      }`}
    >
      <div
        className={`line-clamp-2 font-semibold leading-tight text-white/95 ${big ? 'text-[11px]' : 'text-[10px]'}`}
      >
        {label}
      </div>
      <div className="flex items-baseline justify-between gap-1">
        <span className={`font-bold tabular-nums text-white ${big ? 'text-[15px]' : 'text-[13px]'}`}>
          {pct >= 0 ? '+' : ''}
          {pct.toFixed(2)}%
        </span>
        <span className="text-[9px] tabular-nums text-white/70">{fmtNum(idx.last)}</span>
      </div>
    </div>
  );
}
