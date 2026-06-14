# Common Workflows — Agent Playbooks

## Portfolio Rebalance

Recommended sequence:

1. Fetch holdings and funds
2. Compute target deltas
3. Resolve symbols and quantities
4. Preview all proposed orders
5. Confirm with the user
6. Place live orders only after confirmation

Skeleton:

```python
holdings_resp = dhan.get_holdings()
funds_resp = dhan.get_fund_limits()

if holdings_resp["status"] == "success" and funds_resp["status"] == "success":
    holdings = holdings_resp["data"]
    funds = funds_resp["data"]
    available_cash = funds["availabelBalance"]
```

Guardrails:
- do not assume all holdings are NSE equities
- use current market data or a user-provided limit price
- do not submit all orders blindly without a preview

## Delivery Sell With eDIS

Use this flow for selling demat holdings:

1. Fetch holdings and identify ISIN
2. Generate TPIN
3. Open the authorization form
4. Check `edis_inquiry(isin)`
5. Only after approval, place the sell order

Skeleton:

```python
dhan.generate_tpin()
dhan.open_browser_for_tpin(isin="INE002A01018", qty=5, exchange="NSE")
status = dhan.edis_inquiry("INE002A01018")
```

Do not use this flow for:
- intraday equity sells
- F&O
- commodity
- currency

## Single-Leg F&O Execution

Recommended sequence:

1. Resolve current contract from option chain or security master
2. Resolve lot size
3. Validate quantity
4. Check margin
5. Preview
6. Confirm
7. Place live order

Skeleton:

```python
from scripts.dhan_helpers import fetch_chain_df, find_atm_row, check_margin

chain_df, spot = fetch_chain_df(dhan, 13, "2025-03-27")
atm = find_atm_row(chain_df, spot)

margin = check_margin(
    dhan,
    security_id=atm["ce_security_id"],
    exchange_segment=dhanhq.NSE_FNO,
    transaction_type=dhanhq.BUY,
    quantity=75,
    product_type=dhanhq.INTRA,
    price=float(atm["ce_ltp"]),
)
```

## Multi-Leg Option Strategy

Recommended sequence:

1. Fetch option chain
2. Normalize with `fetch_chain_df()`
3. Build the strategy legs
4. Check live contract IDs and lot sizes
5. Check margin impact
6. Preview the complete basket
7. Confirm
8. Place buy-protection legs first where relevant
9. Monitor fills with `OrderUpdate`

Practical rules:
- use normalized helper output, not raw `oc` parsing in every script
- never hardcode current derivative security IDs
- for naked-risk strategies, be explicit about user confirmation

## Daily P&L Summary

Recommended sequence:

1. Fetch holdings
2. Fetch positions
3. Fetch funds
4. Aggregate P&L and capital snapshot
5. Present a concise summary

Skeleton:

```python
from scripts.dhan_helpers import format_pnl_report

holdings_resp = dhan.get_holdings()
positions_resp = dhan.get_positions()
summary = format_pnl_report(holdings_resp, positions_resp)
```

## Data API Subscription Invalid

Do not re-explain the full flow here.

Point the user to:
- `references/error-codes.md`

Minimal workflow:
1. check `dataPlan`
2. activate data subscription if needed
3. refresh token
4. retry a simple data endpoint
