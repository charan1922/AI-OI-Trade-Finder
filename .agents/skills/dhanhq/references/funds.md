# Funds & Margin — Complete Reference

The installed `dhanhq` SDK exposes `get_fund_limits()` and single-order `margin_calculator()`.

## Fund Limits

SDK method:

```python
response = dhan.get_fund_limits()
```

Example:

```python
if response["status"] == "success":
    funds = response["data"]
    print(funds["availabelBalance"])
    print(funds["utilizedAmount"])
```

Current fund-limit fields:
- `dhanClientId`
- `availabelBalance`
- `sodLimit`
- `collateralAmount`
- `receiveableAmount`
- `utilizedAmount`
- `blockedPayoutAmount`
- `withdrawableBalance`

Important:
- `availabelBalance` is Dhan's actual field spelling.

## Margin Calculator — Single Order

SDK signature:

```python
dhan.margin_calculator(
    security_id,
    exchange_segment,
    transaction_type,
    quantity,
    product_type,
    price,
    trigger_price=0,
)
```

Example:

```python
response = dhan.margin_calculator(
    security_id="2885",
    exchange_segment=dhanhq.NSE,
    transaction_type=dhanhq.BUY,
    quantity=10,
    product_type=dhanhq.CNC,
    price=2450.0,
    trigger_price=0,
)

if response["status"] == "success":
    margin = response["data"]
    print(margin["totalMargin"])
    print(margin["availableBalance"])
    print(margin["brokerage"])
```

Current single-order margin fields:
- `totalMargin`
- `spanMargin`
- `exposureMargin`
- `availableBalance`
- `variableMargin`
- `insufficientBalance`
- `brokerage`
- `leverage`

## Multi-Order Margin

Current v2 REST supports:
- `POST /margincalculator/multi`

Current installed SDK status:
- the local `dhanhq` 2.2.0 install does not expose a first-class `margin_calculator_multi()` method

Practical guidance:
- if you only need a pre-trade check, use the single-order SDK method
- if you need true portfolio-style multi-leg margin from this repo, either:
  - call the raw REST endpoint directly, or
  - extend the SDK wrapper in a controlled way

Do not document or generate calls to `margin_calculator_multi()` unless you add that wrapper explicitly.

## Recommended Agent Pattern

Use the repo helper:

```python
from scripts.dhan_helpers import check_margin

margin = check_margin(
    dhan,
    security_id="2885",
    exchange_segment=dhanhq.NSE,
    transaction_type=dhanhq.BUY,
    quantity=10,
    product_type=dhanhq.CNC,
    price=2450.0,
)

if margin["sufficient"]:
    print("Order can be funded")
else:
    print("Insufficient balance", margin["shortfall"])
```

## Derivative Margin Notes

- Resolve lot size from the security master or current contract metadata.
- Do not hardcode lot sizes in margin examples as if they are permanent.
- Use `INTRADAY` or `MARGIN` for F&O, commodity, and currency segments.
- Never use `CNC` or `MTF` for derivative products.

## Troubleshooting

### Margin call fails immediately

Check:
- `security_id`
- `exchange_segment`
- `product_type`
- `trigger_price` for SL/SLM

### Available cash seems lower than expected

Inspect:
- `utilizedAmount`
- `collateralAmount`
- `blockedPayoutAmount`
- `withdrawableBalance`

### User wants a multi-leg strategy

Do this in order:
1. Resolve live contract IDs from security master or option chain
2. Check margin impact leg by leg if no multi-order wrapper exists
3. Preview the sequence
4. Confirm with the user before any live execution
