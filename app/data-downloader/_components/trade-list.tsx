'use client';

import { AlertTriangle, Check, X } from 'lucide-react';
import type { LegCoverage, TradeDataStatus } from '../_lib/types';
import { HumanVerifiedBadge } from './human-verified-badge';

/** Stable identity for a trade row (symbol + date + option contract). */
export function tradeKey(t: Pick<TradeDataStatus, 'symbol' | 'date' | 'optionType' | 'strike'>): string {
  return `${t.symbol}|${t.date}|${t.optionType}|${t.strike}`;
}

interface TradeListProps {
  trades: TradeDataStatus[];
  selectedKey: string | null;
  onSelect: (t: TradeDataStatus) => void;
}

export function TradeList({ trades, selectedKey, onSelect }: TradeListProps) {
  if (trades.length === 0) {
    return (
      <div className="rounded-xl bg-card border border-border px-4 py-10 text-center text-sm text-muted-foreground">
        No trades match the current filters.
      </div>
    );
  }

  return (
    <div className="rounded-lg bg-card border border-border overflow-hidden divide-y divide-border/50">
      {trades.map((t) => {
        const key = tradeKey(t);
        const selected = key === selectedKey;
        return (
          <button
            type="button"
            key={key}
            onClick={() => onSelect(t)}
            className={`w-full text-left px-2.5 py-1.5 flex flex-col gap-0.5 transition-colors ${
              selected ? 'bg-primary/10 border-l-2 border-l-primary' : 'hover:bg-accent/40 border-l-2 border-l-transparent'
            }`}
          >
            {/* Row 1: symbol + option + P&L */}
            <div className="flex items-center gap-1.5">
              {t.humanReview && <HumanVerifiedBadge show />}
              <span className="text-foreground font-bold text-xs truncate">{t.symbol}</span>
              <span
                className={`text-[10px] font-medium shrink-0 ${
                  t.optionType === 'CE' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                }`}
              >
                {t.optionType} {t.strike}
              </span>
              <span
                className={`ml-auto text-[10px] font-mono font-bold shrink-0 ${
                  t.pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                }`}
              >
                {t.pnl >= 0 ? '+' : ''}
                {'₹'}
                {(t.pnl / 1000).toFixed(1)}K
              </span>
            </div>

            {/* Row 2: date + status dots */}
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-muted-foreground font-mono">{t.date}</span>
              <span className="ml-auto flex items-center gap-1">
                {t.legs.filter((l) => l.applicable).map((l) => (
                  <StatusDot key={l.key} leg={l} />
                ))}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function StatusDot({ leg }: { leg: LegCoverage }) {
  const color =
    leg.status === 'ok'
      ? 'text-emerald-600 dark:text-emerald-400'
      : leg.status === 'partial'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-muted-foreground';
  const Icon = leg.status === 'ok' ? Check : leg.status === 'partial' ? AlertTriangle : X;
  const fix = leg.fixedBy === 'sync' ? 'click Sync' : 'click Download';
  // tradedOption is a trade-day presence check; the others are window coverage.
  const detail =
    leg.key === 'tradedOption'
      ? leg.status === 'ok'
        ? 'trade-day data present'
        : `missing — ${fix}`
      : leg.sessionsKnown === 0
        ? `no data — ${fix}`
        : `${leg.daysPresent}/${leg.sessionsKnown} sessions${leg.status === 'ok' ? '' : ` — ${fix}`}`;
  return (
    <span
      className={`flex items-center gap-0.5 text-[9px] font-mono ${color}`}
      title={`${leg.label}: ${detail}`}
    >
      <Icon className={`w-3 h-3 ${leg.status === 'missing' ? 'text-red-500/60 dark:text-red-400/40' : ''}`} />
      {leg.short}
    </span>
  );
}
