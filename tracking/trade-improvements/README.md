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
positive signal, but the bigger lever looks like **entries** — the results
suggest many losing picks didn't produce enough favourable movement for the
tested +1R protection rules to rescue them. (Pinning down *exactly* how many
reached +1R needs a dedicated trigger-count metric we don't record yet — the
`saved`/`hurt`/ΔR figures alone don't prove it.)

| Doc | What it covers |
| --- | --- |
| [`honest-grading.md`](honest-grading.md) | Why the old win-rate was misleading, and the new **path-dependent grader** that walks the candles in time order (stop-before-target = a loss, even if it recovers). Turned an optimistic scorecard into an honest **10% win / −0.47R**. |
| [`profit-protection-shadow.md`](profit-protection-shadow.md) | A **measurement-only** what-if calculator that re-runs the same graded picks under "move the stop up once in profit" rules (breakeven / trailing) to see whether they'd have helped. Now shown on the `/trade-suggest/history` page. Includes a safeguard that stops old and new numbers being mixed, plus the honest, tiny-sample caveats. |
| [`docker-multistage-image.md`](docker-multistage-image.md) | **Infrastructure, not trade logic.** Makes the packaged app the live server downloads ~296 MB smaller (the build-only compiler tools are no longer shipped inside it), plus a safer, locked-down build pipeline. The running app is unchanged. |

## Ground rules these docs follow

- **Measurement never changes trading.** The shadow simulator and the grader are
  read-only. No stop is moved, no entry is taken because of anything here.
- **Honest over flattering.** A grade that can't be trusted (a 5-minute blind
  spot) is excluded from the win-rate, not counted as a win.
- **No live rule on a tiny sample.** ~30 graded picks is *direction*, not proof.
  Any exit-rule change waits for far more resolved picks.
