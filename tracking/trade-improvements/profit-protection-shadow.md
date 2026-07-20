# Profit-protection shadow — "would moving the stop up have helped?"

Built 2026-07-20 → 21 across **PR #5** (the simulator) and **PR #6** (review
fixes + version safety + the UI panel). Both are merged into `main` and deployed
to `prod` (release `v1.24.0`).

**Measurement only.** Nothing here moves a stop, changes an entry, or alters a
live exit. It is a read-only *what-if* calculator whose entire job is to tell us
whether a smarter exit rule would be worth trying — **before** we ever risk money
on it.

## 1. Why this exists

Your feedback (`../20-7.md`): *"we saw profits and yet u made me loss."* Once the
[honest grader](honest-grading.md) gave us a trustworthy record, we could look at
the losers directly. The pattern we wanted to test: **a losing pick often ran up
into profit first, then gave it all back to the stop.** If that's common, a rule
like "once the trade is +1R up, move the stop to breakeven" would turn some of
those full losses into scratches or small wins.

The shadow answers exactly one question, with numbers instead of opinion:

> If we had applied a "move the stop up once in profit" rule to the **same** picks
> we already took, what would the results have been — better or worse?

## 2. What it simulates — `lib/trade-suggest/profit-protect.ts`

For each resolved pick it re-walks the same 5-minute candles the grader uses, and
applies a candidate **stop rule**. Three rules are tested (all *tighten-only* —
the stop can only ratchet toward profit, never loosen, matching your standing
"stops may only tighten" rule):

| Rule | Plain English |
| --- | --- |
| `breakeven@1R` | Once the trade is **+1R** in profit, move the stop to the entry price (so the worst case becomes ~break-even). |
| `breakeven@1.5R` | Same idea but wait for **+1.5R** before protecting (gives the trade more room first). |
| `trail@1R-lock0.5` | Once **+1R**, start trailing the stop, always locking in **half a unit (0.5R) below** the best price reached — ratchets up as the trade goes further. |

It is deliberately **honest and conservative**:

- **No looking into the future.** The protective stop that guards a candle is set
  from the best price reached *through the previous candle only*. A candle's own
  spike can never arm the stop that then "saves" that same candle — that would be
  cheating with hindsight.
- **A stop can't sit above the market.** If the arming candle already *closed*
  beyond where the new stop would rest, the exit is taken at the observable close,
  not at an impossible level.
- **Theoretical level-fill R.** Exits are credited at the stop level — the exact
  same assumption the baseline grader makes. Real gaps are ignored on *both*
  sides. Sharing that assumption keeps the baseline-vs-rule comparison
  *consistent*, but real gap slippage can hit the two differently and may not
  cancel exactly. These numbers are a *decision metric*, not a promise of live fills.
- **Target detected by price**, using the identical check as the grader, so the
  shadow and the baseline can never disagree on whether the target was hit.
- **One indivisible lot.** No partial exits (we trade one lot, so half-booking
  isn't real).

The output per rule is its **ΔR vs the fixed plan** — the average of the per-pick
differences `(rule result − plan result)` over the same picks. Positive ΔR means
the rule would have improved expectancy.

## 3. What it found (tiny, directional)

Honest baseline scorecard: **10% win / −0.47R** over 30 resolved picks. Each rule
is then compared to the plan over **its own paired picks** — the `n` differs per
rule because entry-ambiguous picks drop out for the rule whose trigger they
touched (so the ΔRs are *not* all measured over the same set):

```
Rule                n     ΔR vs plan    saved    hurt
trail@1R-lock0.5    25      +0.11         2        1
breakeven@1R        25      +0.08         2        0
breakeven@1.5R      29      +0.02         1        1
```

- **"saved"** = a pick the plan lost (baseline ≤ −1R) that the rule pulled back to ≥ 0R.
- **"hurt"** = a pick the rule made *worse* than the plan (scratched a wick that would have run).

So a trailing/breakeven stop shows a **small positive signal** — but with ~25–30
picks this is **not enough to tell a real edge from noise**; read it as direction,
not proof. And a precision caveat on the numbers: `saved` counts only picks that
were *rescued to ≥ 0R* — it is **not** the same as "how many losers reached +1R."
A pick can reach the +1R trigger yet still close below breakeven, be
entry-ambiguous, or end negative, so `saved = 2` undercounts trigger-reached (we
don't currently record a separate trigger count).

What we *can* say precisely, and it's the more important point:

> **Most losing picks never reached the +1R level these rules need.** You can't
> protect a profit the trade never built. (That is narrower than "never got into
> profit at all" — a pick could reach +0.3R and still not arm a +1R rule.)

That points the bigger lever at **entries** (picks going red before reaching +1R),
not exits — the natural next investigation, though "entries > exits" is a
direction this small sample suggests, not yet proves.

## 4. Where you see it — the `/trade-suggest/history` panel (PR #6)

Previously these numbers only printed in a terminal script. Now there's a
read-only **"Profit-protection (shadow)"** panel at the top of the Trade Log page:

- One row per rule: **Picks · Avg R · vs plan (ΔR) · Saved · Hurt**
- Header shows the baseline R and the model version
- An amber **"measurement only · never changes a live exit"** badge and a footnote
  spelling out the theoretical-fill and small-sample caveats

It's fed by `GET /api/trade-suggest?view=history` (a `protection` field from
`getProtectionStats`). It is **not** gated by `/config` — no toggle, no env var.

## 5. Model versioning — so numbers never silently mix (PR #6 review)

Each stored shadow result carries a version stamp (`_v`, currently **2**). This
matters because a session that ages out of the ~20-day candle window can **never
be regraded**, so its old-version numbers would otherwise linger forever. The
aggregator now **only averages rows written by the current version** and *counts*
the rest (`excludedLegacy` / `excludedOtherVersion`) so a shrinking sample is
visible, never hidden. If we ever change the simulator's math, old and new
numbers cannot be blended into one misleading average. We regraded all 4 retained
sessions, so today **29/29 stored blobs are `_v:2`** and nothing is excluded.

## 6. Honest caveats (read before trusting any of this)

- **~30 picks is direction, not proof.** Do **not** enable a live stop rule on
  this. It waits for *far* more resolved picks (the reviewer and I both drew that
  line).
- **Theoretical fills.** See §2 — real gaps could make both the baseline and the
  rules worse; the comparison stays fair, the absolute R does not promise live P&L.
- **The exit edge is small.** +0.11R best case — and the entry side looks like
  the bigger lever (a direction this sample suggests, not proof).
- **It never trades.** If this file ever seems to describe a live behaviour, that
  is a documentation error — the code has no path from here to an order.

## 7. How to re-run

These run from a **repo checkout** (with deps installed), not from the deployed
container — `scripts/` is `.dockerignore`d, so it is deliberately NOT in the prod
image. `tsx` is a pinned devDependency, so `pnpm exec tsx` is the reproducible
runner (`npx tsx` also works locally):

```bash
# Pure logic (no DB) — 38 assertions incl. no-lookahead, version enforcement:
pnpm exec tsx scripts/verify-quant-shadow.ts

# Regrade retained sessions + print the shadow table (points at ./data/project-r.db):
pnpm exec tsx scripts/regrade-suggestions.ts

# Read-only shadow report against a DB (prints version accounting):
pnpm exec tsx scripts/profit-protect-report.ts [--since YYYY-MM-DD] [--db path]

# Full DB roundtrip bench (persistence + regrade-preserves-time):
pnpm exec tsx scripts/verify-auto-trade.ts
```

To regrade the **prod** DB you point `--db` at a copy of the box's
`project-r.db` from a repo checkout — there is no in-container path, since the
scripts aren't shipped in the image.

All green as of PR #6 head: typecheck, lint, 38 pure checks, auto-trade DB bench.

## 8. Open items

1. **Investigate entries** — the real lever. Why do so many picks go red
   immediately / never reach +1R? This is the highest-value follow-up.
2. **Accumulate resolved picks** — the shadow only becomes decision-grade after
   dozens of graded picks; keep letting the EOD review fill it in.
3. **Only then** consider whether a breakeven/trailing rule earns a live toggle —
   with a proper A/B, not this small sample.
