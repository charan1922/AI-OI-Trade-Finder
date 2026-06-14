# Instruments — Complete Reference

Use the security master as the primary source for:
- `security_id`
- lot size
- expiry
- strike
- tick size
- display symbol

Do not treat hardcoded derivative IDs as stable.

## Preferred SDK Entry Point

Current SDK static method:

```python
from dhanhq import dhanhq

df = dhanhq.fetch_security_list("compact")
```

The installed SDK downloads the CSV locally and returns a pandas DataFrame.

Official instrument sources:
- compact CSV: `https://images.dhan.co/api-data/api-scrip-master.csv`
- detailed CSV: `https://images.dhan.co/api-data/api-scrip-master-detailed.csv`

## Key Columns

| Column | Meaning |
|--------|---------|
| `SEM_SMST_SECURITY_ID` | Security ID |
| `SEM_EXM_EXCH_ID` | Exchange (`NSE`, `BSE`, `MCX`) |
| `SEM_INSTRUMENT_NAME` | Instrument type (`EQUITY`, `OPTIDX`, `OPTSTK`, etc.) |
| `SEM_TRADING_SYMBOL` | Exchange trading symbol |
| `SEM_CUSTOM_SYMBOL` | Dhan display name |
| `SEM_LOT_UNITS` | Lot size |
| `SEM_TICK_SIZE` | Tick size |
| `SEM_EXPIRY_DATE` | Expiry date |
| `SEM_STRIKE_PRICE` | Strike price |
| `SEM_OPTION_TYPE` | `CE` or `PE` |
| `SEM_EXPIRY_FLAG` | `W` or `M` |

## Recommended Resolution Flow

1. Exact trading-symbol match
2. Exact custom-symbol match
3. Filter by exchange and instrument type
4. Only then fall back to contains-search and disambiguation

Prefer the helper layer:

```python
from scripts.dhan_helpers import resolve_symbol, resolve_derivative, get_lot_size

cash = resolve_symbol("RELIANCE", exchange_segment="NSE_EQ")
contract = resolve_derivative("NIFTY", strike=24000, option_type="CE", expiry="2025-03-27")
lot_size = get_lot_size(underlying="NIFTY")
```

## Cash-Market Lookup Example

```python
df = dhanhq.fetch_security_list("compact")

match = df[
    (df["SEM_EXM_EXCH_ID"] == "NSE")
    & (df["SEM_INSTRUMENT_NAME"] == "EQUITY")
    & (df["SEM_TRADING_SYMBOL"] == "RELIANCE")
]

security_id = str(match.iloc[0]["SEM_SMST_SECURITY_ID"])
```

## Derivative Lookup Example

```python
df = dhanhq.fetch_security_list("compact")

contract = df[
    (df["SEM_EXM_EXCH_ID"] == "NSE")
    & (df["SEM_INSTRUMENT_NAME"] == "OPTIDX")
    & (df["SEM_CUSTOM_SYMBOL"] == "NIFTY")
    & (df["SEM_STRIKE_PRICE"] == 24000.0)
    & (df["SEM_OPTION_TYPE"] == "CE")
    & (df["SEM_EXPIRY_DATE"] == "2025-03-27")
]

security_id = str(contract.iloc[0]["SEM_SMST_SECURITY_ID"])
lot_size = int(contract.iloc[0]["SEM_LOT_UNITS"])
```

## Quick-Reference Fallback IDs

These are convenience references only. Re-check the security master if there is any ambiguity.

### Index Underlyings

| Underlying | security_id | Underlying Segment |
|------------|-------------|-------------------|
| NIFTY 50 | `13` | `IDX_I` |
| BANK NIFTY | `25` | `IDX_I` |
| FINNIFTY | `27` | `IDX_I` |
| MIDCPNIFTY | `442` | `IDX_I` |
| SENSEX | `51` | `IDX_I` |

### Common NSE Equities

| Symbol | security_id |
|--------|-------------|
| RELIANCE | `2885` |
| HDFCBANK | `1333` |
| TCS | `11536` |
| INFY | `1594` |
| ICICIBANK | `4963` |
| SBIN | `3045` |

## Practical Rules

- Equity security IDs are relatively stable.
- Derivative contract IDs are not stable across expiries.
- Resolve derivative IDs fresh for live trading.
- Use lot size from the security master, not from stale constants.

## Troubleshooting

### No symbol match

Check:
- exchange
- instrument type
- expiry
- strike
- option type

### Too many matches

Add filters for:
- `SEM_EXM_EXCH_ID`
- `SEM_INSTRUMENT_NAME`
- `SEM_EXPIRY_DATE`
- `SEM_OPTION_TYPE`

### Contract not found

Possible causes:
- contract expired
- wrong expiry date
- wrong exchange segment
- stale assumption about current listed contracts
