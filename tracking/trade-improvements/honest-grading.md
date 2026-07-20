# Honest grading — the path-dependent scorecard

Done 2026-07-20 (shipped in **PR #4**, merged to `main`). This fixes a scorecard
that was quietly *overstating* how well the scanner's picks did, so every
downstream decision (including "are our exits bad?") was built on a number we
couldn't trust.

**Measurement only** — this changes how we *score* past picks, not how any trade
is entered or exited.

## 1. The problem — the old win-rate could call a loss a win

Every `/trade-suggest` pick stores a spot-level plan: an entry, a stop-loss
level, and a target level. After the market closes we replay that day's 5-minute
candles to see what happened.

The **old** method looked at the whole day at once:

- `maxUp` = the highest the price got all day
- `maxDown` = the lowest the price got all day

…and said "target hit" if `maxUp` reached the target, "stop hit" if `maxDown`
reached the stop. The bug: **it ignored the order things happened in.**

> Real example of the trap: a pick drops to its stop at 10:00 (a real −1 loss you
> would have taken), then rallies past its target at 14:00. The old method sees
> "target was reached" and books it as a **win**. In reality you were stopped out
> hours earlier. This is called a *path-independent* grade, and it flatters the
> record.

Because of this, the win-rate looked better than the trades actually were — and
that directly muddied the answer to "is our exit strategy bad?"

## 2. The fix — walk the candles in time order

`lib/trade-suggest/grade.ts` → `gradeSpotPath(...)` now steps through the
5-minute candles **in chronological order** and returns whichever level was
touched **first**:

| Outcome | Meaning |
| --- | --- |
| `target` | Price reached the target before ever touching the stop → a real win (+RR in R). |
| `stop` | Price touched the stop first → a real loss (−1R). |
| `timeout` | Neither level was hit by the close → graded at where it closed. |
| `entry-ambiguous` | The suggestion came *mid-candle* and that same candle already touched the stop or target — we can't know the order within a 5-min bar, so we refuse to guess. |
| `incomplete` | The candle history has a gap, or the last candle of the day is missing — a late exit could be hidden, so we don't claim a result. |

Two honesty rules matter most:

1. **If a single candle touches BOTH the stop and the target, the stop wins.** A
   disciplined trader's stop fills first; crediting the target would be wishful.
2. **Blind spots are excluded, not counted.** `entry-ambiguous` and `incomplete`
   are left *out* of the win-rate entirely — we never pad the record with a
   result we can't stand behind. They surface separately as "unresolvable".

"R" throughout means **multiples of the trade's own risk**: the stop is −1R, the
target is +RR (reward ÷ risk, usually ~+2R), a timeout is graded by where it
closed relative to entry.

## 3. What it revealed

Graded honestly over the resolved picks (the retained ~20-session window):

```
30 honest (resolved) picks
win 3/30  = 10%
avg R     = −0.47R
avg favourable move 1.36% · avg adverse move 1.42%
```

That is a sobering, **honest** baseline — and the correct starting point for
asking "would better exits fix this?" (answered in
[`profit-protection-shadow.md`](profit-protection-shadow.md)).

## 4. Where it shows up

- **`/trade-suggest/history` (the Trade Log page)** — the **Outcome** column shows
  `target` / `stop` / `open` per pick, and the **Modeled P/L** is the plan
  outcome (target → +₹5,000/lot; stop → loss capped at ₹1,500/lot). It is
  explicitly labelled *Modeled* because it is the plan's result, **not** a real
  broker fill.
- The timestamp beside the outcome is the **end-of-day grading time**, not the
  exact minute the level was hit (a 5-minute candle can't tell us the exact
  second) — the tooltip says so.

## 5. Re-running past days (regrade)

Fyers 5-minute candles are retained for the newest **~20 sessions**
(`FYERS_CANDLE_RETENTION_SESSIONS`), so any grader fix can be re-applied to that
retained history:

```bash
npx tsx scripts/regrade-suggestions.ts
```

This replays each retained date, re-writes the outcome columns, and prints the
honest scorecard. It is idempotent and **preserves the original grade time** (a
regrade refreshes the verdict but not the "when we first graded it" stamp).

Dates older than the retention window can no longer be regraded — their candles
are pruned — which is a deliberate storage limit, not a bug.

## 6. Honest caveats

- **Level-fill assumption.** A stop/target is credited at its exact level. Real
  fills can be worse on a gap. We accept this because it's applied consistently
  (see the shadow doc — it cancels out when comparing rules).
- **5-minute resolution.** Within one candle we can't know tick order; that's why
  the two blind-spot outcomes exist rather than a forced guess.
- **Small sample.** 30 resolved picks is enough to *stop fooling ourselves*, not
  enough to make strategy promises.

## 7. Verification

- `npx tsx scripts/verify-quant-shadow.ts` — pure, DB-free checks incl.
  stop-before-target = loss, both-in-one-candle = stop, blind-spot detection.
  Runs in GitHub CI (typecheck + lint + this).
- The history page reads these stored grades directly, so the UI and the backend
  scorecard always agree.
