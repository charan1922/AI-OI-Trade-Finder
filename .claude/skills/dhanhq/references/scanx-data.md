# ScanX — Fundamental and Technical Data

Use ScanX when Dhan APIs do not cover the needed data. Dhan provides execution, quotes, OHLC, option chain, and portfolio. ScanX provides fundamentals, technical indicators, shareholding, and screeners.

## Capability Gap

| Data needed | Use |
|------------|-----|
| PE ratio, EPS, Book Value, PB Ratio | ScanX |
| Revenue, Net Profit, EBITDA | ScanX |
| Debt-to-equity, Return on Equity | ScanX |
| RSI(14), MACD(12,26), ADX(14), ATR(14) | ScanX |
| Promoter %, FII %, DII %, Public % | ScanX |
| Quarterly results history (2015–present) | ScanX |
| Balance Sheet, Cash Flows | ScanX |
| Stock screeners (fundamental/technical) | ScanX |
| Live quotes, OHLC, option chain | Dhan |
| Order execution, portfolio | Dhan |

## Company Page URL Pattern

`https://scanx.trade/company/{slug}`

Slug rules:
- Lowercase the full registered company name
- Replace spaces with hyphens
- Include "ltd" if part of the official name

| Company | URL slug |
|---------|----------|
| Reliance Industries Ltd | `reliance-industries-ltd` |
| HDFC Bank | `hdfc-bank` |
| Infosys | `infosys` |
| TCS | `tata-consultancy-services-ltd` |
| State Bank of India | `state-bank-of-india` |
| ICICI Bank | `icici-bank` |

If unsure: derive the slug, fetch the URL, and verify the page returns company data. If it 404s, try a shorter form (drop "ltd", use abbreviation, or search `https://scanx.trade`).

## Data Per Page Section

**Overview tab (loaded by default):**
- Current price, day change %, 52-week range
- Market Cap, PE Ratio, EPS, PB Ratio, Book Value, Dividend Yield
- EBITDA, Revenue, Net Profit, Debt-to-equity, ROE

**Technicals tab:**
- RSI(14) — with signal: Overbought / Neutral / Oversold
- MACD(12,26) — with signal: Bullish / Bearish
- ADX(14) — with signal: Strong Trend / Weak Trend
- ATR(14) — with volatility label

**Shareholding tab:**
- Promoter %, DII %, FII %, Public %

**Financials tab:**
- Quarterly results back to 2015
- Revenue, EBITDA, Net Profit trends

**Balance Sheet / Cash Flows tabs:**
- Annual statements back to 2015

## Fetching Data

Fetch the company URL and extract the relevant section from the rendered page:

```
https://scanx.trade/company/{slug}
```

The Overview tab data (fundamentals) loads on the default page. Technical indicators require the Technicals tab (append `#technicals` or navigate to it).

## Combined Workflow: Analyze on ScanX → Execute on Dhan

```python
# Step 1: fetch ScanX page for fundamentals/technicals
# → https://scanx.trade/company/reliance-industries-ltd
# → extract: PE=18.38, RSI=42.75 (Neutral), Revenue=10,57,220 Cr

# Step 2: resolve security_id from Dhan security master
from scripts.dhan_helpers import resolve_symbol, get_client

dhan, _ = get_client()
row = resolve_symbol("RELIANCE", exchange_segment="NSE_EQ")
security_id = str(row["SEM_SMST_SECURITY_ID"])  # e.g. "2885"

# Step 3: get live quote from Dhan
from dhanhq import dhanhq

response = dhan.ticker_data({"NSE_EQ": [int(security_id)]})
ltp = response["data"]["NSE_EQ"][security_id]["last_price"]

# Step 4: place order via Dhan
response = dhan.place_order(
    security_id=security_id,
    exchange_segment=dhanhq.NSE,
    transaction_type=dhanhq.BUY,
    quantity=1,
    order_type=dhanhq.LIMIT,
    product_type=dhanhq.CNC,
    price=ltp,
)
```

## Guidance

- ScanX does not have a documented public API — data is accessed via the web page.
- The Overview tab data is available without authentication.
- For screener results, use `https://scanx.trade/screener` — 1500+ community screeners covering fundamental, technical, intraday, and sector-based filters.
- ScanX integrates with Dhan for order execution via the web UI, but programmatic execution still goes through Dhan APIs directly.
