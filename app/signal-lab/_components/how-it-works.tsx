'use client';

import { CalendarCheck, Moon, Sunrise } from 'lucide-react';

/**
 * Always-visible plain-English explainer. The single most important idea on this
 * page is the timeline — signals come ONLY from the evening BEFORE the trade —
 * so it is drawn as three explicit steps.
 */
export function HowItWorks() {
  return (
    <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-2">
      <h2 className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">How this scan works</h2>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <Step
          icon={<Moon className="h-4 w-4 text-indigo-500" />}
          title="1 · Evening of day D"
          text="After the market closes, NSE publishes the official end-of-day file (bhavcopy). For EVERY F&O stock the rule checks: is futures OI unusually high vs its own 20-day average? Is turnover heavy? And which way does the price + OI move point (the quadrant)? Only numbers that existed that evening are used."
        />
        <Step
          icon={<Sunrise className="h-4 w-4 text-amber-500" />}
          title="2 · Next morning (D+1)"
          text="If the rule fired, the scan 'trades' the stock at the next session's official OPENING price — long on long buildup (fresh bullish positions), short on short buildup (fresh bearish positions). Every trade gets equal capital."
        />
        <Step
          icon={<CalendarCheck className="h-4 w-4 text-emerald-500" />}
          title="3 · Exit & score"
          text="Exit at the official CLOSING price after the chosen hold. Costs are subtracted from every trade, and the result is compared against a random baseline: what picking any stock, any day, the same way would have averaged."
        />
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        <strong className="text-foreground">Why this page exists:</strong> the Data Downloader page studies only the
        trades TradeFinder <em>took</em> (winners it selected — that&apos;s hindsight). This scan removes that bias: it
        replays <strong className="text-foreground">every stock, every session</strong>, fires the rule blind, and
        measures what actually happened next. No look-ahead: nothing from the entry day or later ever feeds the
        signal. A negative result here is a genuine finding — it stops you trading a losing rule with real money.
      </p>
    </div>
  );
}

function Step({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-foreground">
        {icon}
        {title}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{text}</p>
    </div>
  );
}
