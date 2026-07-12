# Commentary eval harness — scoring MiMo's narrations against their contract

Done 2026-07-12. Closes the gap identified in the AI-stack review (2026-07-11):
prompt changes to the trade commentary (e.g. the tfBreakout rules added to
`lib/ai-commentary/generate.ts`) had **no regression check** — a narration that
fabricates a price level, breaks the page's per-stock structure, or outputs a
forbidden markdown table was only caught by eyeball. Also from that review:
stay on the `openai` SDK (no LangGraph, no Vercel AI SDK — new-dep rule); the
assistant's tool-call cap + tracing already exist (`MAX_TOOL_STEPS = 8`).

## 1. What it is

`scripts/eval-commentary.ts` — read-only, no LLM calls. Replays every stored
narration in `trade_commentary` and scores it against (a) the SYSTEM prompt's
output contract and (b) the real data it was given (`picksJson` + the same
day's earlier reads).

| Severity | Check |
| --- | --- |
| **FAIL** (exit 1) | markdown table (`\| a \| b \|` rows / `\|---\|` — prompt forbids; the page only renders them defensively); stock heading not STARTING with the ticker (`### TICKER — …` is what the page's splitByStock keys on); heading ticker that is a real F&O symbol but was never in today's picks (hallucinated stock); empty text |
| **warn** | price-scale numbers (≥100 or ₹-prefixed) in a stock's section that match nothing in its picksJson or any earlier read today (potential fabrication, display-rounding tolerated); pick with no section; no "Bottom line" close; top-pick not the first section; picksCount ≠ picksJson length |
| **info** | word count far past the ~220 budget |

Small numbers (scores, slopes, urgency, %s) are deliberately NOT graded — the
scan JSON they came from isn't persisted, so grading them would be guesswork.
Inline pipes ("Scanned: 47 | Gated: 45") are legitimate and excluded — only
true table rows count (first version over-counted these; fixed).

Run: `npx tsx scripts/eval-commentary.ts [--date=YYYY-MM-DD] [--verbose]` —
exit 1 on any FAIL, so it's CI-able.

## 2. First run — real violations found (7 rows, 2026-07-10)

```text
4 FAIL · 2 warn-only · 1 clean
```

- **MiMo ignores the no-table rule**: 3 narrations contain genuine markdown
  tables (4–7 table rows each) despite the SYSTEM prompt's explicit "NEVER
  output a markdown table".
- **Decorated headings break the page split**: `### **Top Pick: OFSS CE 11700 —…**`
  and `### 🚨 OFSS CE 11600 — BREAKOUT TRIGGERED` don't start with the ticker,
  so `/trade-commentary`'s per-stock sections can't match them.
- **No `### Bottom line`** on the later reads (model used a "Reality check:"
  paragraph instead).
- **Ungrounded price levels** worth a look: e.g. 11593 / 11552 / 11674 / 426 in
  the 14:08 OFSS read match nothing stored — either fabricated or from
  unpersisted scan fields.
- **Store quirk**: the first two picked reads of the day have `picksCount > 0`
  but `picksJson = []` — the pick payload wasn't stored on those early rows.

## 3. SYSTEM prompt redesigned — decisive coach contract (same day)

The user's real complaint went past structure: the narrations were metric soup
with hedging ("Mixed bag", comparison tables, "three conflicting signals"),
when the need is **1–2 trades max, said with confidence, with explicit exits**.
The SYSTEM prompt in `lib/ai-commentary/generate.ts` was rewritten around a
verdict contract:

- Every read = one plain answer: heading `### TICKER — VERDICT` with VERDICT ∈
  **TRADE NOW · HOLD · `MOVE SL to <level>` · EXIT NOW · WATCH**; `### Bottom line`
  = the single instruction for right now ("Trade CDSL only." / "Stand aside.").
- **The bar for TRADE NOW** is data-derived (breakout confirmed + trend aligned +
  OI flowing in + not extended); one thing missing → WATCH with the exact flip
  condition; two+ missing → no section at all. Max one TRADE NOW (two only when
  both truly clean).
- **Position management first**: any name called TRADE NOW earlier today opens
  every later read with HOLD / MOVE SL / EXIT NOW; 15:10+ forces square-off;
  window-close awareness.
- **Plain English**: metrics translated ("fresh money still flowing in"), a
  number appears only when it IS the instruction (entry/stop/target/cost/level).
- Guards learned from dry-runs: never estimate open P&L in ₹ (spot points from
  entry instead); **always ONE lot** — no position sizing; ~150 words hard-max 220.

**Verified offline** with `scripts/dry-run-commentary.ts` — a prompt test bench
that sends a SYNTHETIC two-turn scan through the real `generateCommentary()`
(console-only, never stored; ~2 MiMo calls per run) and grades the output with
the eval harness's structure checks. Final run: both turns structure-clean,
turn 2 correctly opened with `### CDSL — MOVE SL to 1430` and protected the
gain. Re-run it after any future prompt edit.

## 4. Follow-ups

1. **Live verification on the next trading day** — the dry-run uses synthetic
   scans; re-run `eval-commentary.ts` on the first real rows generated with the
   new prompt (and eyeball the decisiveness on /trade-commentary).
2. The production instance (Railway) runs the old prompt until redeployed.
3. Investigate the early-rows `picksJson = []` mismatch in
   `lib/ai-commentary/run.ts`/`store.ts` (why did buildPicks yield nothing at
   10:22 when the same scan reported 2 picks?).
4. Optionally wire the eval into the nightly routine after each trading day.
5. Known residual model slip to watch on real rows: labeling spot points as ₹
   ("₹17+" for 17 points) — the eval's grounding check won't flag sub-100
   numbers, so this stays an eyeball item.
