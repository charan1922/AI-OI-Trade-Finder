# Lesson 04 — The Scanner

The scanner (`lib/trade-suggest/engine.ts`) is the part that answers: *"out of
~50 stocks, which 2–3 are worth the AI's attention right now?"* It is pure
rules — no AI, same input always gives the same output. It runs every 5
minutes from 09:40 to 11:00.

## The idea it hunts for

Before a stock makes a big move, someone usually *positions* for it: open
interest builds up beyond normal, options activity swells, the price starts
pressing against its morning range. The scanner looks for that **fingerprint
of quiet accumulation** — and then insists the price itself confirms the
direction before suggesting a trade.

## The gates, in order

Think of it as a funnel. A stock must pass EVERY gate:

1. **Unusual participation** — R-Factor must be at least **3.6** (on the 1–8
   scale), with directional agreement between its factors. Translation: the
   stock's activity today must be clearly abnormal, and the clues must point
   the same way.
2. **Real OI build** — futures OI at least **1.1× the 20-day average**, and
   NSE's live feed showing combined OI up at least **5%** today. New money must
   actually be entering.
3. **Options-led path** (for stocks where the buildup is in options rather than
   futures): options must be at least **10%** of the activity and the options
   premium traded must be at least **₹5 crore** — big enough to matter, not
   retail noise.
4. **Tradeable contract** — the option the app would actually buy must be
   liquid: bid-ask spread within limits, enough days to expiry, and **one lot
   must fit the capital budget**.
5. **Direction & timing checks** — where is price versus the opening range,
   VWAP, and Supertrend? A stock "extended" too far from its open gets
   penalized (chasing a move that already happened is how you buy the top).
6. **A survivable plan** — the scanner computes the full trade plan (entry,
   spot stop, spot target, premium stop, premium target) and requires roughly
   **2× reward-to-risk**, with the worst case capped near **₹1,500 per lot**
   and the goal near **₹5,000 per lot**. If the math can't offer that, no pick.

Survivors are scored and ranked; at most **7** appear on the page, and in
practice 1–3 per cycle.

## What a pick looks like

A pick is a complete, ready-to-execute plan — not a vague tip:

> **PATANJALI 355 PE** (bearish) — spot 353.3, stop if spot rises to 353.3,
> target spot 341.9; premium ₹21.55, premium stop ₹19.95, premium target ₹26.
> Reasons: R-Factor 7.19, futures OI 1.35× 20-day avg, breakout confirmed…

Every pick is saved to the `trade_suggestions` table with all its reasons —
so weeks later we can check exactly what the scanner saw and how it graded out.

## What the scanner does NOT do

- It does **not** place trades. It only produces candidates.
- It does **not** predict. It reads today's positioning and today's price
  confirmation; it can be wrong (see the TATAELXSI story in Lesson 09).
- It does **not** re-suggest smartly: if a pick stays valid, it will keep
  appearing cycle after cycle. Appearing 22 times does not make it 22× better
  — it means the conditions kept holding.

## Switches waiting for proof

A few extra filters exist in the code but are **switched OFF** until replays
over many recorded days prove they help (this discipline matters — a filter
that "fixes" one bad day often quietly deletes the winners of other days):

- **TF breakout gate** — only allow picks with a confirmed breakout in the
  trade's direction.
- **Momentum breakout path** — a 4th entry style for explosive short-covering
  moves that the accumulation gates skip by design.

The pending decisions live on the **/reminders** page.

## Under the hood — the code and the maths

Skippable if you don't read code — but this is where every idea above lives,
and the maths is worth seeing once because the recorded picks check out
against these formulas exactly.

### The methods

| Concept | Method (file) | What it does |
| --- | --- | --- |
| The whole funnel | `runTradeSuggest()` in `lib/trade-suggest/engine.ts` | Runs one scan: candidates → gates → scoring → plans → store |
| The 20-day "normal" | `loadFactorBaselines()` (same file) | Reads each stock's last-20-days averages (OI, turnover, range) from the bhavcopy tables |
| R-Factor | `computeRFactor()` in `lib/r-factor/engine.ts` | Runs 12 factor signals and blends them (maths below) |
| OI urgency | `computeOiUrgency()` in `lib/signals/oi-intraday.ts` | Scores 0–10 how fast OI is climbing today from the intraday snapshots |
| Ranking the survivors | `computeCompositeScore()` in `lib/trade-suggest/scoring.ts` | The weighted score that orders the picks (maths below) |
| The stock-price plan | `buildSpotPlan()` (same file) | Derives spot stop and target from the candles (maths below) |
| Grading past picks | `reviewToday()` in `lib/trade-suggest/review.ts` | The scorecard (Lesson 09) |

`scoring.ts` is deliberately pure maths — no clocks, no database — so the live
scanner and the offline replay harness run the *same* code, and a replay can
never accidentally peek into the future.

### The maths — R-Factor

Twelve factor signals (OI level vs 20-day, smart-money accumulation, futures
OI change, range spread, bid-ask tightness, turnover, breakout, PCR…) each
report a strength between 0 and 1 — or "not available" if their data is
missing. The blend:

```text
rawScore = (w₁×f₁ + w₂×f₂ + …) ÷ (sum of weights of AVAILABLE factors)
R-Factor = 1 + 7 × rawScore          → a number from 1 to 8
```

Dividing by only the *available* weights means missing data (say, no option
chain) neither inflates nor deflates the score. Direction (bullish/bearish) is
a separate **majority vote** of the directional factors — R-Factor's size and
its direction are computed independently.

### The maths — the composite pick score

Each component is first squashed to a 0–1 scale, then weighted
(weights sum to 1.0):

| Component | Weight | In plain words |
| --- | --- | --- |
| R-Factor | 0.22 | How unusual is today's participation |
| Opening-range breakout | 0.20 | Has price actually broken out |
| OI urgency | 0.18 | How FAST is OI building right now |
| OI level | 0.12 | How far above the 20-day norm |
| Confidence | 0.08 | Do the factors agree on direction |
| Sector breadth | 0.08 | Are same-sector names moving the same way |
| Order-book imbalance | 0.07 | Are buyers or sellers heavier, and does it match our side |
| Setup strength | 0.05 | The setup classifier's grade |

An "extended" stock (already moved far from its open) has its final score
multiplied by **0.6** — chasing is penalized, not banned.

### The maths — the spot plan (stop and target)

`buildSpotPlan()` for a bullish (CE) pick:

1. **Stop** = the low of the last *completed* 5-min candle (a natural "if it
   breaks this, the move failed" line). If that's not usable, fall back to the
   opening-range boundary. (For PE picks: mirror image — the last candle's high.)
2. **Noise floor**: if that stop is closer than **0.35%** of the entry price,
   push it out to 0.35% — a stop inside normal 5-minute wobble is a guaranteed
   pointless stop-out.
3. **Target** = entry + **2 ×** the risk (`TARGET_RR = 2`): you only take
   trades where the win is twice the planned loss.

```text
risk   = entry − stop            (at least 0.35% of entry)
target = entry + 2 × risk        (CE;  entry − 2 × risk for PE)
```

### The maths — the premium plan (the rupee lines)

For the option itself (per-share premium, lot size L):

```text
premium stop   = the TIGHTER of:  LTP × (1 − 40%)   and   LTP − 1500 ÷ L
premium target = LTP + 5000 ÷ L
```

That first line is why no lot can lose much more than **₹1,500**, and the
second aims each lot at **+₹5,000**. Check it against a real recorded pick —
MANKIND on 15 Jul (premium ₹71.60, lot size 250):

```text
stop   = 71.60 − 1500 ÷ 250 = 71.60 − 6.00 = ₹65.60   ✓ (recorded: 65.60)
target = 71.60 + 5000 ÷ 250 = 71.60 + 20.00 = ₹91.60  ✓ (recorded: 91.60)
```

---

**Next:** [Lesson 05 — The AI](05-the-ai.md) — what happens to these picks.
