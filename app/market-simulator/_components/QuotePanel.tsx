'use client';

import type { SimQuote } from '@/lib/simulator/types';

interface Props {
  quote: SimQuote | null;
}

const inr = (n: number, d = 2) => n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

/** Compact, large-number formatting (1.23 Cr, 4.5 L, 12.3 K). */
function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)} K`;
  return n.toLocaleString('en-IN');
}

function istTime(unixSeconds: number): string {
  return new Date((unixSeconds + 5.5 * 3600) * 1000).toISOString().slice(11, 19);
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' | 'muted' }) {
  const color = tone === 'up' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'down' ? 'text-red-600 dark:text-red-400' : 'text-foreground';
  return (
    <div className="flex items-center justify-between px-3 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${tone === 'muted' ? 'text-muted-foreground' : color}`}>{value}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <div className="border-t border-border bg-card/40 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

/** Full live-quote readout — every parameter the feed reports. */
export default function QuotePanel({ quote }: Props) {
  if (!quote) {
    return (
      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
        Waiting for ticks. Load a session and press play.
      </div>
    );
  }

  const up = quote.change >= 0;
  const tone = up ? 'up' : 'down';
  const isFno = quote.instrumentKind !== 'EQUITY';

  return (
    <div>
      {/* LTP header */}
      <div className="flex items-end justify-between px-3 py-3">
        <div>
          <div className={`text-3xl font-bold tabular-nums ${up ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
            {inr(quote.ltp)}
          </div>
          <div className={`text-sm font-medium ${up ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
            {up ? '▲' : '▼'} {inr(Math.abs(quote.change))} ({inr(Math.abs(quote.changePct))}%)
          </div>
        </div>
        <div className="text-right text-[11px] text-muted-foreground">
          <div>LTQ {quote.ltq.toLocaleString('en-IN')}</div>
          <div>{istTime(quote.lastTradeTime)} IST</div>
        </div>
      </div>

      <SectionTitle>Day</SectionTitle>
      <Row label="Open" value={inr(quote.dayOpen)} tone="muted" />
      <Row label="High" value={inr(quote.dayHigh)} tone="up" />
      <Row label="Low" value={inr(quote.dayLow)} tone="down" />
      <Row label="Prev Close" value={inr(quote.prevClose)} tone="muted" />
      <Row label="VWAP" value={inr(quote.vwap)} tone="muted" />

      <SectionTitle>Volume &amp; Value</SectionTitle>
      <Row label="Volume (day)" value={compact(quote.volume)} tone="muted" />
      <Row label="Candle Vol" value={compact(quote.candleVolume)} tone="muted" />
      <Row label="Turnover" value={`₹ ${compact(quote.turnover)}`} tone="muted" />

      {isFno && (
        <>
          <SectionTitle>Open Interest</SectionTitle>
          <Row label="OI" value={compact(quote.oi)} tone="muted" />
          <Row label="OI Chg" value={compact(quote.oiChange)} tone={quote.oiChange >= 0 ? 'up' : 'down'} />
          <Row label="OI Chg %" value={`${inr(quote.oiChangePct)}%`} tone={quote.oiChange >= 0 ? 'up' : 'down'} />
          <Row label="Day Open OI" value={compact(quote.dayOpenOi)} tone="muted" />
        </>
      )}

      <SectionTitle>Current Candle</SectionTitle>
      <Row label="O" value={inr(quote.open)} tone="muted" />
      <Row label="H" value={inr(quote.high)} tone="muted" />
      <Row label="L" value={inr(quote.low)} tone="muted" />
      <Row label="C" value={inr(quote.close)} tone={tone} />
    </div>
  );
}
