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
      <SheetContent
        side="right"
        className="w-full overflow-y-auto data-[side=right]:sm:max-w-3xl data-[side=right]:lg:max-w-4xl"
      >
        <SheetHeader>
          <SheetTitle>How to read Live Urgency</SheetTitle>
          <SheetDescription>
            A scanner, not a buy/sell signal — it tells you <b>where to look</b>, the entry is still your call.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-4 pb-8 text-xs leading-relaxed text-muted-foreground">
          {/* The 10-second version */}
          <section className="rounded-lg border border-border bg-card p-3">
            <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-foreground">The 10-second version</h3>
            <p>
              Each row is one F&amp;O stock. Read it left to right: <b>Setup</b> is the one-word verdict and{' '}
              <b>R-Factor</b> is the single interest score — those two are your quick read. The other columns are the raw
              ingredients behind them, so you can check <i>why</i> before you trust it. Every number is live and real;
              anything we don&apos;t have shows &quot;—&quot; (never a made-up value).
            </p>
          </section>

          {/* Columns — in the order they appear in the table */}
          <section>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-foreground">What each column means</h3>
            <dl className="space-y-2.5">
              <Def term="R-Factor">
                One score for <b>how much big money participated in the stock today</b>, on a <b>1–8</b> scale (higher =
                more institutional activity). The small arrow is the <b>direction</b>:{' '}
                <span className="text-emerald-600 dark:text-emerald-400">▲ buyers</span> ·{' '}
                <span className="text-red-600 dark:text-red-400">▼ sellers</span>. It&apos;s built live by blending OI,
                turnover, range and breakout against <i>each stock&apos;s own normal</i>.{' '}
                <span className="text-emerald-600 dark:text-emerald-400">≥6.25 strong</span> ·{' '}
                <span className="text-amber-600 dark:text-amber-400">4.5–6.25 moderate</span> ·{' '}
                <span>below = quiet</span>. <b>Hover the number</b> to see which factors drove it.{' '}
                <b>
                  It answers <i>where</i> money is — never <i>when</i> to enter:
                </b>{' '}
                on a heavy day it only climbs and <b>stays high after the move is done</b> (a stock that gapped up and
                went sideways all day still scores high — big money really was there, but the trade wasn&apos;t). For
                timing, read <b>Setup + Breakout + Since 9:45</b>.
              </Def>
              <Def term="Since 9:45">
                Price change <b>since the entry window opened (09:45 IST)</b> — the <b>freshness</b> read, and the
                column that separates a live trend from a finished one. A fresh trend keeps giving here; a{' '}
                <span className="text-orange-600 dark:text-orange-400">big Chg% with ~0 Since 9:45 ⚠</span> means the
                whole move came at the open (gap-and-flat) — <b>that move is spent, let it go</b>. &quot;—&quot; before
                09:45.
              </Def>
              <Def term="Setup">
                The <b>combined verdict</b> so you don&apos;t have to weigh every column yourself — Strong / Watch / Quiet
                / Illiquid, with a ↑/↓ for direction (full rules below). This is the default sort: strongest at the top.
              </Def>
              <Def term="Breakout">
                The <b>TradeFinder 3-check breakout verdict</b> (full logic below):{' '}
                <span className="text-emerald-600 dark:text-emerald-400">Strong BO</span> /{' '}
                <span className="text-emerald-600 dark:text-emerald-400">Breakout</span> /{' '}
                <span className="text-sky-600 dark:text-sky-400">Base held</span> /{' '}
                <span className="text-orange-600 dark:text-orange-400">Fakeout?</span>, plus how many resistance levels
                price has cleared (e.g. <b>2L</b>) and ↑/↓ for the side. &quot;…&quot; = the first 15 minutes are still
                forming; &quot;—&quot; = no candles recorded yet or nothing qualifying. <b>Hover the badge</b> for the
                morning-test state, the cleared levels by name, and the next level overhead.
              </Def>
              <Def term="LTP / Chg%">
                <b>LTP</b> = last traded price. <b>Chg%</b> = how far it&apos;s moved since today&apos;s <b>open</b> —
                your <b>direction</b> input (up or down).
              </Def>
              <Def term="Spread%">
                The gap between the best buy and sell price, as a % — i.e. the <b>cost to get in and out</b>. Tight is
                good, wide bleeds money before the trade even works.{' '}
                <span className="text-emerald-600 dark:text-emerald-400">&lt;0.10% liquid</span> ·{' '}
                <span className="text-amber-600 dark:text-amber-400">0.10–0.30% okay</span> ·{' '}
                <span className="text-red-600 dark:text-red-400">&gt;0.30% illiquid</span>. It is <b>only</b> a cost
                read — not a calm-vs-urgent signal.
              </Def>
              <Def term="Bid/Ask">
                Of the orders <b>currently resting</b> in the book, the share sitting on the <b>buy</b> side — who&apos;s
                pushing right now.{' '}
                <span className="text-emerald-600 dark:text-emerald-400">&gt;55% buyers pushing</span> ·{' '}
                <span className="text-red-600 dark:text-red-400">&lt;45% sellers pushing</span> · ~50% balanced. It&apos;s
                the closest thing to live &quot;urgency,&quot; but only the <b>visible</b> book — it can flip in seconds.
              </Def>
              <Def term="Fut OI / OI Lvl">
                Two different things. <b>Fut OI</b> is the raw open interest in the future — a big stock always shows a
                huge number, so on its own it means nothing. <b>OI Lvl</b> is today&apos;s OI ÷ its <b>own 20-day
                average</b> — <b>this</b> is the conviction read:{' '}
                <span className="text-emerald-600 dark:text-emerald-400">≥1.25× = unusually heavy positioning</span> ·{' '}
                <span>~1.0× = a normal day</span>. A giant Fut OI at ~1.0× is just big and ordinary.
              </Def>
              <Def term="OI Build">
                How <b>fast fresh positions are piling on this session</b> (OI % change since today&apos;s first
                snapshot), colored by how urgent that build is (its speed + acceleration). OI Lvl tells you positioning
                is heavy; OI Build tells you it&apos;s happening <b>right now</b>.{' '}
                <span className="text-emerald-600 dark:text-emerald-400">Bright green = igniting</span>. A name can build
                fast before its 20-day OI Lvl catches up. Shows &quot;—&quot; until a few minutes of data have piled up.
              </Def>
              <Def term="NSE OI%">
                NSE&apos;s own <b>combined OI change — futures AND options together</b> — vs yesterday&apos;s close (the
                oi-spurts feed; the F&amp;O OI Build-up list above is ranked by exactly this number). Options often build
                before futures, so this catches positioning the futures-only columns miss. <b>▲</b> = still building in
                the last ~30 minutes (hover for the rate); no ▲ = built earlier, stalled since. &quot;—&quot; = the name
                isn&apos;t in NSE&apos;s feed right now.
              </Def>
              <Def term="Opt% (options share)">
                Of all the money traded in this stock&apos;s F&amp;O today, how much sat in <b>options premium</b> vs
                futures — i.e. is the position build <b>options-led or futures-led</b>. Since we <b>buy options</b>, an
                options-led build is the one that concerns us: it means the smart money is expressing its view through
                the exact instrument we trade.{' '}
                <span className="text-violet-600 dark:text-violet-400">≥20% = options-led</span> ·{' '}
                <span className="text-amber-600 dark:text-amber-400">10–20% = meaningful</span> · below = futures-led.
                Unlike the ₹ columns next to it, this is a <b>ratio</b> — it doesn&apos;t just grow through the day, so
                it&apos;s the one worth trusting late in the session.
              </Def>
              <Def term="Opt Prem / Fut Val / Opt Val / Tot Val">
                The raw money behind that split, straight from NSE&apos;s oi-spurts feed, in ₹ Crore.{' '}
                <b>Opt Prem</b> = options <b>premium</b> traded (the real cash in the options we&apos;d buy — the best
                single liquidity read for us); <b>Fut Val</b> = futures traded value; <b>Opt Val</b> = options{' '}
                <b>notional</b> (full contract value, not premium); <b>Tot Val</b> = Fut + Opt-premium. All are{' '}
                <b>cumulative since yesterday&apos;s close</b>, so they climb all day — read them for <i>scale</i>, not
                timing.
              </Def>
              <Def term="Comb OI / Prev OI">
                <b>Combined futures + options open interest</b> in contracts — today (<b>Comb OI</b>) vs yesterday
                (<b>Prev OI</b>). NSE OI% is the % change between these two; showing the absolute numbers tells you the{' '}
                <b>scale</b> a given % move represents (a +5% build on a huge base ≠ +5% on a tiny one).
              </Def>
              <Def term="Turn Lvl">
                Futures turnover ÷ its <b>20-day average, adjusted for the time of day</b> — is real money flowing at an
                unusual pace <b>right now</b>?{' '}
                <span className="text-emerald-600 dark:text-emerald-400">≥2× = heavy participation</span>. Unlike the raw
                Turnover next to it (which only ever grows through the day), this <b>decays if the flow dies</b> — a
                morning-only burst fades back toward 1× by afternoon.
              </Def>
              <Def term="Turnover">
                The <b>money actually traded</b> in the future (≈ average price × volume). The reality check: high
                turnover means real money is behind the move, not a thin one-off tick.
              </Def>
            </dl>
          </section>

          {/* Running race */}
          <section className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-500/30 dark:bg-emerald-500/5">
            <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
              The &quot;Running race&quot; panel
            </h3>
            <p className="mb-2">
              The tables below are a <b>snapshot of now</b>. The race shows <b>movement</b>: who is <b>climbing the
              leaderboard</b> fastest over the last 30–60 min. A name going <b>#25 → #6 in OI build-up</b> is getting
              crowded into <i>right now</i> — the money is arriving, and spotting it mid-climb puts you ahead of the
              pack, before it tops the board and everyone sees it.
            </p>
            <ul className="list-disc space-y-1 pl-4">
              <li>
                The green <b>▲ number</b> is how many spots it climbed; <b>#then→#now</b> shows the move.
              </li>
              <li>
                <b>New to the board</b> names are listed separately on purpose — they only just appeared in our data, so
                we <b>don&apos;t</b> pretend they rocketed up from nowhere.
              </li>
              <li>
                Same caution as R-Factor: this is <b>who&apos;s getting crowded</b>, not a buy signal. Confirm with the
                trade checklist above before acting. It fills in as the session runs and needs a few snapshots to start.
              </li>
            </ul>
          </section>

          {/* Recipe */}
          <section>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-foreground">
              How to combine them (3 gates)
            </h3>
            <p className="mb-2">
              Setup and R-Factor already roll these three up for you — but here&apos;s the logic behind them, so you can
              sanity-check a name before acting:
            </p>
            <ol className="list-decimal space-y-1.5 pl-4">
              <li>
                <b>Can I trade it? → Spread%.</b> If it&apos;s wide (red), skip — the cost to get in and out eats any
                edge.
              </li>
              <li>
                <b>Which way, and is anyone pressing? → Chg% + Bid/Ask.</b> Price up + buyers pushing = demand confirmed;
                price down + sellers pushing = supply. Mixed → the move may be fading, so wait.
              </li>
              <li>
                <b>Real conviction or just noise? → OI Lvl / OI Build + Turnover.</b> OI Lvl ≥1.25× (heavy positioning)
                <b> or</b> a fast OI Build (fresh positions piling on now), backed by heavy turnover = real money behind
                the move; ~1.0×, flat build and thin turnover = ignore.
              </li>
            </ol>
            <p className="mt-2">
              A <b>live setup</b> = tight spread + price and book pointing the same way + OI Lvl ≥1.25× (or a fast build)
              + heavy turnover. Any one failing is a reason to pass.
            </p>
          </section>

          {/* The trade decision — the scanner's own rules, for humans */}
          <section className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-500/30 dark:bg-emerald-500/5">
            <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
              When to actually pull the trigger (the checklist)
            </h3>
            <p className="mb-2">
              R-Factor finds the <i>stock</i>; this checklist decides the <i>trade</i>. It&apos;s the same set of rules
              the automated scanner enforces — every box must tick, in order:
            </p>
            <ol className="list-decimal space-y-1.5 pl-4">
              <li>
                <b>Time: 09:45–11:00 IST only.</b> Before 09:45 is opening-auction noise; after 11:00 fresh entries
                have the worst odds and square-off risk grows.
              </li>
              <li>
                <b>Where: a top R-Factor name with a clear ▲/▼.</b> Big money must already be in it — never trade a
                quiet stock because the chart &quot;looks good&quot;.
              </li>
              <li>
                <b>Confirmation: the Breakout badge</b> — <span className="text-emerald-600 dark:text-emerald-400">Breakout</span>{' '}
                or <span className="text-emerald-600 dark:text-emerald-400">Strong BO</span> in your direction, never{' '}
                <span className="text-orange-600 dark:text-orange-400">Fakeout?</span>. Price must be <i>doing</i> the
                thing, not about to.
              </li>
              <li>
                <b>Freshness: Since 9:45 still small and in your direction</b> (roughly +0.3% to +1.5% for longs). Near
                zero with a big Chg% (<span className="text-orange-600 dark:text-orange-400">⚠ / moved</span>) = the
                move is spent — skip, whatever the R-Factor says. Already ran 2%+ since 09:45 = you&apos;re late; wait
                for a pullback that holds.
              </li>
              <li>
                <b>Still alive: OI Build / NSE OI% ▲ / Turn Lvl ≥1.5×</b> — positions and money still coming in{' '}
                <i>now</i>, not just this morning.
              </li>
              <li>
                <b>Risk before entry: know your exit.</b> Stop at the invalidation level (morning low / OR low for
                longs — if it breaks, the setup failed), never more than you&apos;re prepared to lose on one trade, and
                everything closes by <b>15:12</b>. No stop = no trade.
              </li>
            </ol>
            <p className="mt-2">
              Most days <b>zero to two</b> names pass all six. Passing on everything is a valid — often the best —
              outcome; the checklist exists to keep you out of the KALYANKJIL-type trap (huge R-Factor, gap at the
              open, dead sideways after).
            </p>
          </section>

          {/* TF breakout legend */}
          <section>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-foreground">
              The Breakout flag (TradeFinder 3 checks)
            </h3>
            <p className="mb-2">
              Will a breakout <b>sustain or fail</b>? Smart money can&apos;t build size in one shot without spiking the
              price, so it accumulates quietly — the breakout only comes once positions are full. Three checks tell you
              whose breakout it is:
            </p>
            <ol className="list-decimal space-y-1.5 pl-4">
              <li>
                <b>Morning test.</b> Bullish: the <b>first-15-minute low is never broken</b> all day — buyers absorbing
                every dip. If it broke early and the stock later &quot;breaks out&quot; anyway, that&apos;s the classic{' '}
                <b>fakeout</b>: buyers burned their capital fighting in the morning. Bearish mirror: a fiercely-defended
                morning <b>high</b>.
              </li>
              <li>
                <b>Capital efficiency.</b> The R-Factor as the efficiency read — institutions moving price smoothly
                (high) vs burning money into resistance (low). A breakout on an inefficient name is skipped.
              </li>
              <li>
                <b>Multi-level aggression.</b> The strongest breakouts clear <b>several levels at once</b> — OR high,
                prev-day high, a multi-day base top (5d/20d), swing highs. Three levels &gt; two levels &gt; one.
              </li>
            </ol>
            <ul className="mt-2 space-y-1.5">
              <li className="flex items-center gap-2">
                <Dot cls="bg-emerald-500" /> <b className="text-foreground">Strong BO</b> — morning test held + ≥2 levels
                cleared + R-Factor efficient. The full TF profile.
              </li>
              <li className="flex items-center gap-2">
                <Dot cls="bg-emerald-500/50" /> <b className="text-foreground">Breakout</b> — morning test held + ≥1
                level cleared.
              </li>
              <li className="flex items-center gap-2">
                <Dot cls="bg-sky-500" /> <b className="text-foreground">Base held</b> — morning test held, no level
                cleared yet. The base is intact; a clean breakout from here is the one worth taking.
              </li>
              <li className="flex items-center gap-2">
                <Dot cls="bg-orange-500" /> <b className="text-foreground">Fakeout?</b> — clearing levels <b>but</b> the
                morning test broke earlier. The TCS profile: late breakouts from a broken morning tend to die sideways.
              </li>
            </ul>
            <p className="mt-1.5 text-[11px] text-muted-foreground/70">
              Instant invalidation: if the morning level breaks after you enter, the setup has failed — cut it small.
              Levels come from 5-min candles refreshed every ~5 minutes; the price testing them is live.
            </p>
          </section>

          {/* Setup legend */}
          <section>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-foreground">The Setup flag</h3>
            <ul className="space-y-1.5">
              <li className="flex items-center gap-2">
                <Dot cls="bg-emerald-500" /> <b className="text-foreground">Strong</b> — cheap to trade, price and book
                agree on direction, <b>and</b> real conviction (heavy OI level <b>or</b> a fast OI build). The ↑/↓ shows
                which way.
              </li>
              <li className="flex items-center gap-2">
                <Dot cls="bg-amber-500" /> <b className="text-foreground">Watch</b> — cheap to trade, and just one of
                those (direction <b>or</b> conviction), not both.
              </li>
              <li className="flex items-center gap-2">
                <Dot cls="bg-slate-400" /> <b className="text-foreground">Quiet</b> — cheap to trade, but nothing is
                pulling it either way.
              </li>
              <li className="flex items-center gap-2">
                <Dot cls="bg-muted-foreground/40" /> <b className="text-foreground">Illiquid</b> — spread too wide or no
                order book; skip.
              </li>
              <li className="flex items-center gap-2">
                <span className="rounded bg-orange-500/15 px-1 text-[9px] font-semibold text-orange-700 dark:text-orange-300">
                  moved
                </span>
                <b className="text-foreground">Extended</b> — already moved &gt;3% since the open; you may be late.
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
              <li>
                Off-hours you see the <b>frozen closing snapshot</b> of the last session — the values recorded at the
                close, not recomputed later. The order book no longer exists, so Bid/Ask show &quot;—&quot; (never
                faked).
              </li>
            </ul>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Def({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-3">
      <dt className="font-semibold text-foreground">{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}
