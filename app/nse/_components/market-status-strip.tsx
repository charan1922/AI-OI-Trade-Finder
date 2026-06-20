import type { MarketStatus } from '@/lib/nse/pulse';
import { fmtNum, fmtPct, pctClass } from '@/app/nse/_lib/heat';

/** Compact market-wide status bar: open/closed · NIFTY 50 · GIFT Nifty · market cap. */
export function MarketStatusStrip({ status }: { status: MarketStatus | null }) {
  if (!status) return null;
  const open = /open/i.test(status.status);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border bg-card px-3 py-2 text-[12px]">
      <span className="flex items-center gap-1.5 font-medium">
        <span className={`h-2 w-2 rounded-full ${open ? 'animate-pulse bg-emerald-500' : 'bg-muted-foreground/50'}`} />
        {status.message || (open ? 'Market Open' : 'Market Closed')}
      </span>

      <span className="text-muted-foreground">
        NIFTY 50{' '}
        <span className="font-semibold text-foreground tabular-nums">{fmtNum(status.nifty50.last)}</span>{' '}
        <span className={`tabular-nums ${pctClass(status.nifty50.pctChange)}`}>
          {fmtPct(status.nifty50.pctChange)}
        </span>
      </span>

      {status.giftNifty && (
        <span className="text-muted-foreground">
          GIFT Nifty{' '}
          <span className="font-semibold text-foreground tabular-nums">{fmtNum(status.giftNifty.last)}</span>{' '}
          <span className={`tabular-nums ${pctClass(status.giftNifty.pctChange)}`}>
            {fmtPct(status.giftNifty.pctChange)}
          </span>
        </span>
      )}

      {status.marketCap && (
        <span className="text-muted-foreground">
          Mkt Cap{' '}
          <span className="font-semibold text-foreground tabular-nums">₹{status.marketCap.lacCrore} L Cr</span>{' '}
          <span className="text-muted-foreground/70">(${status.marketCap.trillionUsd}T)</span>
        </span>
      )}

      {status.tradeDate && <span className="ml-auto text-[10px] text-muted-foreground">{status.tradeDate}</span>}
    </div>
  );
}
