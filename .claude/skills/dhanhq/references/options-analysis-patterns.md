# Options Analysis Patterns

Use the normalized helper output from `scripts/dhan_helpers.py` for analysis code.

```python
from scripts.dhan_helpers import fetch_chain_df, find_atm_row

chain_df, spot = fetch_chain_df(dhan, 13, "2025-03-27")
atm = find_atm_row(chain_df, spot)
```

## Put-Call Ratio (PCR)

```python
total_ce_oi = chain_df["ce_oi"].fillna(0).sum()
total_pe_oi = chain_df["pe_oi"].fillna(0).sum()
pcr = total_pe_oi / total_ce_oi if total_ce_oi else 0
print(f"PCR: {pcr:.2f}")
```

## OI Support / Resistance

```python
ce_walls = chain_df[["strike", "ce_oi"]].dropna().sort_values("ce_oi", ascending=False).head(3)
pe_walls = chain_df[["strike", "pe_oi"]].dropna().sort_values("pe_oi", ascending=False).head(3)
```

Interpretation:
- highest CE OI often acts like resistance
- highest PE OI often acts like support

## IV Skew

```python
otm_puts = chain_df[chain_df["strike"] < spot].nlargest(3, "strike")
otm_calls = chain_df[chain_df["strike"] > spot].nsmallest(3, "strike")

put_iv = otm_puts["pe_iv"].dropna().mean()
call_iv = otm_calls["ce_iv"].dropna().mean()
skew = put_iv - call_iv
```

## Max Pain

```python
def calculate_max_pain(df):
    strikes = df["strike"].tolist()
    pain = {}

    for test_price in strikes:
        total = 0
        for _, row in df.iterrows():
            strike = row["strike"]
            ce_oi = row.get("ce_oi") or 0
            pe_oi = row.get("pe_oi") or 0
            total += max(0, test_price - strike) * ce_oi
            total += max(0, strike - test_price) * pe_oi
        pain[test_price] = total

    return min(pain, key=pain.get)
```

## Contract Selection

ATM contract lookup:

```python
atm = find_atm_row(chain_df, spot)
ce_security_id = atm["ce_security_id"]
pe_security_id = atm["pe_security_id"]
```

Nearby strikes:

```python
nearby = chain_df[(chain_df["strike"] >= spot - 500) & (chain_df["strike"] <= spot + 500)]
```

## Guidance

- Use option chain for current listed option contracts.
- Use the security master when you need broader derivative resolution logic.
- Treat helper fields like `ce_ltp`, `pe_oi`, `ce_iv`, etc. as repo-defined normalized fields, not raw Dhan field names.
