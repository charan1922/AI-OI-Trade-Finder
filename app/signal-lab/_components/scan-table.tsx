'use client';

import type { BreakdownRow, ScanTrade } from '@/lib/backtest/signal-scanner';

const signedPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

const QUADRANT_INFO: Record<string, { abbr: string; label: string }> = {
  'long-buildup': { abbr: 'LB', label: 'Long buildup — price up + OI up = fresh bullish positions' },
  'short-buildup': { abbr: 'SB', label: 'Short buildup — price down + OI up = fresh bearish positions' },
  'short-covering': { abbr: 'SC', label: 'Short covering — price up + OI down = shorts exiting (weak bullish)' },
  'long-unwinding': { abbr: 'LU', label: 'Long unwinding — price down + OI down = longs exiting (weak bearish)' },
};

const KEY_LABEL: Record<string, string> = {
  long: 'Long (buy first, sell later)',
  short: 'Short (sell first, buy back later)',
  'long-buildup': 'Long buildup → went long',
  'short-buildup': 'Short buildup → went short',
  'short-covering': 'Short covering → went long (weak)',
  'long-unwinding': 'Long unwinding → went short (weak)',
};

/**
 * Direction + quadrant breakdowns. This is where "the average hides two
 * different stories" becomes visible — e.g. shorts profitable, longs not.
 */
export function ScanBreakdowns({ byDirection, byQuadrant }: { byDirection: BreakdownRow[]; byQuadrant: BreakdownRow[] }) {
  if (byDirection.length === 0) return null;
  // The quadrant table only adds information when it differs from the direction
  // split (i.e. when weak quadrants are traded too).
  const quadrantAddsInfo = byQuadrant.length > byDirection.length;
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
      <BreakdownCard
        title="By direction"
        hint="The same rule can work on one side and fail on the other — always check before trusting the overall average."
        rows={byDirection}
      />
      {quadrantAddsInfo ? (
        <BreakdownCard
          title="By quadrant"
          hint="Buildups (LB/SB) are fresh conviction; covering/unwinding (SC/LU) are exits — typically weaker signals."
          rows={byQuadrant}
        />
      ) : (
        <div className="rounded-xl border border-dashed border-border p-3 text-[11px] leading-relaxed text-muted-foreground">
          With weak quadrants off, the quadrant split equals the direction split (long buildup → long, short buildup →
          short). Tick <strong>include weak quadrants</strong> to also trade short-covering and long-unwinding days.
        </div>
      )}
    </div>
  );
}

function BreakdownCard({ title, hint, rows }: { title: string; hint: string; rows: BreakdownRow[] }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <h3 className="text-xs font-bold uppercase text-muted-foreground" title={hint}>
        {title} <span className="text-muted-foreground/40">ⓘ</span>
      </h3>
      <table className="mt-2 w-full text-[11px]">
        <thead className="text-[9px] uppercase text-muted-foreground">
          <tr>
            <th className="pb-1 text-left font-medium">Group</th>
            <th className="pb-1 text-right font-medium">Trades</th>
            <th className="pb-1 text-right font-medium">Win rate</th>
            <th className="pb-1 text-right font-medium">Avg / trade</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-border/40">
              <td className="py-1 pr-2 font-sans text-muted-foreground">{KEY_LABEL[r.key] ?? r.key}</td>
              <td className="py-1 text-right text-foreground">{r.trades}</td>
              <td className={`py-1 text-right ${r.winRate >= 50 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                {r.winRate.toFixed(0)}%
              </td>
              <td className={`py-1 text-right font-semibold ${r.avgNetPct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                {signedPct(r.avgNetPct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Every simulated trade, newest first. */
export function ScanTradeTable({ trades }: { trades: ScanTrade[] }) {
  if (trades.length === 0) return null;
  const rows = [...trades].reverse(); // chronological in, newest first out
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between bg-muted/50 px-3 py-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">All trades</h3>
        <span className="text-[10px] text-muted-foreground">{trades.length} trades · newest first · returns are net of costs</span>
      </div>
      <div className="max-h-96 overflow-y-auto">
        <table className="w-full font-mono text-[11px]">
          <thead className="sticky top-0 bg-muted/40 text-[9px] uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium" title="Signal computed on this day's close; entered the NEXT session">Signal → entry</th>
              <th className="px-2 py-1.5 text-left font-medium">Symbol</th>
              <th className="px-2 py-1.5 text-center font-medium">Dir</th>
              <th className="px-2 py-1.5 text-center font-medium" title="Price+OI quadrant on the signal day">Quad</th>
              <th className="px-2 py-1.5 text-right font-medium" title="Futures OI ÷ its 20-session average on the signal day">OI×</th>
              <th className="px-2 py-1.5 text-right font-medium" title="Futures turnover ÷ its 20-session average on the signal day">Turn×</th>
              <th className="px-2 py-1.5 text-right font-medium" title="Entry at next session's open → exit at close after the hold">Entry → exit ₹</th>
              <th className="px-2 py-1.5 text-right font-medium">Net %</th>
              <th className="px-3 py-1.5 text-center font-medium" title="Was the stock in TradeFinder's top-20 R-Factor on the signal day? Only 8 snapshot days exist; blank = no snapshot.">TF</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const q = QUADRANT_INFO[t.quadrant];
              return (
                <tr key={`${t.symbol}|${t.signalDate}`} className="border-b border-border/30 hover:bg-accent/30">
                  <td className="whitespace-nowrap px-3 py-1 text-muted-foreground">
                    {t.signalDate} <span className="text-muted-foreground/50">→ {t.entryDate.slice(5)}</span>
                  </td>
                  <td className="px-2 py-1 font-sans font-semibold text-foreground">{t.symbol}</td>
                  <td className="px-2 py-1 text-center">
                    <span
                      className={`rounded px-1 py-0.5 text-[9px] font-bold ${
                        t.direction === 'long'
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
                          : 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400'
                      }`}
                    >
                      {t.direction === 'long' ? 'LONG' : 'SHORT'}
                    </span>
                  </td>
                  <td className="cursor-help px-2 py-1 text-center text-muted-foreground" title={q?.label ?? t.quadrant}>
                    {q?.abbr ?? t.quadrant}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-foreground">{t.oiLevel.toFixed(2)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{t.turnoverX.toFixed(1)}</td>
                  <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-muted-foreground">
                    {t.entry.toFixed(1)} → {t.exit.toFixed(1)}
                  </td>
                  <td
                    className={`px-2 py-1 text-right font-semibold tabular-nums ${
                      t.netPct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                    }`}
                  >
                    {signedPct(t.netPct)}
                  </td>
                  <td className="px-3 py-1 text-center">
                    {t.tfTop20 === true ? (
                      <span className="text-emerald-600 dark:text-emerald-400" title="In TradeFinder's top-20 that day">✓</span>
                    ) : t.tfTop20 === false ? (
                      <span className="text-muted-foreground/50" title="TF snapshot exists for this day; stock was NOT in the top-20">—</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
