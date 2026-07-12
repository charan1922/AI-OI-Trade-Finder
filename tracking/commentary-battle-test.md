# Commentary battle-test — replaying the deployed loop on recorded sessions

Started 2026-07-12, on the user's directive: no blind prompt-faith — replay the
REAL Jul-10 session through the REAL pipeline with REAL MiMo calls, score
structure AND outcomes, iterate like an experiment loop (autoresearch-style),
and everything must run unchanged in the deployed /trade-commentary loop.

## The bench

`scripts/replay-commentary.ts` — for each 15-min tick of a recorded session:

1. **Scan reconstruction** — point-in-time SuggestResponse from `oi_intraday`
   (recorded live snapshots) + `fyers_candles` (5-min bars, point-in-time
   slices) + `bhavcopy_days` baselines, through the engine's own gate/score/
   plan math (mirrors `replay-lib.ts`'s replayVariant; production thresholds;
   breakout-bypass ON to match the deployed server's toggles; `tfBreakout`
   attached via lib/breakout; `option: null` — premiums aren't recorded, never
   fabricated).
2. **The real narrator** — `generateCommentary()` from `lib/ai-commentary/
   generate.ts`, prior reads carried exactly like `run.ts` (last 6). Nothing is
   stored to `trade_commentary`.
3. **Contract checks** — `lib/ai-commentary/contract-checks.ts` (shared with
   `scripts/eval-commentary.ts`): tables, ticker-first headings, verdict
   vocabulary, Bottom line, phantom positions.
4. **Grounding** — every price-scale number in the text vs THIS tick's scan
   JSON + prior reads.
5. **Outcomes** — follow the verdicts literally against the actual bars: enter
   on TRADE NOW (next 5-min close), stops move on MOVE SL, exits on EXIT NOW /
   SL touch / target touch / 15:25 square-off → points + R per trade.

Artifacts: `data/replay-commentary/run-<date>-<label>.json`, viewable at the
TEMP page **/replay-commentary** (run picker, per-read contract badges, verdict
chips, outcome table). Ledger: `tracking/commentary-replay-log.md` (one row per
run, auto-appended).

## Harness fix #1 (found by the dry run, shipped to PROD): the `tracked` feed

The recorded Jul-10 thread itself showed the bug: *"OFSS, KPITTECH — DROPPED
from screen entirely."* Once a pick falls below the gates it vanishes from
`suggestions` — the narrator goes BLIND on an open position and cannot call
the exit. Fix in the production engine (works identically on the server):

- `lib/trade-suggest/engine.ts` — earlier-today suggestions stay in the single
  batched quote request (≤ a handful of extra symbols, zero extra Dhan calls);
  new `SuggestResponse.tracked` = every earlier call + LIVE ltp + original
  entry/stop/target (`TrackedPosition` in types.ts).
- `lib/ai-commentary/generate.ts` — `tracked` forwarded in `trimForPrompt`;
  SYSTEM prompt teaches: manage open calls from `tracked` (ltp vs slSpot /
  targetSpot ⇒ EXIT NOW), never "dropped from screen".

## Iteration 1 (Jul-10, 21 reads, real MiMo) — structure clean, TWO real defects

Metrics: 21/21 reads, **0 structure fails, 0 ungrounded numbers**, avg 111
words, 10s avg latency. The new decisive prompt holds on real data. The model
correctly REFUSED to call TRADE NOW all day — the only candidate (KPITTECH)
had supertrend against it and OI outflow at every tick, and the 10:20 WATCH
read was textbook ("what flips it: supertrend up + OI positive on a 5-min
close above 563.50"). Honest stand-aside day.

But the thread exposed two defects the synthetic dry-runs never hit:

1. **Phantom position.** Having only ever said WATCH, the model started
   "managing" KPITTECH anyway: "you're a point underwater from 563.25 entry",
   then SEVEN "EXIT NOW" calls for a trade it never recommended. Root cause:
   the new `tracked` feed reads as a position list.
2. **₹/points unit salad.** "₹1 loss per point … per lot … per unit" —
   fabricated rupee framing on spot points.

## Fixes for iteration 2 (all in prod files)

- SYSTEM prompt: *a position EXISTS only after one of YOUR reads said TRADE
  NOW; `tracked` is a data feed, not a position list; never state P&L in ₹
  anywhere — points only* (generate.ts).
- Contract: phantom-position rule — HOLD / MOVE SL / EXIT NOW for a name with
  no prior TRADE NOW is a **FAIL** (contract-checks.ts, enforced in both the
  bench and the stored-rows eval).

## Iteration 2 — same parameters, fixes applied

21/21 reads, 0 structure fails, 0 ungrounded, avg 93 words (tighter). **Both
iter-1 defects dead**: no phantom position all day — the model stayed honest
("zero trades, zero risk … entry never triggered", correct end-of-day recap),
no ₹ fabrications. The WATCH reads name exact flip conditions with levels.

**New regression caught by the loop**: the model started wrapping headings in
bold — `**### KPITTECH — WATCH**` / `**### Bottom line**`. The page's section
splitter (and the bench parser, deliberately identical) only matches a
line-start `###` heading, so every section silently degraded to body text
(that's why all 21 reads warned "no Bottom line" and verdict chips came back
empty).

## Iteration 3 fixes

- SYSTEM prompt: headings are PLAIN lines — line-start `###`, never wrapped in
  `**`, never mid-line; `### Bottom line` exactly (generate.ts).
- Contract: malformed heading marker (`**###` / mid-line `###`) is now a
  **FAIL** (contract-checks.ts) — this regression class can't slip through
  silently again.

## Iteration 3 — converged

21/21 reads: **0 structure fails, 0 ungrounded numbers, no phantom position,
no ₹ fabrication**, plain parse-clean headings, verdicts extracted correctly
(10:20 `KPITTECH — WATCH` with exact flip conditions; 12:35 collapses to a
2-line stand-aside; 15:15 honest EOD: "We only WATCHED; no trade was ever
on... capital intact"). avg 102 words, 10s latency. 13 vocabulary warns
("no position", "still watching" headings) were checker-side, not model-side —
the WATCH verdict family now accepts them (contract-checks.ts); re-check of the
saved texts: **0 fails, 1 warn**.

## Final verdict

- The narrator contract holds on a full real session: decisive, grounded,
  plain-English, position-lifecycle-safe — and honest: Jul-10's only replay
  candidate (KPITTECH) never met the TRADE NOW bar (trend + OI against it all
  day), and the model correctly stood aside for 21 consecutive reads instead
  of manufacturing a trade. Zero TRADE NOW on a no-edge day IS the spec.
- The enter→manage→exit path is proven on the synthetic lifecycle bench
  (dry-run-commentary.ts: TRADE NOW → MOVE SL to 1430 with points-only P&L);
  the replay will exercise it on real data the first session where a pick
  clears the bar.
- Every change lives in the production files the deployed loop runs:
  `lib/ai-commentary/generate.ts` (prompt), `lib/trade-suggest/engine.ts` +
  `types.ts` (tracked feed), `lib/ai-commentary/contract-checks.ts` (contract
  as code). The bench (scripts/replay-commentary.ts + /replay-commentary page)
  is standing infrastructure — rerun it on any recorded session before
  shipping future prompt/harness changes.

## Phase 2 — PROD data (user: "the deployed app has all data")

Correct: the local Jul-10 recording began 10:19 (local server was off in the
morning) with 67 symbols; the deployed app recorded **09:21→15:20, 166
symbols**. `scripts/import-server-day.ts` pulls a day's `oi_intraday` from the
deployed app's read-only APIs into the local DB (INSERT OR IGNORE — real
recorded data, never clobbers local rows): 538 → 11,261 rows. Replay also now
mirrors the deployed server's ACTUAL toggles (checked via its /api/config/
toggles): breakout bypass ON **and extended-trend bypass ON** — the latter is
why CDSL/INDIANB stayed suggestible while extended on prod.

### Prod-data iterations — what the loop caught and fixed

| run | defect found → fix (all in prod files unless "bench") |
| --- | --- |
| iter4-prod | replay lacked prod's extended-trend bypass → mirrored (bench); model invented option strikes when `option:null` → prompt guard |
| iter5-prod | model treated the 09:40–11:00 window as an all-day entry BAN and "extended" as an absolute veto (contradicting the deployment's own bypass) + narrated 4-5 stale names/read → bar reworded (full-bar entries until ~14:30, extended = caution not veto, option-null never blocks), coverage capped (positions + ≤2 calls + ≤1 WATCH) |
| iter6-prod | **full lifecycle fired** (CDSL TRADE NOW 10:20 → MOVE SL → EXIT), but: EXIT wasn't final (model "corrected" an exit back to HOLD next read; repeated exit calls for closed names) → exit-finality rule in prompt + closed-position FAIL in contract; outcome-engine walker bug (re-walked entry bar with later stops) → cursor rewrite (bench) |
| iter7-prod | 6/23 reads died: MiMo empty content — reasoning exhausted `max_tokens: 3200` on full-universe scans (**would hit the deployed loop too**) → 6000; combined heading "INDIANB / PAYTM — can't touch" → one-ticker-per-heading rule; window-guidance contradiction resolved (open position ⇒ prefer managing, per the 1-2-trades rule) |
| **iter8-prod** | **converged: 22/22 reads, 0 fails, 0 warns** |

### Final state (iter8, following the calls literally on real bars)

- `CDSL — TRADE NOW` 10:20 (the deployed server's own morning pick) → HOLDs →
  **target hit 13:50, +13.4 pts** (model's own 14:05 EXIT came post-target).
- `DLF — TRADE NOW` 10:50 → EXIT 11:05 (fast invalidation); outcome engine
  refused the fill (price already beyond the stated stop — `skippedInvalidEntries`).
- `INDIANB — TRADE NOW` 13:05 (strong grade, mid-day) → trailed SL 848→869 →
  intrabar stop 13:15 at the original 850.35: **−14.8 pts, exactly −1R**.
- Net −1.4 pts on a churny day: wins on target, losses capped at −1R, exits
  final, no ghost coverage — the method's "small losses, take the chunk".
- Residual grounding suspects (5) are the model's self-chosen SL trail levels
  (848/853/…): stops are the trader's to place, so they're inherently not in
  the scan JSON — flagged by design, human-verified sensible (each below the
  concurrent price).

## Runs ledger (details per run on /replay-commentary)

| run | reads | struct fails | ungrounded | defects found → fixed |
| --- | --- | --- | --- | --- |
| iter1 (local data) | 21 | 0 | 0 | phantom position (7 fake EXITs), ₹/points unit salad |
| iter2 (local data) | 21 | 0 | 0 | bold-wrapped headings (`**### X**`) breaking the page split |
| iter3 (local data) | 21 | 0 | 0 | none — vocabulary alignment only |
| iter4–8 (PROD data) | — | 0 | see above | see Phase-2 table |

## Replay honesty notes

- Replay ≠ live exactly: recorded snapshots start 10:19, no bid/ask depth (the
  R-Factor spread factor reports unavailable), no per-tick OI-spurt list, no
  option premiums. The narrator contract is what's under test here; the
  ENGINE's pick quality has its own benchmark (scripts/replay-window.ts).
- Every number the narrator sees is real recorded data; the bench never
  synthesizes market values.
