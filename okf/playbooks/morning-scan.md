---
type: Playbook
title: Morning scan (09:40–11:00)
description: >
  One trade-suggest scan pass — fetch the endpoint, branch on window/market
  state, present at most 3 picks with the two-layer plan and evidence, and pick
  the loop cadence. Bucket-aligned 5-min loop is safe on rate limits.
resource: .claude/skills/trade-suggest/SKILL.md
tags: [playbook, morning-scan, loop, procedure]
timestamp: 2026-07-05T00:00:00Z
---

# Morning scan

One invocation = one scan. All times IST.

## Fetch

```bash
curl -s http://localhost:5001/api/trade-suggest
```

(Connection refused → dev server not running: `pnpm dev` in `Project-R-simulator`.
Do not retry more than once.)

## Branch on the JSON

- **`window.active: true` + suggestions** → present the picks (below).
- **`window.active: true`, no suggestions** → say nothing qualified; report
  `scanned` and the biggest `gated` reasons (e.g. "42 scanned; 18 failed OI
  level, 12 neutral bias"). Surface any `note` about the quote path / `/api/dhan/token`.
- **`window.active: false`, market open** → outside 09:40–11:00. After 15:30 (or
  past 11:00 with `earlierToday` non-empty) → offer/run the [scorecard](scorecard-review.md).
- **Market closed** → say so; nothing until next session.

## Present ≤3 picks

Per pick (compact): symbol · BUY strike CE/PE (expiry, lot) · score · real
premium → per-lot cost (fits ₹60k?) · option spread · **exits** (spot SL + basis
/ premium backstop −40%) · **targets** (spot 1:2 / premium ≈₹5k/lot) · **why**
(R-Factor + bias + confidence, OI level + urgency, turnover, OR breakout, sector
breadth). Rules:

- Use ONLY numbers from the response — never invent Greeks/probabilities.
- Surface `liquidityWarning` prominently. If `premium` is null, plan is spot-only.
- Flag Supertrend/VWAP misalignment (⚠), don't hide it — [engine/scoring.md](../engine/scoring.md).
- Compare with `earlierToday`: mark NEW / repeat (`timesSeen`) / dropped.
- Position size: normally ONE lot; state rupee risk at the premium backstop
  (`perLotCost × 40%`).
- Always end: analysis only, not advice, no order placed.

See [near-atm-ce.md](near-atm-ce.md) / [near-atm-pe.md](near-atm-pe.md) for reading a setup.

## Loop cadence (/loop)

- Before 09:40 → wake at 09:40.
- Inside 09:40–11:00 → every ~5 min (aligns with the [Fyers](../data-sources/fyers.md)
  bucket; one new completed bar per firing; feeds are 30s-cached so it's safe on
  rate limits).
- 11:00–15:20 → wake at 15:20 for the [scorecard](scorecard-review.md), unless
  `earlierToday` is empty (then stop).
- After scorecard / weekend / holiday → wake 09:40 next trading day.
- **Never `force=1` in loop mode** ([window.md](../engine/window.md)).
