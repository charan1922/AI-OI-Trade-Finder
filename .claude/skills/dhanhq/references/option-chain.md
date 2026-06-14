# Option Chain — Complete Reference

For analysis code use the normalized helper layer from `scripts/dhan_helpers.py`. See raw payload shape below when you need to parse the response directly.

## Expiry List

SDK signature:

```python
dhan.expiry_list(under_security_id, under_exchange_segment)
```

Example:

```python
response = dhan.expiry_list(
    under_security_id=13,
    under_exchange_segment="IDX_I",
)

if response["status"] == "success":
    expiries = response["data"]
```

## Option Chain

SDK signature:

```python
dhan.option_chain(under_security_id, under_exchange_segment, expiry)
```

Index example:

```python
response = dhan.option_chain(
    under_security_id=13,
    under_exchange_segment="IDX_I",
    expiry="2025-03-27",
)
```

Equity-underlying example:

```python
response = dhan.option_chain(
    under_security_id=2885,
    under_exchange_segment="NSE_EQ",
    expiry="2025-03-27",
)
```

Rate limit:
- one unique option-chain request every 3 seconds

## Raw Payload Shape

Raw response structure from Dhan v2:

```python
{
    "data": {
        "last_price": 25642.8,
        "oc": {
            "25650.000000": {
                "ce": {
                    "security_id": 12345,
                    "last_price": 146.99,
                    "average_price": 146.99,
                    "oi": 1250000,
                    "oi_change": 50000,
                    "implied_volatility": 12.5,
                    "top_bid_price": 146.9,
                    "top_bid_quantity": 50,
                    "top_ask_price": 147.0,
                    "top_ask_quantity": 75,
                    "volume": 85000,
                    "greeks": {
                        "delta": 0.65,
                        "gamma": 0.002,
                        "theta": -15.2,
                        "vega": 28.5
                    }
                },
                "pe": {...}
            }
        }
    }
}
```

Important:
- `oc` is keyed by strike string, not a list.
- Raw field names are `last_price`, `oi`, `implied_volatility`, `top_bid_price`, `top_ask_price`, and nested `greeks`.

## Repo-Normalized Analysis Layer

For analysis code, prefer:

```python
from scripts.dhan_helpers import fetch_chain_df, find_atm_row

chain_df, spot = fetch_chain_df(
    dhan,
    under_security_id=13,
    expiry="2025-03-27",
    under_exchange_segment="IDX_I",
)

atm = find_atm_row(chain_df, spot)
print(spot, atm["strike"], atm["ce_security_id"], atm["ce_ltp"])
```

Normalized helper columns:
- `strike`
- `ce_security_id`, `pe_security_id`
- `ce_ltp`, `pe_ltp`
- `ce_oi`, `pe_oi`
- `ce_oi_change`, `pe_oi_change`
- `ce_volume`, `pe_volume`
- `ce_iv`, `pe_iv`
- `ce_bid_price`, `pe_bid_price`
- `ce_ask_price`, `pe_ask_price`
- `ce_delta`, `pe_delta`
- `ce_gamma`, `pe_gamma`
- `ce_theta`, `pe_theta`
- `ce_vega`, `pe_vega`

These normalized names are repo-defined conveniences. They are not raw Dhan field names.

## Practical Patterns

### Get ATM row

```python
atm = find_atm_row(chain_df, spot)
print(atm["strike"])
print(atm["ce_ltp"], atm["pe_ltp"])
```

### Filter nearby strikes

```python
nearby = chain_df[(chain_df["strike"] >= spot - 500) & (chain_df["strike"] <= spot + 500)]
```

### Find a contract security ID

```python
row = chain_df[chain_df["strike"] == 24000].iloc[0]
ce_security_id = row["ce_security_id"]
pe_security_id = row["pe_security_id"]
```

### Compute simple OI totals

```python
total_ce_oi = chain_df["ce_oi"].fillna(0).sum()
total_pe_oi = chain_df["pe_oi"].fillna(0).sum()
```

## Guidance

- Use index examples first for Nifty/BankNifty workflows.
- Cover equity underlyings only when the user explicitly needs stock options.
- For current liquid contracts, option chain is a fast way to get security IDs.
- For robust contract resolution across expiries and underlyings, fall back to the security master.
