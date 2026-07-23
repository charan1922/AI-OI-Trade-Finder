/**
 * /reminders — the operator's pending-decision list (admin-only).
 *
 * STATIC for now (deliberately): each reminder is an entry in the REMINDERS
 * array below, written in simple English. These are "come back and decide
 * later" items — switches waiting for more evidence, one-time checks after a
 * config change — NOT live app state. To add/close one, edit this file.
 */

import { AlarmClock, CalendarDays, CheckCircle2, PlayCircle } from 'lucide-react';

interface Reminder {
  title: string;
  /** When to come back to it (plain words, not a timer). */
  when: string;
  /** Simple-English story: what happened, what's waiting, what to do. */
  what: string[];
  /** The concrete action to take when the time comes. */
  action: string;
  added: string; // YYYY-MM-DD
}

const REMINDERS: Reminder[] = [
  {
    title: 'Watch the new 25% premium stop on the next few live sessions',
    when: 'After ~4–5 more trading days (around 30 Jul 2026)',
    added: '2026-07-23',
    what: [
      'Until 23 Jul the premium stop was “the tighter of −40% and −₹1,500 per lot”. Because ₹1,500 is divided by a lot size that ranges 75–700 units, the stop that actually applied landed anywhere between 7.7% and 23.8% of the option’s price — and nobody ever chose those numbers, they fell out of the lot size.',
      'Across all 9 completed live trades that split the record almost perfectly: every stop tighter than 12% lost (INDUSINDBK 7.7%, AXISBANK 8.1%, NESTLEIND 9.2%, POLYCAB 9.4%, COLPAL 11.7%), and both stops above 20% won (HEROMOTOCO 20.6%, M&M 23.8%).',
      'The proof case is SRF on 23 Jul. It was stopped out at ₹36 while the STOCK was still 1 point from the entry price — the option had already given up 78% of its stop budget to time decay, the post-open volatility cool-off, and a 2.16% gap between the buy and sell price. The call was right: the stock fell 175 points and the same contract was bid ₹178 by 14:50. Held, that lot was worth +₹26,880 instead of −₹1,610.',
      'The stop is now a flat 25% of the option’s own price, and the ₹ budget is enforced the other way round — a lot that would risk more than ₹2,500 is REFUSED at the gate instead of being given a tighter stop. Replaying all 9 trades: the 3 winners are unchanged, SRF survives, and 5 losers are refused (3 of those refusals are new — the capital cap already blocked the other 2).',
      'HONEST LIMIT: n=9 over 5 sessions, and full-day option prices only exist for 23 Jul. Lot cost and the old stop width are the same underlying variable, so “refused the losers” and “tight stops lost” are one finding seen twice, not two independent ones. Refusing a trade also forgoes whatever it might have won.',
    ],
    action:
      'Ask Claude: "run scripts/replay-premium-stop.ts and check the new stop against the sessions since 23 Jul". Watch for the failure mode this change can cause — losses that are now larger (~₹2,200 instead of ~₹1,500) without a matching rise in the winners. If that shows up, lower "Premium stop width" on /auto-trade rather than reverting to a ₹/lot squeeze.',
  },
  {
    title: 'Two toggles are currently redundant — decide what to do with them',
    when: 'Next time you touch /config',
    added: '2026-07-23',
    what: [
      '“Extended-trend bypass” is ON but does NOTHING right now. It only ever runs inside the branch that handles a stock already 3%+ from the open — and “Skip already-extended movers”, the switch that creates that branch, was turned OFF on 23 Jul at 09:35. With the parent off, the bypass is unreachable code. Leaving it ON reads like a live permission that is not live.',
      '“Breakout bypass” overlaps almost entirely with “Momentum-breakout path” while that one is ON. Both need a confirmed opening-range breakout with Supertrend and VWAP agreeing. Momentum additionally waives the R-Factor gate; the bypass still requires R-Factor ≥ 3.6, which is the normal gate anyway. Its only unique slice is a strong-R breakout that has moved LESS than 1.5% from the open.',
      'Worse, a pick admitted by the breakout bypass writes NO marker into its reasons list, so you cannot tell from the Trade Log which picks came in that way — unlike the momentum path, which stamps a ⚡ line. That is an observability gap, not just a redundancy.',
      'For contrast: “Auto power-off” looks unused in the TypeScript but is NOT — deploy/box/autostop.sh reads it straight out of SQLite. Do not remove it.',
    ],
    action:
      'Decide two things on /config: (1) either turn “Skip already-extended movers” back ON (its safe default) or turn “Extended-trend bypass” OFF — do not leave a bypass enabled whose parent rule is disabled; (2) either ask Claude to add a reason marker for breakout-bypass admissions, or turn that toggle OFF while the momentum path is ON.',
  },
  {
    title: 'Turn on the "TF breakout gate"?',
    when: 'After ~4–5 more trading days (around 21 Jul 2026)',
    added: '2026-07-15',
    what: [
      'On 15 Jul the scanner kept suggesting TATAELXSI all day even though it never broke out — it stayed sideways and the bearish idea was wrong.',
      'There is already a switch that only allows picks with a REAL confirmed breakout in the trade’s direction ("TF breakout gate" on /config). It is OFF today.',
      'A replay of 15 Jul’s 8 picks showed: with the switch ON, the 3 no-move names (TATAELXSI, BIOCON, ICICIPRULI) would have been removed and BOTH winners (PATANJALI +₹6,504, MANKIND +₹3,988) kept.',
      'But that is only ONE day of proof. The code’s own notes demand a multi-day check before enabling. Candles are now kept 20 sessions and every evening the scorecard grades the day’s picks automatically — so the evidence builds up by itself.',
    ],
    action:
      'Ask Claude: "run the breakout-gate replay across recorded days". If it still cuts junk without cutting winners → flip ON "TF breakout gate" on /config (one click, instantly reversible).',
  },
  {
    title: 'Add a "weak futures OI" filter? (the HYUNDAI lesson)',
    when: 'Around 21 Jul 2026 — same replay session as the breakout gate above',
    added: '2026-07-15',
    what: [
      'On 15 Jul the HYUNDAI trade lost ₹1,911. Its scan record shows futures OI was only 0.77× the 20-day average — the LOWEST reading of all 54 picks ever recorded. The pick was carried by options OI alone; the futures crowd was not participating.',
      'The breakout gate would NOT have caught it (HYUNDAI had a confirmed breakout), so this is a separate signal.',
      'A replay tested "skip picks with futures OI below 0.85× the 20-day average": it removes HYUNDAI and keeps every big winner across all graded days (only DLF, a mild +1% mover, is sacrificed). 15 Jul would have been +₹10,492 instead of +₹8,581.',
      'BUT: only 5 of 9 recorded days have graded outcomes, and just 2 graded picks ever fell below 0.85 — picking the threshold because it fits one bad trade is the classic overfit trap. Wait for more evidence (the nightly scorecard is collecting it automatically).',
    ],
    action:
      'Ask Claude: "test the futures-OI floor (0.85×) across recorded days, together with the breakout-gate replay". If it still cuts junk without cutting winners → build it as a default-OFF toggle on /config.',
  },
  {
    title: 'Catch the ADANIENSOL / ADANIGREEN class (price-led, no OI) — replay experiments running',
    when: 'After ~5 more trading days (around 24 Jul 2026)',
    added: '2026-07-17',
    what: [
      'TradeFinder made +₹15.9k on ADANIGREEN (14-Jul) and +₹10.2k on ADANIENSOL (16-Jul). Both are the SAME class: price rises while open interest stays flat (short-covering). Our engine rejects them BY DESIGN — every accumulation gate needs OI evidence, and here there is none.',
      'ADANIENSOL failed ONLY the "NSE combined OI ≥5%" rule (it had 1–2%), even though its OPTIONS flow clearly passed (options-share 10–19%, premium ₹6Cr→₹99Cr). So the money was in options; we just did not count it because futures OI stayed low.',
      'Two candidate catches were added to the nightly replay grid (scripts/replay-window.ts), EVIDENCE-ONLY — nothing is live: (1) "momentum-breakout 1%" — the existing momentum path but triggering earlier, since the current version only fires ~10:45 near the top; (2) "options-led-relaxed" — let the options flow qualify without the 5% futures-OI rule.',
      'The winner/loser separator on 16-Jul was "is the stock still CLIMBING the OI/gainers leaderboard right now" (winners climbing 5/8 vs losers 1/7; ADANIENSOL climbed gainers #15→#7). That became the rank-climb CATCH path (USE_RANK_CLIMB_GATE on /config), built 17-Jul but shipped OFF — it debuted the same day as autonomous LIVE trading, and you never launch live with an unproven more-permissive gate on top. Turn it ON from /config once live has run clean for a few days. Backtest when on: 15-Jul picks identical; 16-Jul swaps one slipping loser (PAYTM −3 spots, SL) for one climbing name (KALYANKJIL +10, also SL) — zero new stop-losses, zero winners lost, ΣR unchanged.',
      'HONEST LIMIT, measured: the climb catch does NOT rescue ADANIENSOL itself — its R-Factor sat at 2.26–2.68 all window vs the 3.6 gate, so it dies BEFORE the OI gate the catch extends. The only built path that clears low-R price-led names is the momentum-breakout path (still OFF, and it fires ~10:45 near the top). Catching this class fully means letting the climb evidence relax the R-Factor gate too — a bigger risk call that needs replay proof first, NOT a quiet default.',
    ],
    action:
      'Ask Claude: "run the replay grid across all recorded days — shipped vs no-rank-climb-catch vs climb-catch>=5 vs momentum-breakout 1% — with per-fire precision". Keep USE_RANK_CLIMB_GATE ON only if it avoids slipping losers / catches climbers across several days; escalate to an R-Factor relaxation experiment only if the evidence stays clean.',
  },
  {
    title: 'Chaotic-open gate was switched OFF on 23 Jul — first day’s evidence went AGAINST the gate',
    when: 'Due now — re-check after ~4 more trading days (around 29 Jul 2026)',
    added: '2026-07-17',
    what: [
      'UPDATE 23 Jul: the gate was turned OFF at 09:34, 15 minutes before the first scan. That let 11 violent-open names through — and on the day they were the BETTER half: those 11 scored +7.15R in total (avg +0.65R each) while the 25 calm-open names scored −4.12R (avg −0.16R). That is the opposite of what the gate assumes.',
      'Do NOT act on that yet. It is one day, and only ONE of those 11 (ETERNAL) was ever sent to a real order — and it was blocked on margin. So the day’s real money never tested the question at all.',
      'Both auto-trade losers (HYUNDAI 15-Jul −₹1,911, SRF 16-Jul would-be loss) opened VIOLENTLY — their first 15 minutes ranged 5.5–5.7× the stock’s own normal 5-minute bar — then faded within half an hour. The winners (MANKIND, PATANJALI, POLYCAB) opened calmer and trended.',
      'A new gate ("Skip chaotic opens" on /config) now skips any pick whose opening was more than 5× its settled average bar. It went live ON (operator request, 17-Jul) — unlike the other experimental switches, which wait for proof first.',
      'The 5× line matters: the first draft used 4×, and the full-universe backtest showed 4× would have wrongly blocked genuine trend-day winners (KALYANKJIL, SIEMENS, CGPOWER all sat at ~4.3–4.5× at 10:30) because most stocks naturally open hot. At 5×: both losers still blocked, all winners kept, 6 losing picks cut, zero winners lost. ADANIENSOL 16-Jul (TF’s +₹10.1k) measured a CALM 2.2–3.1× — this gate never touches that class.',
      'The honest caveat: the evidence is 2 recorded days. Every pick now carries a "calm open / chaotic open" line, so the nightly scorecard builds the real evidence automatically.',
    ],
    action:
      'Ask Claude: "replay the chaotic-open gate across recorded days". If it kept cutting HYUNDAI/SRF-type losers without cutting winners → keep ON. If it cost a real winner → flip it OFF on /config (one click) and park it back with the other experiments.',
  },
  {
    title: 'Momentum-breakout switch was turned ON without the multi-day replay — grade it now',
    when: 'Overdue — it is already live and taking real trades',
    added: '2026-07-15',
    what: [
      'ORIGINAL ITEM: on 14 Jul TradeFinder made +₹15,930 on ADANIGREEN, a short-covering breakout our engine skips BY DESIGN (price up while OI falls scores zero on every accumulation gate). A 4th entry path was built for that pattern and shipped OFF until replays over several days proved it.',
      'SECOND case, 16 Jul: TradeFinder made +₹10,159 on ADANIENSOL — on our gainers board all window, calm open, broke its opening range ~10:00 with trend agreement, and every OI gate refused it (futures OI 0.96× vs 1.1×, options share 6.7% vs 10%, premium ₹4.4Cr vs ₹5Cr).',
      'STATUS CHANGE: the switch was turned ON at 23:43 on 22 Jul, without that replay. It is no longer a parked decision — it is the live admission path. On 23 Jul it produced 35 of the day’s 38 suggestions and ALL FIVE real trades (SRF, ETERNAL, BAJAJ-AUTO, M&M, HEROMOTOCO). Before that night it had produced zero picks on all 12 recorded days.',
      'First day’s result: of 33 graded momentum picks, 14 won and 19 lost, summing to +3.03R (avg +0.09R). Of the 5 it sent to real orders, 3 won, 1 lost, 1 was blocked on margin. That is ONE day.',
      '24 of the 35 momentum picks had an R-Factor below 3.6, meaning the momentum path is the only thing that could have admitted them — this switch is doing real work, not rubber-stamping picks that would qualify anyway.',
    ],
    action:
      'Ask Claude: "grade the momentum-breakout path across every recorded day now that it is live". It is ON and trading, so the question is no longer whether to enable it but whether to keep it — decide on the accumulated scorecard, not on 23 Jul alone.',
  },
  {
    title: 'First real broker orders have now run — reconciliation is the thing left to watch',
    when: 'Ongoing, until a few clean live sessions have passed',
    added: '2026-07-15',
    what: [
      'CLOSED: the original item was "the real Fyers/Dhan order APIs have NEVER been exercised against a live account". They have now — 14 live orders across 13–23 Jul, with 9 confirmed fills and exits.',
      'What it taught us, worth keeping: SRF on 16 Jul got stuck in PLACING because the Fyers SDK wraps a network error and an API rejection identically, so a thrown error can never be read as "the order definitely did not reach the broker".',
      'Margin rejections are real and have blocked two picks: SONACOMS on 17 Jul (short ₹1,909 of ₹25,000) and ETERNAL on 23 Jul (short ₹1,275 of ₹16,157). Keeping a few thousand rupees of headroom above the lot cost avoids losing a pick to arithmetic.',
    ],
    action:
      'No longer needs a manual watch on every order. Do keep checking that each session ends with no stuck PLACING row and no position open at the broker that the app does not know about — the reconcile step owns that, and the risk latch blocks new entries if it disagrees.',
  },
  {
    title: 'Check prod disk usage (on the AWS box, not Railway)',
    when: 'Overdue — was due 22 Jul 2026',
    added: '2026-07-15',
    what: [
      'Candles used to be wiped every day; since v1.18.0 we keep 20 sessions (needed for replays and the breakout gate evidence).',
      'That means the database file grows every day for ~4 weeks before it levels off.',
      'The original wording pointed at a Railway volume. Prod has since moved to the self-hosted AWS EC2 box, so the check is now a disk check on that machine (/app/data), not a Railway dashboard.',
      'For scale: the full prod DB pulled on 23 Jul was 260 MB, up from 230 MB earlier the same day — most of that growth is candles, OI samples and rank snapshots.',
    ],
    action:
      'SSH to the AWS box and run df -h plus du -sh /app/data. If the disk is heading past ~80%, ask Claude to trim candle retention or grow the volume.',
  },
];

export const dynamic = 'force-static';

export default function RemindersPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <div className="flex items-center gap-2">
        <AlarmClock className="size-5 text-primary" />
        <h1 className="text-lg font-bold">Reminders</h1>
        <span className="text-xs text-muted-foreground">
          Decisions parked for later — switches waiting for proof, one-time checks. Static list (edit
          <span className="mx-1 font-mono">app/reminders/page.tsx</span>to add or close one).
        </span>
      </div>

      {/* Playbook callout — the recipe the two filter reminders below both point to. */}
      <div className="rounded-lg border border-sky-500/40 bg-sky-500/5 p-4">
        <div className="flex items-center gap-2">
          <PlayCircle className="size-4 shrink-0 text-sky-600 dark:text-sky-400" />
          <h2 className="text-sm font-bold">What “improve” looks like on 21 Jul</h2>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          It is <span className="font-semibold">one session</span>, not a rebuild. When the date comes, ask Claude:
        </p>
        <p className="mt-2 rounded-md bg-background/60 px-3 py-2 font-mono text-xs text-foreground">
          “run the breakout-gate and futures-OI floor replay across all recorded days”
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>
            If a filter cuts the junk <span className="font-semibold">without</span> cutting winners across MANY days →
            flip it ON (one click on <span className="font-mono">/config</span>, instantly reversible).
          </li>
          <li>If it also kills winners → leave it OFF. We learned that cheaply, on paper, with zero money at risk.</li>
        </ul>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Why wait, not tune now? One bad day is not proof. The “obvious” 15-Jul fix (skip extended-from-open picks) was
          replayed and it would have <span className="font-semibold">deleted</span> the day’s biggest winner (PATANJALI
          +₹6,504). Rules tuned to yesterday quietly kill tomorrow’s winner — so we decide on a multi-day sample, the way
          the nightly scorecard is already gathering it.
        </p>
      </div>

      {REMINDERS.map((r) => (
        <div key={r.title} className="rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-sm font-bold">{r.title}</h2>
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
              <CalendarDays className="size-3" />
              {r.when}
            </span>
            <span className="ml-auto text-[10px] text-muted-foreground">added {r.added}</span>
          </div>

          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {r.what.map((line) => (
              <li key={line.slice(0, 40)}>{line}</li>
            ))}
          </ul>

          <div className="mt-3 flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 text-xs">
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>
              <span className="font-semibold">When the time comes:</span> {r.action}
            </span>
          </div>
        </div>
      ))}

      <p className="text-[10px] text-muted-foreground">
        Why static? These items change a few times a month and deserve a written why — a code file keeps them
        reviewed in git and impossible to lose. If the list ever grows past a screen, promote it to a table + UI.
      </p>
    </div>
  );
}
