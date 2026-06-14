'use client';

import type { BtStatus, BtTradeRow, FuturesQuadrant, GateBasis } from '../_lib/bt-types';
import { inr } from '../_lib/format';

const QUADRANT_ABBR: Record<FuturesQuadrant, string> = {
  'long-buildup': 'LB',
  'short-buildup': 'SB',
  'short-covering': 'SC',
  'long-unwinding': 'LU',
  flat: '—',
};

/** Data-derived futures direction + whether it agrees with the CE/PE taken. */
function DataDir({ r }: { r: BtTradeRow }) {
  if (!r.futQuadrant || r.futQuadrant === 'flat' || !r.futBias) return <span className="text-muted-foreground/50">—</span>;
  const cls =
    r.futBias === 'bullish'
      ? 'text-green-600 dark:text-green-500'
      : r.futBias === 'bearish'
        ? 'text-red-600 dark:text-red-500'
        : 'text-muted-foreground';
  const agree = r.directionAgrees;
  return (
    <span
      className={`inline-flex items-center gap-0.5 ${cls}`}
      title={`Futures ${r.futQuadrant.replace('-', ' ')} (${r.futBias})${
        agree === false ? ' — DISAGREES with the ' + r.optionType + ' direction' : agree ? ' — agrees with ' + r.optionType : ''
      }`}
    >
      {QUADRANT_ABBR[r.futQuadrant]}
      {agree === false ? (
        <span className="text-amber-500" aria-label="direction conflict">⚠</span>
      ) : agree ? (
        <span className="text-green-500" aria-label="direction agrees">✓</span>
      ) : null}
    </span>
  );
}

function statusBadge(status: BtStatus, reason: string | null): { text: string; cls: string } {
  if (status === 'ok' && reason) {
    if (reason === 'profit-target') return { text: 'profit ₹5k', cls: 'bg-green-500/10 text-green-600 dark:text-green-400' };
    if (reason === 'stop-loss') return { text: 'stop-loss', cls: 'bg-red-500/10 text-red-600 dark:text-red-400' };
    return { text: 'day-end', cls: 'bg-slate-500/10 text-slate-600 dark:text-slate-400' };
  }
  if (status === 'skipped') return { text: 'skipped (gate)', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' };
  if (status === 'no-candles') return { text: 'no data', cls: 'bg-muted text-muted-foreground' };
  if (status === 'no-lot') return { text: 'no lot size', cls: 'bg-muted text-muted-foreground' };
  return { text: status, cls: 'bg-muted text-muted-foreground' };
}

function pnlColor(n: number | null): string {
  if (n == null) return 'text-muted-foreground';
  return n > 0 ? 'text-green-600 dark:text-green-500' : n < 0 ? 'text-red-600 dark:text-red-500' : 'text-muted-foreground';
}

/** One row per trade: signal, gate decision, fill, exit reason, net vs TF. */
export function TradeTable({ results, gateBasis }: { results: BtTradeRow[]; gateBasis: GateBasis }) {
  const useFut = gateBasis === 'futOi';
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full text-xs">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-semibold">Date</th>
            <th className="px-3 py-2 text-left font-semibold">Stock</th>
            <th className="px-2 py-2 text-center font-semibold" title="Option type TradeFinder took (CE = bullish bet, PE = bearish)">
              TF
            </th>
            <th
              className="px-2 py-2 text-center font-semibold"
              title="Data-derived futures direction (price+OI quadrant): LB long buildup · SB short buildup · SC short covering · LU long unwinding. ✓ agrees / ⚠ disagrees with the CE/PE."
            >
              Data Dir
            </th>
            <th className="px-2 py-2 text-right font-semibold" title="Combined OI ÷ 20-day avg">
              {useFut ? 'Fut OI' : 'Opt OI'}
            </th>
            <th className="px-2 py-2 text-center font-semibold" title="Supporting signals (of 6)">Sig</th>
            <th className="px-2 py-2 text-right font-semibold">Entry</th>
            <th className="px-2 py-2 text-right font-semibold">Exit</th>
            <th className="px-2 py-2 text-left font-semibold">Outcome</th>
            <th className="px-3 py-2 text-right font-semibold">Our Net</th>
            <th className="px-3 py-2 text-right font-semibold">TF P&L</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => {
            const badge = statusBadge(r.status, r.exitReason);
            const ev = r.status === 'ok';
            const oiLvl = useFut ? r.futOiLevel20 : r.optOiLevel20;
            return (
              <tr key={r.tradeId} className="border-t border-border hover:bg-muted/30">
                <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.date}</td>
                <td className="px-3 py-2 font-medium text-foreground">
                  {r.symbol} <span className="text-muted-foreground">{r.strike}</span>
                </td>
                <td className="px-2 py-2 text-center">{r.optionType}</td>
                <td className="px-2 py-2 text-center font-semibold tabular-nums">
                  <DataDir r={r} />
                </td>
                <td className={`px-2 py-2 text-right tabular-nums ${(oiLvl ?? 0) >= 1.25 ? 'font-semibold text-green-600 dark:text-green-500' : 'text-muted-foreground'}`}>
                  {oiLvl != null ? `${oiLvl.toFixed(2)}×` : '—'}
                </td>
                <td className="px-2 py-2 text-center tabular-nums text-muted-foreground">{r.signalScore}/6</td>
                <td className="px-2 py-2 text-right tabular-nums">{ev && r.entryPrice != null ? `₹${r.entryPrice}` : '—'}</td>
                <td className="px-2 py-2 text-right tabular-nums">{ev && r.exitPrice != null ? `₹${r.exitPrice}` : '—'}</td>
                <td className="px-2 py-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.cls}`}>{badge.text}</span>
                </td>
                <td className={`px-3 py-2 text-right font-semibold tabular-nums ${pnlColor(r.netPnl)}`}>
                  {ev && r.netPnl != null ? inr(r.netPnl) : '—'}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums ${pnlColor(r.tfPnl)} opacity-70`}>{inr(r.tfPnl)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
