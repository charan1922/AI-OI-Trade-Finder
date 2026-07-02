'use client';

import { CheckCircle2, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { ToolTraceEntry } from '../_hooks/use-chat';

/**
 * Renders the RAW tool results behind an answer as compact, scannable cards — so
 * the user can validate the prose against the actual numbers (the "show your work"
 * panel). Driven entirely by the data the tools returned; nothing is recomputed.
 */

const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtExpiry = (iso?: string | null) => {
  if (!iso) return '—';
  const m = iso.match(/^(\d{4})-(\d{2})-\d{2}/);
  return m ? `${MON[Number(m[2])] ?? m[2]} ${m[1]}` : iso;
};
const pct = (v?: number | null, d = 1) => (v == null ? null : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
const mult = (v?: number | null) => (v == null ? null : `${v.toFixed(2)}×`);
const fmtPnl = (v?: number) =>
  v == null ? '—' : `${v >= 0 ? '+' : '−'}₹${Math.abs(v).toLocaleString('en-IN')}`;

// Green = up/profit, red = down/loss — meaningful in a trading context, kept
// for the quantitative (signed) values only. Categorical chips use Badge variants.
type Tone = 'pos' | 'neg' | 'neutral';
const toneText: Record<Tone, string> = {
  pos: 'text-emerald-600 dark:text-emerald-400',
  neg: 'text-red-600 dark:text-red-400',
  neutral: 'text-foreground',
};

function Stat({ label, value, tone = 'neutral' }: { label: string; value: string | null; tone?: Tone }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">{label}</div>
      <div className={cn('truncate text-[13px] font-semibold tabular-nums', toneText[tone])}>{value ?? '—'}</div>
    </div>
  );
}

interface TradeCtx {
  found?: boolean;
  trade?: {
    symbol?: string; date?: string; optionType?: string; strike?: number; contractExpiry?: string | null;
    pnl?: number; optionReturnPct?: number | null; humanVerified?: boolean;
  };
  direction?: { dataBias?: string; futuresQuadrant?: string; priceChangePctTradeDay?: number | null; agreesWithTrade?: boolean };
  optionOI?: { tradedContract?: string | null; stockwideLevelVsCycleAvg?: number | null; tradedContractBuildupPctTradeDay?: number | null; monthlyExpiryInWindow?: boolean };
  futuresOI?: { levelVs20dAverage?: number | null; turnoverVsAverage?: number | null };
  coverage?: { sessions?: number; dataGaps?: string[] } | null;
}

function TradeCard({ d }: { d: TradeCtx }) {
  const t = d.trade ?? {};
  const dir = d.direction ?? {};
  const oi = d.optionOI ?? {};
  const fut = d.futuresOI ?? {};
  const pnlPos = (t.pnl ?? 0) >= 0;
  const isCE = t.optionType === 'CE';
  const agrees = dir.agreesWithTrade;

  return (
    <Card className="gap-0 py-0">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border bg-muted/40 px-3.5 py-2.5">
        <span className="text-sm font-bold tracking-tight text-foreground">{t.symbol}</span>
        <Badge
          variant="outline"
          className={cn(
            'tabular-nums',
            isCE
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
          )}
        >
          {t.optionType} {t.strike}
        </Badge>
        <span className="font-mono text-[11px] text-muted-foreground">{t.date}</span>
        {t.humanVerified && (
          <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 data-icon="inline-start" />
            verified
          </Badge>
        )}
        <span className={cn('ml-auto flex items-baseline gap-1 font-mono text-sm font-bold tabular-nums', toneText[pnlPos ? 'pos' : 'neg'])}>
          {fmtPnl(t.pnl)}
          {t.optionReturnPct != null && (
            <span className="text-[11px] font-medium opacity-70">({pct(t.optionReturnPct, 0)})</span>
          )}
        </span>
      </div>

      {/* Stat grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3.5 px-3.5 py-3.5 sm:grid-cols-3">
        <Stat
          label="Data bias"
          value={dir.dataBias ? dir.dataBias.charAt(0).toUpperCase() + dir.dataBias.slice(1) : null}
          tone={dir.dataBias === 'bullish' ? 'pos' : dir.dataBias === 'bearish' ? 'neg' : 'neutral'}
        />
        <Stat label="Price (trade day)" value={pct(dir.priceChangePctTradeDay)} tone={(dir.priceChangePctTradeDay ?? 0) >= 0 ? 'pos' : 'neg'} />
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">Agrees with trade</div>
          <div className={cn('flex items-center gap-1 text-[13px] font-semibold', agrees ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400')}>
            {agrees ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
            {agrees ? 'Yes' : 'No'}
          </div>
        </div>

        <Stat label="Traded contract" value={fmtExpiry(oi.tradedContract)} />
        <Stat label="Contract OI buildup (day)" value={pct(oi.tradedContractBuildupPctTradeDay)} tone={(oi.tradedContractBuildupPctTradeDay ?? 0) >= 0 ? 'pos' : 'neg'} />
        <Stat
          label="Total opt OI (cycle)"
          value={oi.stockwideLevelVsCycleAvg != null ? mult(oi.stockwideLevelVsCycleAvg) : 'n/a · post-expiry'}
          tone={(oi.stockwideLevelVsCycleAvg ?? 0) >= 1.1 ? 'pos' : 'neutral'}
        />

        <Stat label="Futures OI level" value={mult(fut.levelVs20dAverage)} tone={(fut.levelVs20dAverage ?? 0) >= 1.1 ? 'pos' : 'neutral'} />
        <Stat label="Turnover vs avg" value={mult(fut.turnoverVsAverage)} tone={(fut.turnoverVsAverage ?? 0) >= 1.2 ? 'pos' : 'neutral'} />
        <Stat label="Coverage" value={d.coverage?.sessions != null ? `${d.coverage.sessions} sessions` : null} />
      </div>

      {/* Source line */}
      <div className="border-t border-border/60 bg-muted/20 px-3.5 py-2">
        <span className="font-mono text-[10px] text-muted-foreground/70">
          source · NSE bhavcopy + Dhan · futures quadrant: {dir.futuresQuadrant ?? '—'}
        </span>
      </div>
    </Card>
  );
}

interface TradeListData {
  total?: number;
  shown?: number;
  trades?: { symbol?: string; date?: string; option?: string; pnl?: number; humanVerified?: boolean }[];
}

function TradeListTable({ d }: { d: TradeListData }) {
  const rows = (d.trades ?? []).slice(0, 8);
  if (rows.length === 0) return null;
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3.5 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Trades</span>
        <Badge variant="secondary" className="tabular-nums">
          {rows.length} of {d.total}
        </Badge>
      </div>
      <table className="w-full text-[12px]">
        <tbody className="divide-y divide-border/50">
          {rows.map((r, i) => {
            const pos = (r.pnl ?? 0) >= 0;
            return (
              <tr key={`${r.symbol}-${r.date}-${i}`} className="transition-colors hover:bg-accent/40">
                <td className="px-3.5 py-2 font-semibold text-foreground">{r.symbol}</td>
                <td className="px-2 py-2 font-mono text-[11px] text-muted-foreground">{r.date}</td>
                <td className="px-2 py-2 text-muted-foreground">{r.option}</td>
                <td className={cn('px-3.5 py-2 text-right font-mono font-semibold tabular-nums', toneText[pos ? 'pos' : 'neg'])}>
                  {fmtPnl(r.pnl)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

interface RankData {
  metric?: 'oi_buildup' | 'oi_level' | 'pnl';
  verifiedOnly?: boolean;
  scopeCount?: number;
  shown?: number;
  trades?: {
    rank?: number; symbol?: string; date?: string; option?: string;
    optionOIBuildupPct?: number | null; oiLevel?: number | null; dataBias?: string; pnl?: number; humanVerified?: boolean;
  }[];
}

const METRIC_LABEL: Record<NonNullable<RankData['metric']>, string> = {
  oi_buildup: 'option OI buildup',
  oi_level: 'OI level',
  pnl: 'P&L',
};

function RankTable({ d }: { d: RankData }) {
  const rows = d.trades ?? [];
  if (rows.length === 0) return null;
  const metric = d.metric ?? 'oi_buildup';
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3.5 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Top {rows.length} by {METRIC_LABEL[metric]}
        </span>
        {d.verifiedOnly && (
          <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            verified
          </Badge>
        )}
      </div>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-border/60 text-[9.5px] uppercase tracking-wider text-muted-foreground/70">
            <th className="px-3.5 py-1.5 text-left font-medium">#</th>
            <th className="py-1.5 text-left font-medium">Trade</th>
            <th className={cn('px-2 py-1.5 text-right font-medium', metric === 'oi_buildup' && 'text-foreground')}>OI build</th>
            <th className={cn('px-2 py-1.5 text-right font-medium', metric === 'oi_level' && 'text-foreground')}>OI lvl</th>
            <th className={cn('px-3.5 py-1.5 text-right font-medium', metric === 'pnl' && 'text-foreground')}>P&L</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {rows.map((r, i) => (
            <tr key={`${r.symbol}-${r.date}-${i}`} className="transition-colors hover:bg-accent/40">
              <td className="px-3.5 py-2 font-mono text-muted-foreground">{r.rank ?? i + 1}</td>
              <td className="py-2">
                <span className="font-semibold text-foreground">{r.symbol}</span>{' '}
                <span className="text-[10.5px] text-muted-foreground">{r.option}</span>
                <span className="ml-1 font-mono text-[10px] text-muted-foreground/70">{r.date}</span>
              </td>
              <td className={cn('px-2 py-2 text-right font-mono tabular-nums', metric === 'oi_buildup' ? 'font-bold' : 'font-medium', toneText[(r.optionOIBuildupPct ?? 0) >= 0 ? 'pos' : 'neg'])}>
                {pct(r.optionOIBuildupPct) ?? '—'}
              </td>
              <td className={cn('px-2 py-2 text-right font-mono tabular-nums', metric === 'oi_level' && 'font-bold')}>{mult(r.oiLevel) ?? '—'}</td>
              <td className={cn('px-3.5 py-2 text-right font-mono tabular-nums', metric === 'pnl' ? 'font-bold' : 'font-medium', toneText[(r.pnl ?? 0) >= 0 ? 'pos' : 'neg'])}>
                {fmtPnl(r.pnl)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function SupportingData({ trace }: { trace: ToolTraceEntry[] }) {
  const panels = trace
    .filter((t) => t.data)
    .map((t, i) => {
      if (t.name === 'get_trade_context' && (t.data as TradeCtx)?.found) {
        return <TradeCard key={`ctx-${i}`} d={t.data as TradeCtx} />;
      }
      if (t.name === 'rank_trades') {
        return <RankTable key={`rank-${i}`} d={t.data as RankData} />;
      }
      if (t.name === 'list_trades') {
        return <TradeListTable key={`list-${i}`} d={t.data as TradeListData} />;
      }
      return null;
    })
    .filter(Boolean);

  if (panels.length === 0) return null;
  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
        <span className="h-px flex-1 bg-border" />
        supporting data
        <span className="h-px flex-1 bg-border" />
      </div>
      {panels}
    </div>
  );
}
