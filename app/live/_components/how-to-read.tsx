'use client';

import { BookOpen } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';

function Dot({ cls }: { cls: string }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${cls}`} />;
}

/** Slide-over guide explaining how to read every column + how to combine them. */
export function HowToRead() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md bg-muted px-2 py-1.5 text-[11px] text-muted-foreground hover:bg-accent"
        >
          <BookOpen className="h-3.5 w-3.5" />
          How to read
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>How to read Live Urgency</SheetTitle>
          <SheetDescription>A scanner, not a buy/sell signal — it tells you where to look.</SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-4 pb-8 text-xs leading-relaxed text-muted-foreground">
          {/* Columns */}
          <section>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-foreground">What each column means</h3>
            <dl className="space-y-2">
              <Def term="LTP / Chg%">
                Last price, and the move since today&apos;s <b>open</b>. Chg% is your <b>direction</b> input.
              </Def>
              <Def term="Spread%">
                (ask − bid) ÷ mid — <b>liquidity / cost to trade</b>.{' '}
                <span className="text-emerald-600 dark:text-emerald-400">&lt;0.10% liquid</span> ·{' '}
                <span className="text-amber-600 dark:text-amber-400">0.10–0.30% okay</span> ·{' '}
                <span className="text-red-600 dark:text-red-400">&gt;0.30% illiquid (you&apos;ll bleed)</span>. Tight is
                good — it is <b>not</b> a calm/urgent signal.
              </Def>
              <Def term="Bid/Ask">
                Resting bid ÷ (bid+ask) — <b>order-flow pressure</b>, the closest thing to real &quot;urgency.&quot;{' '}
                <span className="text-emerald-600 dark:text-emerald-400">&gt;55% bid-heavy</span> (demand) ·{' '}
                <span className="text-red-600 dark:text-red-400">&lt;45% ask-heavy</span> (supply).
              </Def>
              <Def term="Fut OI / OI Lvl">
                Two different things! <b>Fut OI</b> is the raw size (always huge for a big stock — not a signal on its
                own). <b>OI Lvl</b> is today&apos;s OI ÷ its own 20-day average — <b>this</b> is the conviction read:{' '}
                <span className="text-emerald-600 dark:text-emerald-400">≥1.25×</span> = unusually heavy positioning,{' '}
                <span>~1.0× = normal</span>. A giant Fut OI with OI Lvl ~1.0× is just a big, ordinary day.
              </Def>
              <Def term="OI Build">
                The <b>rate</b> of fresh OI piling on <b>this session</b> — OI Lvl tells you positioning is heavy;
                OI Build tells you it&apos;s happening <b>right now</b>. Shows OI % change since the day&apos;s first
                snapshot, colored by an urgency score (velocity + acceleration of the build).{' '}
                <span className="text-emerald-600 dark:text-emerald-400">Bright = igniting</span>. A name can build fast
                (urgent) before its 20-day OI Lvl catches up. Fills in once a few minutes of data have accumulated.
              </Def>
              <Def term="Turnover">
                VWAP × volume — the <b>quality filter</b>: confirms real money flow, not a thin-volume move.
              </Def>
              <Def term="Setup">
                The combined verdict (see below) so you don&apos;t have to eyeball four columns at once.
              </Def>
            </dl>
          </section>

          {/* Recipe */}
          <section>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-foreground">
              How to combine them (3 gates)
            </h3>
            <ol className="list-decimal space-y-1.5 pl-4">
              <li>
                <b>Can I trade it? → Spread%.</b> If it&apos;s wide (red), skip — execution cost eats the edge.
              </li>
              <li>
                <b>Which way, is anyone pressing? → Chg% + Bid/Ask.</b> Price up + bid-heavy = demand confirmed; price
                down + ask-heavy = supply. Mixed → the move may be fading, wait.
              </li>
              <li>
                <b>Conviction or noise? → OI Lvl / OI Build + Turnover.</b> OI Lvl ≥1.25× (heavy positioning) <b>or</b> a
                fast OI Build (fresh positions piling on now), with heavy turnover = real money behind the move; ~1.0×,
                flat build, and thin = ignore.
              </li>
            </ol>
            <p className="mt-2">
              A <b>live setup</b> = tight spread + price &amp; imbalance pointing the same way + OI Lvl ≥1.25× + heavy
              turnover. Any one failing is a reason to pass.
            </p>
          </section>

          {/* Setup legend */}
          <section>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-foreground">The Setup flag</h3>
            <ul className="space-y-1.5">
              <li className="flex items-center gap-2">
                <Dot cls="bg-emerald-500" /> <b className="text-foreground">Strong</b> — liquid, price+book aligned,
                <b> and</b> conviction: heavy OI level <b>or</b> a fast OI build (with ↑/↓ bias).
              </li>
              <li className="flex items-center gap-2">
                <Dot cls="bg-amber-500" /> <b className="text-foreground">Watch</b> — liquid and one of (aligned /
                conviction), not both.
              </li>
              <li className="flex items-center gap-2">
                <Dot cls="bg-slate-400" /> <b className="text-foreground">Quiet</b> — liquid but nothing is pulling it.
              </li>
              <li className="flex items-center gap-2">
                <Dot cls="bg-muted-foreground/40" /> <b className="text-foreground">Illiquid</b> — spread too wide / no
                book; skip.
              </li>
              <li className="flex items-center gap-2">
                <span className="rounded bg-orange-500/15 px-1 text-[9px] font-semibold text-orange-700 dark:text-orange-300">
                  moved
                </span>
                <b className="text-foreground">Extended</b> — already moved &gt;3% today.
              </li>
            </ul>
            <p className="mt-1.5 text-[11px] text-muted-foreground/70">
              Click a column header to sort; the table defaults to Setup (strongest first).
            </p>
          </section>

          {/* Beginner gotcha */}
          <section className="rounded-lg border border-border bg-card p-3">
            <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-foreground">
              &quot;It moved a lot &amp; has big OI, but says Quiet?&quot;
            </h3>
            <p>
              Two traps to avoid: (1) a big <b>Fut OI</b> number is just the stock&apos;s size — what matters is{' '}
              <b>OI Lvl</b> (vs its average); a huge Fut OI at ~1.0× is normal, not a signal. (2) A move that{' '}
              <b>already happened</b> (the <span className="text-orange-600 dark:text-orange-400">moved</span> tag) means
              you&apos;re <b>late</b> — the book has usually flipped against it. &quot;Quiet&quot; there is the tool{' '}
              <b>protecting you from chasing</b>, the #1 beginner mistake. Wait for a fresh setup (Watch → Strong) or a
              pullback.
            </p>
          </section>

          {/* Caveats */}
          <section className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/5">
            <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">
              Keep in mind
            </h3>
            <ul className="list-disc space-y-1 pl-4 text-amber-800/90 dark:text-amber-200/80">
              <li>
                Imbalance is only the <b>visible</b> resting book — it flips in seconds, and big players hide size
                (icebergs / slicing). Treat it as short-term pressure, never proof of where smart money is.
              </li>
              <li>This is a scanner. It shows where to look; the entry decision is yours.</li>
              <li>Off-hours the order book doesn&apos;t exist, so the page shows nothing rather than a fake snapshot.</li>
            </ul>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Def({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-2">
      <dt className="font-semibold text-foreground">{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}
