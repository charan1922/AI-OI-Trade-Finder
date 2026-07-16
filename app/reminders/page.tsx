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
    title: 'Momentum-breakout switch is still OFF',
    when: 'After several recorded sessions (needs multi-day replay proof)',
    added: '2026-07-15',
    what: [
      'On 14 Jul, TradeFinder made +₹15,930 on ADANIGREEN — a short-covering breakout our engine skipped BY DESIGN (price up while OI falls scores zero on every accumulation gate).',
      'A 4th entry path was built for exactly that pattern (confirmed opening-range breakout + Supertrend AND VWAP agreeing + a real move behind it). It is OFF (USE_MOMENTUM_BREAKOUT) until replays over several days prove it catches the ADANIGREEN type without letting in fakeouts.',
    ],
    action:
      'Ask Claude: "validate the momentum-breakout path across recorded days". If proven → flip ON "Momentum breakout" on /config.',
  },
  {
    title: 'Watch the FIRST real broker order manually',
    when: 'The day auto-trade mode moves from paper to approval/live',
    added: '2026-07-15',
    what: [
      'Every order so far has been paper (simulated fills at real prices). The real Fyers/Dhan order APIs are wired but have NEVER been exercised against a live account.',
      'The first real order is the one place a surprise can cost money before code can catch it.',
    ],
    action:
      'When approving the first real trade, keep the broker terminal open and watch the order end-to-end: placement → fill → the app’s recorded fill matches the broker’s.',
  },
  {
    title: 'Check prod disk usage',
    when: 'Around 22 Jul 2026 (one week after the retention change)',
    added: '2026-07-15',
    what: [
      'Candles used to be wiped every day; since v1.18.0 we keep 20 sessions (needed for replays and the breakout gate evidence).',
      'That means the database file grows every day for ~4 weeks before it levels off. The Railway volume was about 47% used before this change.',
    ],
    action:
      'Open Railway → service → volume usage. If it is heading past ~80%, ask Claude to trim retention or grow the volume.',
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
