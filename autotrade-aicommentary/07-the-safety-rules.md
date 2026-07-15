# Lesson 07 — The Safety Rules

This is the heart of the system's trustworthiness. Every rule below lives in
code (`lib/auto-trade/risk/gates.ts` and the position guard), runs on every
order attempt, and cannot be talked around — not by the AI, not by a bad
prompt, not by a bug in a page.

## The entry gates

Before ANY entry order is placed, all of these must pass:

| Gate | The rule | Why it exists |
| --- | --- | --- |
| Mode | Auto-trade must not be OFF, kill switch must not be on | The operator's master switches |
| Time window | New entries only **09:45–11:00 IST** | Fresh signals + a full day for the trade to work |
| Square-off horizon | Nothing new at/after **15:12** | Nothing held overnight, ever |
| Trade count | Max **3 trades per day** (setting) | A bad day stays a small bad day |
| Open lots | Max **2 lots open** at once | No pyramid of positions |
| Capital cap | Deployed premium may not exceed **₹25,000** (setting) | Hard budget — the app can't "go big" |
| Daily loss halt | Realized loss ≥ **₹2,500** → no more entries today | Stops revenge-trading after losses |
| No re-entry | A symbol traded today can't be traded again today | No doubling down on the same story |
| Slippage | Premium moved > **4%** since the scan quote → reject | Don't chase a price that already ran |
| Liquidity | Bid-ask spread > **8%** → reject | Illiquid contracts are traps |
| Has a stop | The plan must include a spot stop-loss | Unmanaged trades are not allowed |
| Broker funds | For REAL orders: balance must be verifiable | Never assume money is there |

## Fail-closed: the most important idea on this page

**When the system can't verify something, it refuses — it never assumes.**

- A number arrives corrupted (not-a-number)? The gate rejects the whole
  attempt. (In JavaScript, comparing anything to NaN quietly answers "false" —
  which would have silently *passed* several checks. The gates catch this
  explicitly and fail closed.)
- The broker can't report available funds? Real orders are blocked.
- Slippage can't be computed because the scan quote is missing? Blocked.
- No live quote for a paper fill? The fill fails — never a made-up price.

The general principle: **a missing safety answer is a "no", not a "probably fine".**

## Rules for trades already open

- **Stops may only tighten.** A bullish trade's stop may only move UP, a
  bearish one's only DOWN. "Give it more room" is structurally impossible.
- **The position guard runs before the AI every cycle**, and also under the
  kill switch. It checks: premium stop, premium target, spot stop, spot
  target, and the 15:12 square-off. It's plain code — it works when the AI is
  down, confused, or disabled.
- **Exits are always allowed.** Every time gate applies to entries only;
  getting OUT of risk is never blocked.

## Layers above the gates

- **Two-key rule for live money:** switching to `live` mode requires BOTH the
  setting on the page AND an environment variable (`AUTO_TRADE_LIVE_ENABLED`)
  set on the server. One click can never take the system live. (`approval`
  mode's second key is the human tap on each order.)
- **Kill switch:** one toggle stops all new orders instantly; the guard keeps
  managing exits.
- **Idempotency keys:** every order carries a unique fingerprint, so a retry
  after a network hiccup can never place the same order twice.
- **Order APIs vs prompts:** none of these rules exist "in the AI's
  instructions". The instructions repeat them as guidance, but the enforcement
  is code — the tool that places orders re-runs the gates itself.

## How we know the gates work

A bench script (`scripts/verify-auto-trade.ts`) runs **34 automated checks**
over the gates, sizing math, settings clamps, and a quiet engine pass — it's
run before trusting any config change. And the replay in Lesson 06 re-ran a
real day's entries through the real gate code, byte for byte.

## Under the hood — the code behind this lesson

| Concept | Method (file) | What it does |
| --- | --- | --- |
| The entry gates | `checkEntryGates(input)` in `lib/auto-trade/risk/gates.ts` | ONE pure function holding every gate in the table above. Takes all facts as inputs (time, counts, money, quotes), returns allow/deny + the reasons. Pure = no database, no clock — fully testable and replayable |
| Stops only tighten | `checkStopMove(direction, currentStop, newStop)` (same file) | Bullish: new stop must be HIGHER than the old; bearish: LOWER. Anything else refused |
| The watchdog | `runPositionGuard(date)` in `lib/auto-trade/risk/position-guard.ts` | The deterministic exit loop — premium stop/target, spot stop/target, 15:12 square-off |
| The proof | `scripts/verify-auto-trade.ts` | The 34-check bench that exercises the gates with normal, edge, and corrupted inputs |

### The fail-closed maths (the NaN trap)

This is the sneakiest bit of arithmetic in the whole app, so here it is
slowly. In JavaScript, a broken number is `NaN` ("not a number"), and **every
comparison with NaN answers false**:

```text
NaN > 660  → false        NaN <= -2500 → false
```

Now look at a gate like "block if minuteIST > 660 (past 11:00)". If
`minuteIST` arrived corrupted as NaN, the comparison answers false — meaning
**"not past 11:00" — the gate silently passes!** The same trap would let a
corrupted P&L slip past the loss halt.

So before any gate runs, `checkEntryGates` validates every numeric input with
`Number.isFinite()`. One corrupt number → the whole attempt is rejected with
`corrupt numeric input(s): … — failing closed`. A broken sensor stops the
machine; it never gets to vote "everything's fine".

---

**Next:** [Lesson 08 — Brokers and Modes](08-brokers-and-modes.md) — paper,
approval, live, and how an order physically reaches a broker.
