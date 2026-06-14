'use client';

import { AlertTriangle, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import type { DirectionBias, TradeContextData } from '../_lib/types';

const signed = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`;
const signed1 = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;

interface Evidence {
  id: string;
  text: React.ReactNode;
  /** true → supports the trade direction (green dot), false → against (amber dot) */
  supports: boolean;
}

/**
 * Plain-English read of the setup, derived entirely from the downloaded data —
 * the "why this trade" summary. Direction comes from PRICE + OI (the four
 * quadrants), never from OI alone, and is reconciled against TF's CE/PE label so
 * a contradiction is surfaced rather than hidden. No fabricated inputs.
 */
export function TradeRationale({ ctx }: { ctx: TradeContextData }) {
  const days = ctx.days;
  const tradeDay = days.find((d) => d.isTradeDate) ?? days[days.length - 1];
  const i = ctx.insight;

  // Total option volume surge on the trade day vs the average of the OTHER
  // sessions (trade day excluded so the surge doesn't dilute its own baseline,
  // matching how oiLevel20d is computed).
  const optVols = days.filter((d) => d.optVolumeTotal > 0 && !d.isTradeDate).map((d) => d.optVolumeTotal);
  const avgOptVol = optVols.length ? optVols.reduce((a, b) => a + b, 0) / optVols.length : 0;
  const optVolX = avgOptVol > 0 && tradeDay ? tradeDay.optVolumeTotal / avgOptVol : null;

  const oiBuilding = (i.optOIChangePct ?? 0) > 0;
  const conflict = !i.directionAgrees && i.futBias !== 'neutral';

  const evidence: Evidence[] = [];

  // 1. DIRECTION — the price+OI quadrant. Leads, because direction is the thing
  // OI alone cannot tell you. "supports" = the data bias agrees with the trade.
  evidence.push({
    id: 'fut-quadrant',
    supports: i.directionAgrees,
    text: (
      <>
        Futures:{' '}
        {i.priceChangePctTradeDay != null ? (
          <>
            price <strong className="text-foreground">{signed1(i.priceChangePctTradeDay)}</strong> with OI move ⇒{' '}
          </>
        ) : (
          'price/OI move ⇒ '
        )}
        <strong className="text-foreground">{i.futQuadrantLabel}</strong>
      </>
    ),
  });

  // 2. OPTION FLOW — writing vs buying at the traded strike (premium + OI).
  if (i.optFlow !== 'flat') {
    evidence.push({
      id: 'opt-flow',
      supports: i.optFlow === 'fresh-buying',
      text: (
        <>
          Traded {ctx.optionType} {ctx.strike} strike: <strong className="text-foreground">{i.optFlowLabel}</strong>
        </>
      ),
    });
  }

  // TF/R-Factor oi_level — the V4 key metric. TF's top picks ran 1.25–1.35×
  // (25–35% above their 20-day average OI). It IS the TF magnitude signal.
  if (i.futOILevel20d != null)
    evidence.push({
      id: 'fut-oi-level',
      supports: i.futOILevel20d >= 1.1,
      text: (
        <>
          Futures OI at <strong className="text-foreground">{i.futOILevel20d.toFixed(2)}×</strong> its 20-day average —{' '}
          {i.futOILevel20d >= 1.25
            ? 'in the TF top-pick zone (1.25×+, sustained positioning)'
            : i.futOILevel20d >= 1.1
              ? 'building above baseline'
              : 'near/below baseline'}
        </>
      ),
    });
  if (i.optOILevel20d != null)
    evidence.push({
      id: 'opt-oi-level',
      supports: i.optOILevel20d >= 1.1,
      text: (
        <>
          Total option OI (CE+PE) at <strong className="text-foreground">{i.optOILevel20d.toFixed(2)}×</strong>{' '}
          its 20-day average
        </>
      ),
    });
  if (i.optOIChangePct != null)
    evidence.push({
      id: 'opt-oi',
      supports: oiBuilding,
      text: (
        <>
          <strong className="text-foreground">Total option OI {signed(i.optOIChangePct)}</strong> over 5 sessions
          {i.optOIChangePctTradeDay != null && <> ({signed(i.optOIChangePctTradeDay)} on the trade day)</>} —{' '}
          {oiBuilding ? 'open contracts rising' : 'open contracts falling'}
          <span className="text-muted-foreground/60"> (magnitude, not direction)</span>
        </>
      ),
    });
  if (optVolX != null)
    evidence.push({
      id: 'opt-vol',
      supports: optVolX >= 1.2,
      text: (
        <>
          Total option volume <strong className="text-foreground">{optVolX.toFixed(1)}×</strong> its average on the trade
          day — {optVolX >= 1.5 ? 'unusually heavy participation' : 'normal participation'}
        </>
      ),
    });
  if (i.turnoverVsAvg != null)
    evidence.push({
      id: 'turnover',
      supports: i.turnoverVsAvg >= 1.2,
      text: (
        <>
          Futures turnover <strong className="text-foreground">{i.turnoverVsAvg.toFixed(1)}×</strong> average —{' '}
          {i.turnoverVsAvg >= 1.5 ? 'heavy participation (quality filter)' : 'steady activity'}
        </>
      ),
    });

  // Header verdict is the DATA-derived bias (the quadrant), not the CE/PE label.
  const biasStyle = (bias: DirectionBias) =>
    bias === 'bullish'
      ? {
          accent: 'border-emerald-300 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/5',
          chip: 'text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-500/15',
          Icon: TrendingUp,
        }
      : bias === 'bearish'
        ? {
            accent: 'border-red-300 dark:border-red-500/30 bg-red-50 dark:bg-red-500/5',
            chip: 'text-red-700 dark:text-red-300 bg-red-100 dark:bg-red-500/15',
            Icon: TrendingDown,
          }
        : {
            accent: 'border-border bg-muted/30',
            chip: 'text-muted-foreground bg-muted',
            Icon: Minus,
          };
  const s = biasStyle(i.futBias);
  const biasWord = i.futBias === 'neutral' ? 'Neutral' : i.futBias === 'bullish' ? 'Bullish' : 'Bearish';

  return (
    <div className={`rounded-lg border px-3 py-2.5 ${conflict ? 'border-amber-400 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/5' : s.accent}`}>
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wide">Why this trade</span>
        <span
          className="text-[10px] text-muted-foreground/70"
          title="TradeFinder bought this option type; CE = a bullish bet, PE = a bearish bet."
        >
          TF took <strong className="text-foreground">{ctx.optionType}</strong>
        </span>
        <span className={`ml-auto flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded ${s.chip}`} title={i.directionNote}>
          <s.Icon className="w-3 h-3" />
          Data: {biasWord}
          {i.futQuadrant !== 'flat' && <span className="font-normal opacity-80"> · {i.futQuadrant.replace('-', ' ')}</span>}
        </span>
      </div>

      {conflict && (
        <div className="mb-1.5 flex items-start gap-1.5 rounded border border-amber-300 dark:border-amber-500/30 bg-amber-100/60 dark:bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            Direction conflict — {i.directionNote}. The positioning data points the opposite way to the {ctx.optionType}{' '}
            trade that was taken.
          </span>
        </div>
      )}

      {i.optExpiryInWindow && (
        <div className="mb-1.5 flex items-start gap-1.5 rounded border border-sky-300 dark:border-sky-500/30 bg-sky-100/60 dark:bg-sky-500/10 px-2 py-1 text-[11px] text-sky-700 dark:text-sky-300">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            Monthly options expiry falls in this window — total option OI steps down as strikes roll off. The OI-level
            read uses only post-expiry (same-cycle) sessions
            {i.optOILevel20d == null && ', and is hidden until ≥5 such sessions exist'}, so it isn&apos;t skewed across cycles.
          </span>
        </div>
      )}

      <ul className="space-y-1">
        {evidence.map((e) => (
          <li key={e.id} className="flex items-start gap-2 text-[11px] text-muted-foreground leading-relaxed">
            <span
              className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${
                e.supports ? 'bg-emerald-500' : 'bg-amber-500'
              }`}
            />
            <span>{e.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
