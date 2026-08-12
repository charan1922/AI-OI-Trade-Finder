# TF selector: ranking fix, board rework, and the sector decision

**Date:** 2026-08-13
**Status:** implemented and deployed
**Authorisation:** operator delegated these decisions ("take your own decisions, i am sleeping,
deploy once done"). No approval gate was available, so the reasoning is recorded here in full and
every judgement call is stated rather than assumed.

Follows on from `2026-08-13-tf-rfactor-selector-design.md` (v1.49.0).

---

## 1. The ranking defect — App R-Factor was still choosing the trades

**This was a real defect in v1.49.0, found in review the same day.**

The operator's instruction was explicit: *"dont consider App R-Factor, only consider TF R-Factor."*
v1.49.0 removed App R-Factor from the **gates** but left it deciding the **order**:

```
lib/trade-suggest/engine.ts   survivors.sort((a, b) => b.score - a.score)

WEIGHTS = { rFactor: 0.22, confidence: 0.08,   ← 30% App R-Factor
            oiUrgency: 0.18, oiLevel: 0.12,    ← 30% the OI stack the TF path bypasses
            orBreakout: 0.20, imbalanceAlign: 0.07,
            sectorBreadth: 0.08, setupStrong: 0.05 }
```

TF's R-Factor carries **zero weight** in that formula. Since auto-trade takes the top `MAX_PICKS`,
the selector correctly narrowed to TF race candidates and then re-ranked them by exactly the number
it was built to stop consulting. App R-Factor was still picking the trades.

**Fix.** On the TF path, preserve the selector's own order (TF R-Factor descending). The composite
score is still computed and stored as display evidence; it just stops steering the money. The
non-TF path (`USE_TF_SELECTOR=false`, the rollback) is untouched and still sorts by score.

```ts
if (tfBySymbol) {
  const tfOrder = new Map([...tfBySymbol.keys()].map((s, i) => [s, i]));
  survivors.sort((a, b) => orderOf(a) - orderOf(b) || b.score - a.score);
} else {
  survivors.sort((a, b) => b.score - a.score);
}
```

## 2. The TF Climbers board — it was hiding the strongest names

The card filtered to `rank-climb > 0`. **Rank-climb is a poor proxy for accumulation**: rank is
relative and capped, so a name already strong at the 09:35 baseline cannot climb and vanished
entirely, however much money kept arriving.

Measured against the real boards:

| | hidden from the card |
|---|---|
| 2026-08-11 | 6 of TF's top 20 — incl. LICI (#4, ΔR +0.39) |
| 2026-08-12 | 8 of TF's top 20 — incl. **PNB at TF R 4.33, second on the entire board** |

It failed the other way too: names that climbed early and then froze stayed on the list forever.
Frozen R measured **−0.286R (n=1160)** against **+0.474R** for surging names — so the filter
promoted the losers and hid the winners.

**Fix.** `boardAtMinute()` (new, pure, additive) returns TF's top-N ranked by R-Factor with no climb
filter, carrying `deltaR` as the signal and `climb` demoted to context. `raceAtMinute` is
**deliberately unchanged** — the trade selector calls it, and altering what the auto-trader sees is a
trade-logic decision needing its own measurement, not a display change.

The card now shows, per row: rank · TF R · **30-min rate** · move · verdict. Frozen names are
**dimmed, never hidden** — the operator should be able to see that TF's own #1 has stopped
accumulating, which is exactly what the old list concealed.

**Verdict column.** Each row is run through the real `selectTfCandidates`, so the board explains the
engine rather than guessing alongside it. Rows that fail show the **first** gate they fail, in the
selector's own checking order.

Validated against production data — the board now reproduces TradeFinder's own Intraday Boost
ranking exactly (PIIND 5.69, FORTIS 4.66, PNB 4.33, HAL 4.01, TMPV 3.73, IDEA 3.44, FORCEMOT 3.40,
TCS 3.21). The old card showed none of the top three.

### `lib/tf-live/context.ts` — a second, deliberate context builder

The scanner builds `TfSymbolContext` from LIVE quote rows; this one builds it from RECORDED data
(`fyers_candles` + `oi_intraday`). They are **not** merged, on purpose: a display card reading a live
quote against a previous session's retained board would silently mix two days — the exact bug the
closing-snapshot work exists to prevent. Everything is computed from bars strictly before the
decision bucket, so a verdict shown against a 10:30 board is the verdict available at 10:30.

## 3. Sectors — evidence, NOT a gate

The operator asked whether sectors are considered by `/auto-trade` and `/trade-commentary`. Honest
answer before this change: **almost not at all.** The only sector term was `sectorBreadth: 0.08` in
the composite score — a same-sector-peer count — and TradeFinder's own per-index R-Factor from
`/sector-scope` was not used anywhere.

**Decision: surface it, do not gate on it.** `getTfSectorBoard(date)` attaches TF's ranked sector
board to `tfContext`, which already flows to both the auto-trade AI (`context-policy.ts`) and the
commentary (`generate.ts`).

**Why not a gate.** There is no measurement that sector strength separates winners from losers. The
suggestive observation — PNB and CANBK topped TF's board on 2026-08-12 while PSU BANK was TF's #2
sector at +3.22 — is an anecdote, not evidence. Wiring an unmeasured signal into the money path
overnight, on a strategy already fitted to three sessions, is precisely what this repo's standing
discipline forbids. `verify-tf-selector.ts` now asserts the selector has no sector input, so a future
edit cannot quietly add one without tripping CI.

**Narration hazard, recorded deliberately.** These are R-FACTORS, not percentages. Handing a raw
`3.35` to a model invites *"BANK is up 3.35%"* — false, and the same class of fabrication
`describeOptionChain` exists to prevent (the dry-run bench once caught the model turning
`callOiChangePct: 74.3` into a price claim). **The prompts were therefore NOT changed tonight.**
Wiring sectors into narration requires converting to finished English first and re-running
`scripts/dry-run-commentary.ts`. That is the next step, not this one.

## 4. Operational finding — TF logs us out, and that stops trading

Captures on 2026-08-12 ran clean until **14:56 IST**, then every request failed (92 `all_sector`
errors, 617 `daily-index` errors, through 15:30). TradeFinder's own site was working — our capture
session was signed out. This is the documented daily logout.

**Consequence worth stating plainly:** `TF_BOARD_MAX_AGE_MIN = 10` means the selector refuses to
trade without a fresh board. Fail-closed is correct, but if `/tf` is signed out at 09:45 the
auto-trader takes **zero trades that session**. Checking `/tf` before the window is now an
operational precondition, not a nicety.

## 5. What was verified

- `pnpm lint`, `typecheck`, `typecheck:scripts`, `verify-dependency-hygiene`
- `verify-tf-selector.ts` — **56 checks**, including six new ones guarding this change: the
  climb-filtered race hides an already-strong name, the full board shows it and leads with the
  highest TF R, a non-climber gets `climb 0` rather than a fabricated jump, and the selector has no
  sector input
- All 15 `verify-*` benches, production build
- Live smoke test against the running app: `/api/tf/race` returns the 20-row board with verdicts and
  matches TradeFinder's published ranking

## 6. Unchanged on purpose

- `raceAtMinute` and `selectTfCandidates` — the trade path's own rules
- The premium stop, position sizing, risk gates, square-off
- `COMMENTARY_SYSTEM` and the auto-trader prompt (see §3)
- The composite score itself, which the rollback path still needs
