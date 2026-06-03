# Portfolio And Positions — Complete Reference

## Holdings

SDK method:

```python
response = dhan.get_holdings()
```

Example:

```python
if response["status"] == "success":
    holdings = response["data"]
    for holding in holdings:
        print(holding["tradingSymbol"], holding["securityId"], holding["availableQty"])
```

Useful holding fields from the v2 API:
- `exchange`
- `tradingSymbol`
- `securityId`
- `isin`
- `totalQty`
- `dpQty`
- `t1Qty`
- `availableQty`
- `collateralQty`
- `avgCostPrice`

## Positions

SDK method:

```python
response = dhan.get_positions()
```

Example:

```python
if response["status"] == "success":
    positions = response["data"]
    open_positions = [p for p in positions if p["netQty"] != 0]
```

Useful position fields from the v2 API:
- `tradingSymbol`
- `securityId`
- `positionType`
- `exchangeSegment`
- `productType`
- `buyAvg`
- `buyQty`
- `sellAvg`
- `sellQty`
- `netQty`
- `realizedProfit`
- `unrealizedProfit`
- `drvExpiryDate`
- `drvOptionType`
- `drvStrikePrice`

## Convert Position

SDK signature:

```python
dhan.convert_position(
    from_product_type,
    exchange_segment,
    position_type,
    security_id,
    convert_qty,
    to_product_type,
)
```

Example:

```python
response = dhan.convert_position(
    from_product_type=dhanhq.INTRA,
    exchange_segment=dhanhq.NSE,
    position_type="LONG",
    security_id="2885",
    convert_qty=1,
    to_product_type=dhanhq.CNC,
)
```

## Exit All Positions

Raw v2 API:
- `DELETE /positions`

Current installed SDK status:
- the local `dhanhq` 2.2.0 install does not expose a first-class `exit_all_positions()` method

Practical rule:
- do not document or generate `dhan.exit_all_positions()` unless you add an explicit wrapper
- if you add raw REST support for this in the repo later, always require confirmation first

This is account-wide and high-risk.

## eDIS Authorization

Use eDIS for selling delivery holdings.

Do not use eDIS for:
- intraday trades
- F&O positions
- non-holdings sell flows

### Step 1: Generate TPIN

```python
response = dhan.generate_tpin()
```

### Step 2: Open the authorization form

SDK signature:

```python
dhan.open_browser_for_tpin(isin, qty, exchange, segment="EQ", bulk=False)
```

Example:

```python
dhan.open_browser_for_tpin(
    isin="INE002A01018",
    qty=5,
    exchange="NSE",
    segment="EQ",
)
```

### Step 3: Check approval status

SDK signature:

```python
dhan.edis_inquiry(isin)
```

Example:

```python
response = dhan.edis_inquiry("INE002A01018")

if response["status"] == "success":
    status = response["data"]
    print(status["status"], status["aprvdQty"], status["remarks"])
```

Current inquiry fields from the v2 API:
- `clientId`
- `isin`
- `totalQty`
- `aprvdQty`
- `status`
- `remarks`

You can also pass `ALL` to inspect eDIS status more broadly when needed.

## Agent Guardrails

- If the user wants to sell CNC holdings and eDIS status is unclear, stop and confirm authorization first.
- Do not place the delivery sell order until approval is confirmed.
- For holdings sell, use the ISIN from holdings data rather than guessing it.

## Troubleshooting

### Holdings or positions look empty

Check:
- current trading day state
- correct account
- segment activation on the Dhan account

### eDIS inquiry is not approved

Do this:
1. Re-run TPIN flow
2. Re-open the browser authorization form
3. Re-check `edis_inquiry(isin)`

### User wants account-wide position exit

Treat this as a destructive account action:
1. summarize open positions first
2. ask for explicit confirmation
3. only then use a raw REST wrapper if you add one
