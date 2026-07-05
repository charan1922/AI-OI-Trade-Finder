---
type: Model
title: Option plan — strike, expiry, budget, premium exits
description: >
  Resolving the near-ATM contract (nearest strike, nearest monthly expiry ≥3
  DTE), the ₹60k capital budget with oversample fallback, and the premium
  max-loss backstop (−40%) + TF ₹5k/lot target.
resource: lib/trade-suggest/types.ts
tags: [option-plan, strike, expiry, budget, premium, exits]
timestamp: 2026-07-05T00:00:00Z
---

# Option plan (`OptionPlan` / `OptionPremium`)

Turns a stock pick into a tradeable near-ATM contract, live-quotes it, and derives
premium-level exits. Near-ATM is chosen for intraday momentum buying (delta ~0.5,
best liquidity/gamma).

## Contract resolution

- **Strike:** nearest listed strike to the LTP.
- **Side:** CE for bullish bias, PE for bearish.
- **Expiry:** nearest monthly, skipping anything within `MIN_DTE = 3` days (theta
  burn near expiry).
- Resolved from `master_contracts` OPTSTK rows → `{ strike, expiryDate, lotSize,
  optSecurityId, optSymbol }`. If no contract resolves, the pick is still shown as
  a stock signal with `option: null`.

## Capital budget

`CAPITAL_BUDGET = 60_000` (the user trades ₹50–60k). A pick whose **single lot**
(`ltp × lotSize`) costs more than the budget is **skipped for the next qualified
candidate** — `PICK_OVERSAMPLE = 3` extra survivors are premium-quoted as
affordability fallbacks. Position size is normally ONE lot.

## Premium (`OptionPremium`, one extra batched Dhan quote)

Real quoted numbers — never fabricated:

- `ltp`, `bid`, `ask`, `spreadPct` (option's own book), `volume`, `oi`.
- `perLotCost = ltp × lotSize`.
- `slPremium = ltp × (1 − 40/100)` — the **premium max-loss backstop**
  (`PREMIUM_SL_PCT = 40`, the Indian option-buying convention).
- `targetPremium` — the premium level that books ~₹5,000 on one lot
  (`TF_LOT_TARGET_RUPEES = 5000`).
- `liquidityWarning` — non-null when the option spread is wide (> `MAX_OPT_SPREAD_PCT
  = 2%` of mid) or volume is zero. Surface it prominently: slippage risk.

If `premium` is null the quote wasn't available — plan is spot-terms only; tell
the user to check the premium on the broker.

## Related

- [spot-plan.md](spot-plan.md) · [data-sources/dhan.md](../data-sources/dhan.md) · [universe/fno-stocks.md](../universe/fno-stocks.md)
