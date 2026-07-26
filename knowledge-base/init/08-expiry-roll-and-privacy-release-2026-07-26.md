# Expiry-week roll + privacy release — 2026-07-26

## What this document is

Plain-English record of everything that went to production on 26 July 2026.
Four pull requests were merged and deployed in one release. This explains what
each one does, why it was needed, what was measured, and what is still open.

**Status: LIVE.** `prod` is at `88ede7f`. The deploy build finished successfully
and `:latest` was pushed for the AWS box to pull.

| | |
|---|---|
| Was on prod before | `62f666b` (premium stop sized to the option, PR #18) |
| Now on prod | `88ede7f` |
| Pull requests deployed | #21, #20, #23, #24 (release PR was #22) |
| Database migration needed | None — new tables and columns are made by the code at runtime |
| New settings to configure | None |

---

## Change 1 — Do not buy an option in the week it dies

### The problem

An option has an expiry date. In the last week before that date, the option
loses value very fast and moves in strange ways. You can be right about the
stock and still lose money on the option.

Before this change, the system always bought the nearest expiry. On the Monday
of expiry week, that meant buying a contract with two days left to live.

### What it does now

**From Monday 27 July, no new trade uses a contract that expires in the same
calendar week.**

July's expiry is Tuesday 28 July. So the "bad week" starts Monday 27 July. From
that Monday, every new entry uses the **25 August** contract instead.

The week runs Monday to Sunday, and it is calculated from the contract's own
expiry date as given by the exchange. So if a holiday moves an expiry, the rule
moves with it automatically. Nothing is hardcoded.

### Important: this only affects NEW trades

If you already hold something, nothing changes. It is not sold early. The exit
code, the stop-loss and the end-of-day square-off were checked line by line —
none of them look at expiry rules at all.

### Checked against the real contract file

| Thing checked | Result |
|---|---|
| Stocks with 3 expiry months listed (so there is somewhere to roll to) | **197 out of 206** |
| Stocks with only 1 month listed → correctly refuse to trade in expiry week | 2 (EXIDEIND, NUVAMA) |
| Stocks with no options at all in the file | 6 (HUDCO, PPLPHARMA, SAMMAANCAP, SYNGENE, TATATECH, TORNTPOWER) |

Those last 6 are an old mismatch between our stock list and the broker's file.
Not caused by this release.

### Did this affect any past trade?

**No.** All 23 recorded trades used expiry `2026-07-28` and were placed between
13 and 24 July. Expiry week starts 27 July. Not one trade falls inside it. If
this rule had existed all along, every trade would have been the same.

Nothing was open at the time of the release (18 closed, 5 failed, 0 open).

### The one thing to watch

An August option costs more than a July one, because it has more time left.

There is a limit on how much one lot may cost. It is not a separate setting —
it comes out of two other settings:

```
max loss allowed per trade  ÷  stop width  =  max cost per lot
        ₹2,500              ÷     25%      =      ₹10,000
```

If an August option costs more than ₹10,000 per lot, the system will **refuse
that trade**. That is the rule working correctly, not a bug.

**Expect fewer trade ideas than last week.** This could not be measured before
the market opened, because it needs live option prices.

---

## Change 2 — A typo could have switched off your stop-loss

This was the most dangerous problem found.

### What was broken

There is a setting for which AI model to use, called `MIMO_MODEL`. The code
checked that the name was valid, and threw an error if it was not.

The problem: the function that loads **all** settings — including your stop-loss
width, your daily loss limit and your square-off time — called that strict check.
And when it failed, its own emergency backup called **the exact same check
again**. So the backup failed too.

Both the 5-minute trading pass and the 5-second safety loop read settings
**before** doing their protective work.

So one wrong letter in a model name — `mimo-v2.5-pr0` instead of `mimo-v2.5-pro` —
would have stopped your **premium stop-loss, your target check and your
end-of-day square-off**, on every single tick, all day.

### What it does now

- Reading settings can never fail. A bad model name falls back to the default.
- The problem is recorded, and **only the AI part is skipped** — and only after
  reconciliation and the safety guard have already run.
- You get one Telegram alert and one audit record.
- Saving a valid model on `/auto-trade` fixes it instantly. No redeploy needed.
- Typing a bad name into the UI is still rejected, exactly as before.

There is a test in CI that recreates the exact failure and proves the safety
guard still runs.

---

## Change 3 — Read-only users could see your real positions

Some people can log in and view pages but not press any buttons. They were never
supposed to see what you are actually holding. Three separate leaks were found
and closed.

### Leak 1 — the scanner response

The scan result carried a list of held-position signals, built from your real
open trades. Removed for viewers.

### Leak 2 — the timing tooltips

Every 5-minute cycle records how long each step took. The "position guard" step
records what it did — and those messages contain the stock name, strike, call or
put, entry price, stop price and exit reason.

The page showed that text on screen and in the hover tooltip.

So a viewer could not see the position card, but could read the same facts one
hover away.

Viewers now see step names, durations and pass/fail. The text detail is removed.

### Leak 3 — the backup commentary (the sneaky one)

When the main AI does not write commentary — kill switch on, mode off, bad model,
AI failed — a backup writer runs instead.

That backup writer is handed the real book:

```
INFY 1600CE: OPEN (entry ₹50)
```

Stock, strike, side, entry price, exit price, exit reason.

But it saved itself as ordinary commentary, and the hiding rule only looked at
who wrote it. So viewers got the whole thing.

Now every commentary row is stamped with whether real position information went
into it, and hiding is based on that stamp.

**It hides by default whenever we cannot be sure** — if the lookup failed, if the
writer did not set the stamp, or if the row is older than the stamp itself.

**Side effect worth knowing:** on any day you actually trade, later commentary
becomes operator-only. On days with no trades, commentary stays public as before.

All hiding happens **only in what is sent out**. The trading engine still sees
everything, so position management is unaffected. Your own view is unchanged.

---

## Change 4 — A damaged contract file can no longer be trusted

### Why this matters

Every morning the system downloads a file from the broker listing every
tradable contract, its ID, its strike and its lot size. Orders are built from
this file.

Before, the file was trusted if it was dated today. If the download was damaged,
the system had no way to know.

Here is the dangerous version. Suppose the file is missing all the August
contracts:

1. July is blocked because it is expiry week.
2. August is not in the file.
3. The system picks **September** — three months out, when you wanted one.

That is a real, tradable contract. Nothing would look wrong.

### The four checks now in place

All of them run **before** the old file is replaced. If any one fails, the old
good file is kept.

| Check | What it catches |
|---|---|
| Fingerprint written in the same database transaction, with a row-count proof | The saved data not matching what was downloaded; a half-finished replace; two rows claiming the same ID |
| At least 10,000 option rows must be parsed | Almost all options missing (the real file has ~70,616; the thinnest single month alone is ~13,828) |
| Expiry months compared by **name, not count** | A whole month disappearing — including the sneaky case where July/Aug/Sep becomes July/Sep/Oct and the count is still three |
| Every `STOCK + CE/PE + MONTH` combination compared | **One stock losing one month on one side**, while every total still looks perfectly healthy |

That last check is the important one. A file can keep all three months, every
stock and 60,000+ rows while INFY alone loses just its August calls. The system
only ever looks at that one stock and that one side — so it would have jumped to
September for INFY and nobody would have noticed.

A stock disappearing **completely** is allowed. That is what happens when a stock
is removed from F&O trading, and mass disappearance is already caught by the
"underlyings must not drop more than 10%" check.

Months are matched as `YYYY-MM`, so a holiday moving 25 August to 24 August is
still the same month, not a missing one.

### If a check fails

Nothing is destroyed. The old file stays. The system retries every hour and
sends you a Telegram alert naming exactly which check failed and the numbers.

**What still works:** selling open positions, stop-loss, target, square-off,
price recording, the scanner, commentary.
**What stops:** buying anything new.

You can never get stuck holding something, because selling does not use this
file at all.

There is deliberately **no override button**. A "skip the safety check" button is
exactly the thing that gets pressed at 09:50 under pressure and buys the wrong
contract.

---

## Change 5 — A restart during market hours no longer kills the day

Before: if the server restarted at 09:25, it still had yesterday's contract file,
and the refresh only ran when the market was closed. No new trades for the whole
session.

Now the refresh runs at startup and again before each live capture. It holds a
lock so two copies cannot download at once. It retries hourly and alerts on
failure, with a second alert when it recovers.

---

## Change 6 — Smaller AI prompts (cost, not behaviour)

When there is nothing new to buy, the AI gets a shorter prompt with only the four
position-management tools. The buy tools are not even offered to it.

The real position stays the single source of truth for contract, entry, stop and
target — scanner data can never overwrite it. A held stock keeps its OI, VWAP and
trend evidence even after it stops appearing in the scan.

---

## Change 7 — Release pull requests now get tested before merge

The test workflow only ran for pull requests into `main`. The deploy pull request
goes into `prod` — so it showed **zero checks**, and the exact code being deployed
was only tested *after* the merge had already started publishing.

Fixed. Publishing is still locked to a real push to `prod`, so a test run can
never publish by accident.

---

## What did NOT change

- No change to entry rules, stop width, profit target, position size, trade
  limits, daily loss limit or square-off time
- No change to the 25% option stop or the ₹2,500 per-lot risk limit from PR #18
- No change to how the scanner picks or scores stocks
- No change to the commentary writing style prompt
- No new third-party library
- No risky database operation
- **No effect on any trade already taken**

---

## Numbers that were actually measured

Everything below came from the live database, not from estimates.

| Measurement | Value |
|---|---|
| Option rows in the contract file | 70,616 (Jul 29,908 / Aug 26,880 / Sep 13,828) |
| Distinct stocks with options | 210 |
| Stocks with 3 / 1 / 0 expiry months | 197 / 2 / 6 out of 206 |
| Cost of the file-freshness check | 88 ms average, over 80,930 rows |
| Times that check runs per scan | 13 (once per shortlisted stock) ≈ 1.1–1.5 s added |
| Recorded trades vs expiry week | 23 of 23 outside it |
| Open positions at release time | 0 |

### Not measured — stated as reasoning only

1. **"August options cost more, so fewer stocks will fit the ₹10,000 limit."**
   True in principle, but it needs live option prices. Unverified.
2. **"Three expiry months are always listed."** Only one day of contract-file
   history was available. The checks were built to tolerate a month rolling off
   and a new month appearing late, and both cases are tested — but it could not
   be proven from data.
3. **The tooltip leak.** The code path was traced completely and is definitely
   real. But no actual leaked example exists in the stored history — every
   recorded guard step says "no exits due", because those cycles had no open
   positions.

---

## Testing done

The full CI job was run locally on the combined code, not just per pull request:

```
db:generate · typecheck · typecheck:scripts · lint
verify-quant-shadow            verify-option-resolver-store
verify-priority-refresh        verify-freshness-gate
verify-ai-decision-context     verify-priority-refresh-store
verify-auto-target-stream      verify-auto-trade-store
verify-auto-trade-settings-safety
verify-rfactor-v2              verify-rfactor-v2-store
```

Plus the money-path bench that CI cannot run because it needs a real database:

```
scripts/verify-auto-trade.ts  →  ALL CHECKS PASSED
```

The local database was compared before and after that bench. Row counts for
`auto_trades`, `auto_orders`, `auto_decisions`, `auto_trade_settings` and
`trade_suggestions` were unchanged, and the runtime mode was restored.

GitHub Actions was green on every merged commit and on the exact deployed
commit, including the Docker build and the container start-up test.

**One honest note:** the local database was re-graded during the analysis phase
of this session. That is local only — `db:pull-prod` copies one way, production
to local. Nothing written locally can reach production.

---

## A mistake made and caught during this work

The first version of the month check compared **how many** months were present,
not **which** ones:

```ts
if (parsedMonths.length >= existingMonths.length) return { ok: true };
```

So July/Aug/Sep becoming July/Sep/Oct passed — three months either way, with
August silently gone. That is exactly the failure the check existed to prevent.

It was caught in review, fixed to compare names, and a test was added for that
precise case. Recorded here because it is the kind of bug that looks correct at
a glance.

---

## Still open — none of these can place a wrong order except item 4

1. **Dev machines do not repair themselves.** The auto-refresh only runs when
   `AUTONOMOUS_SERVER=true`. On a laptop, contract lookups fail until someone
   clicks re-sync manually.
2. **The freshness check repeats per stock** — about 1.1–1.5 seconds per scan
   spent re-proving the same fact. Should be proven once per scan.
3. **Failed contract lookups are not saved.** You cannot ask later why a stock
   appeared with no tradable option.
4. **No strike-distance limit — this one CAN pick the wrong contract.** The
   system picks the closest strike left in the chosen month, without checking how
   far that strike is from the current price. A damaged month that kept only
   far-away strikes would produce a very out-of-the-money option. This existed
   before this release; the new checks make it much less likely but do not remove
   it. A distance limit is the next safety check to add.
5. **`insertCommentary()` treats a missing privacy stamp as public.** No leak
   today, because both writers set it correctly. But it fails the wrong way, which
   is the same bug class fixed twice above. One-line fix.
6. **`forceSync()` has no in-process lock.** The database lock lets the same
   process re-acquire its own lock, so two calls inside one process could both
   run, and the first to finish releases the lock while the second is still
   downloading. The result stays correct — the replace is transactional and the
   last writer wins — so the cost is a wasted download, not damage.
7. **AI reasoning is switched off for tool calls**, following Xiaomi's advice
   that reasoning-on tool calls can produce broken output. Not proven to make the
   same decisions. A side-by-side comparison is the honest way to settle it.

---

## Two settings that are your decision, not code

These live in the production database, not in git. The values in the code are
different (`mode: off`, ₹5,000 daily loss limit).

- **`dailyLossHaltRupees` is ₹2,500 — exactly the same as one trade's maximum
  loss.** So one full stop-loss ends the trading day. Our own project notes say
  this number should be higher than one trade's loss. Real example: SRF lost
  ₹1,610 on 23 July and INFY lost ₹680 on 24 July. Together that is ₹2,290 —
  ₹210 away from shutting the day down.
- **Auto-trade mode is `paper`** (set 24 July, 12:35 IST). Trading is simulated
  until this is changed.

### The related question the user raised

The user funded ₹20,000 and asked why one lot is limited to ₹10,000. The limit
is not a rule anyone typed in — it falls out of ₹2,500 risk ÷ 25% stop.

Setting the per-trade risk limit to ₹5,000 would allow a ₹20,000 lot. But then a
stop-loss costs ₹5,000, against a profit target of about ₹1,100. Over 23–24 July
the average win was ₹1,123 and the average loss was ₹1,145 — so one ₹5,000 loss
would erase four wins.

**If position size goes up, the profit target has to go up with it.** This
decision was left open.

---

## Checks to do on the box that GitHub cannot do

- `AUTONOMOUS_SERVER=true` is set
- A Telegram alert channel is configured
- The first start-up log shows the contract file refresh succeeded:
  `[FyersPoller] master-contracts catch-up completed: <n> rows in <t>s`
- The stored auto-trade mode is what you intend
- The stored daily loss limit is what you intend

**Do this the evening before a trading day, not at 09:20.** On the first start
after this release, the system re-downloads the contract file and every lookup
correctly fails until it finishes. That is by design — but you want to see it
happen while the market is closed.

---

## Honest summary

Nothing in this release makes money. It stops specific ways of losing it:
buying a dying contract, a typo switching off your stop-loss, a damaged file
buying the wrong month, and other people seeing your positions.

The trading edge is unchanged. 23 and 24 July produced +₹4,445 across 8 trades
with 6 wins. That is two days. The average win (₹1,123) and average loss (₹1,145)
are almost equal, so the result depends entirely on the win rate holding up.
Two days is a good sign, not yet a pattern.

---

# Addendum — 27 July 2026: roll verified on real data, plus a follow-up PR

Written the morning the roll first fires. Everything below is measured, not
predicted.

## The roll was replayed against the real contract file before the open

The actual policy functions were run against the real `master_contracts`
snapshot (`syncDate 2026-07-26`, 210 F&O underlyings, 70,616 option rows):

| Trade date | What the code picks |
|---|---|
| Fri 24 July | **28 July** (4 days left) for all 210 names |
| **Mon 27 July** | **25 August** (29 days left) for **208** names |
| Tue 28 July | 25 August for 208 names |
| Wed 29 July | 25 August for 208 names |

The July contract itself, day by day:

```
2026-07-24 -> allowed
2026-07-27 -> REFUSED: expires this calendar week on 2026-07-28 — use next month
2026-07-28 -> REFUSED: same
2026-07-29 -> REFUSED: contract expired on 2026-07-28
```

**The roll works.** It flips on Monday, not on expiry day, which is the whole
point of the change.

### The two names that get refused entirely

`EXIDEIND` and `NUVAMA` have **only** the 28 July contract listed — no August,
no September, and their futures are July-only too. So from Monday they have no
eligible contract and the code refuses them.

That is the correct, safe outcome (refuse rather than guess), and it is 2 names
out of 210. Coverage across the universe:

| Months listed | Underlyings |
|---|---|
| 3 (normal) | 207 |
| 2 | 1 |
| 1 (untradable from Monday) | 2 |

If either name later starts trading normally on the exchange while still showing
one month here, that is a download problem — check `/trading-lab/master-contracts`
before assuming it is an exchange decision.

## The "build an expiry calendar table" proposal — declined, with numbers

An architecture review suggested replacing the contract-file logic with a small
hand-maintained expiry table ("last Tuesday of the month"), on the belief that
we scan 70,000 rows on every trade.

**We do not.** Measured on the real database:

| Step | Cost |
|---|---|
| Get a symbol's listed expiries | **0.427 ms** (warm, averaged over 1,000 calls) |
| Get the nearest strike + security ID + lot size | **0.199 ms** |
| **Total per symbol** | **~0.63 ms** |

The query plan confirms it uses an index and never scans the table:

```
SEARCH master_contracts USING INDEX
  master_contracts_underlying_expiryDate_optionType_strikePrice_idx (underlying=?)
```

For INFY it returns three dates — `2026-07-28, 2026-08-25, 2026-09-29` — which
is *exactly* the table the review wanted written by hand. The exchange already
sends it, through Dhan, every day.

Three reasons it was declined:

1. **It creates a second opinion you can never act on.** If the table says
   25 August and the contract says 24 August, you must buy the contract. A
   source you always overrule is not a source.
2. **"Last Tuesday" is an exchange rule that has changed before.** Hard-coding
   it means it breaks silently, on a day you are holding something.
3. **It would not remove any work.** Step 2 (strike, security ID, lot size)
   still needs the same table.

The 70,616 figure is real but belongs to the once-a-day download integrity
check, which never runs during a trade.

The separation the review asked for already exists:
`selectOptionExpiryForEntry()` is a pure function with no database access; the
contract lookup is a separate query; and `checkOptionExpiryForEntry()` re-checks
the contract's own expiry inside the order gate as the last step before money
moves.

## PR #27, part 1 — a configuration label that was lying

`/config` had a setting called **"Commentary entry cutoff"**, described as only
affecting what the AI writes. It is also a hard block on real orders:

```
hardEnd = min(entry window close, this cutoff − 1 min, square-off − 1 min)
```

Both the AI path and the human-approval path load it before placing an order.

**It is not biting today.** Entry close is 12:15 and the cutoff caps at 12:29,
so the tighter one — your own setting — wins. The trap is widening the entry
window past 12:29 and being silently capped anyway.

Fixed by renaming the label to **"Hard fresh-entry cutoff — blocks REAL orders"**
and spelling out the interaction on both clock settings. The stored key was left
alone on purpose: renaming it would orphan the saved value and silently reset the
cutoff to its default.

The review's alternative — remove the cutoff from the gate — was rejected. That
loosens a working safety rail to fix a naming problem.

## PR #27, part 2 — commentary rows were stored as public

The **reading** side already failed private. The **writing** side did not: an
omitted flag stored `0` (public), and both auto-trader writes omitted it. So the
rows containing real fills, stop moves and open premiums were stored as public.

**Nothing leaked**, because redaction separately checks
`promptKey === 'auto-trader'` and caught every one. But that is a lucky second
check, not the design — `containsExecutionState` is the field the redaction is
named for, and removing the redundant check in a future tidy-up would have
published the book.

Fixed: an unclassified writer now stores private, both writers say so
explicitly, and a test pins all three cases. No trading code touched.

## Proof that none of this can affect today's session

| Question | Answer |
|---|---|
| What is production running? | `88ede7f` |
| Is PR #27 in `main` or `prod`? | No / No |
| What does `main` have beyond `prod`? | One commit — this document. No code. |

Both branches: `typecheck`, `typecheck:scripts`, `lint`,
`verify-quant-shadow`, `verify-auto-trade`, `verify-ai-decision-context` all
green locally, and CI reports `validate: success` and `build: success` on both
head commits.

Neither is deployed. Today's session runs the same code as 24 July, plus the
expiry roll that was already live in `88ede7f`.

## Local database caution discovered today

The local `trade_commentary` table has 753 rows and **no
`containsExecutionState` column** — the column is added lazily on first write,
and local has not run that path. Production added it on its first commentary
write after the release.

So for this table, local is **not** a mirror of production. Do not use a local
schema check to conclude anything about the live one.
