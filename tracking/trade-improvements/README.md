# Trade Improvements

Docs explaining changes made to **how we measure and improve trade quality** —
the scorecard, the exit rules, and the evidence behind any change we'd ever put
live. Everything here is **measurement-first**: we prove a change helps on real
recorded data *before* it can touch a live entry or exit.

The trigger for this whole effort was the feedback in `../20-7.md`:

> "your exit strategy is not good — we saw profits and yet u made me loss in the
> last 2 days"

That is a claim about **exits**. To answer it honestly we first had to stop the
scorecard from lying to us (doc 1), then measure whether smarter exits would
actually have helped (doc 2). The short answer: smarter exits show a small
positive signal, but the bigger lever looks like **entries** — most losing picks
never reached the +1R level where a "move the stop up" rule could have rescued
them (which is different from saying they never got into profit at all).

| Doc | What it covers |
| --- | --- |
| [`honest-grading.md`](honest-grading.md) | Why the old win-rate was misleading, and the new **path-dependent grader** that walks the candles in time order (stop-before-target = a loss, even if it recovers). Turned an optimistic scorecard into an honest **10% win / −0.47R**. |
| [`profit-protection-shadow.md`](profit-protection-shadow.md) | A **measurement-only** simulator that re-runs the same graded picks under "move the stop up once in profit" rules (breakeven / trailing) to see if they'd improve results. Now visible on the `/trade-suggest/history` page. Includes the model-version safety and the honest, tiny-sample caveats. |
| [`docker-multistage-image.md`](docker-multistage-image.md) | **Infra/deploy, not trade logic.** Multi-stage Docker build that drops the ~296 MB compiler toolchain from the deploy image, a slimmer build context, and CI hardening (least-privilege token, SHA-pinned actions + Dependabot, pinned `tsx`). Runtime behaviour unchanged. |

## Ground rules these docs follow

- **Measurement never changes trading.** The shadow simulator and the grader are
  read-only. No stop is moved, no entry is taken because of anything here.
- **Honest over flattering.** A grade that can't be trusted (a 5-minute blind
  spot) is excluded from the win-rate, not counted as a win.
- **No live rule on a tiny sample.** ~30 graded picks is *direction*, not proof.
  Any exit-rule change waits for far more resolved picks.
