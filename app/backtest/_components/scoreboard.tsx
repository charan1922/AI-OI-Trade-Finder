'use client';

import type { BtSummary } from '../_lib/bt-types';
import { inr, signedInr } from '../_lib/format';

function gateLabel(s: BtSummary): string {
  if (s.gateBasis === 'none') return 'no filter (all evaluable trades)';
  if (s.gateBasis === 'score') return `signal score ≥ ${s.gateThreshold}/6`;
  if (s.gateBasis === 'futOi') return `combined futures OI ≥ ${s.gateThreshold}× 20-day avg`;
  return `combined option OI ≥ ${s.gateThreshold}× 20-day avg`;
}

type Tone = 'pos' | 'neg' | 'neutral';

function Stat({ label, value, hint, tone = 'neutral' }: { label: string; value: string; hint?: string; tone?: Tone }) {
  const color =
    tone === 'pos'
      ? 'text-green-600 dark:text-green-500'
      : tone === 'neg'
        ? 'text-red-600 dark:text-red-500'
        : 'text-foreground';
  return (
    <div className="rounded-xl bg-card border border-border p-3">
      <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-1 text-lg font-bold tabular-nums ${color}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** At-a-glance verdict for the vectorbt backtest. */
export function Scoreboard({ summary: s }: { summary: BtSummary }) {
  const vsTf = s.netPnl - s.tfTotalPnl;
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-muted-foreground">
        Gate: <b className="text-foreground">{gateLabel(s)}</b> · profit target{' '}
        <b className="text-foreground">{inr(s.profitTarget)}</b> · took <b className="text-foreground">{s.taken}</b>/
        {s.totalTrades}, evaluated <b className="text-foreground">{s.evaluated}</b>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <Stat label="Net P&L" value={inr(s.netPnl)} tone={s.netPnl >= 0 ? 'pos' : 'neg'} hint={`gross ${inr(s.grossPnl)}`} />
        <Stat label="Win Rate" value={`${Math.round(s.winRate * 100)}%`} hint={`${s.wins}W / ${s.losses}L`} />
        <Stat label="Profit Factor" value={s.profitFactor != null ? s.profitFactor.toFixed(2) : '—'} hint="above 1 = profitable" />
        <Stat label="Max Drawdown" value={inr(s.maxDrawdown)} tone="neg" hint="worst peak-to-dip" />
        <Stat label="Expectancy" value={inr(s.expectancy)} tone={s.expectancy >= 0 ? 'pos' : 'neg'} hint="net avg / trade" />
        <Stat label="Charges" value={inr(s.charges)} hint="STT + fees (vectorbt)" />
        <Stat label="Consistency" value={s.sharpe != null ? s.sharpe.toFixed(2) : '—'} hint="Sharpe — higher is steadier" />
        <Stat
          label="vs TradeFinder"
          value={signedInr(vsTf)}
          tone={vsTf >= 0 ? 'pos' : 'neg'}
          hint={`TF made ${inr(s.tfTotalPnl)} on these`}
        />
      </div>
    </div>
  );
}
