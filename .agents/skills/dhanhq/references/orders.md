# Orders — Complete Reference

Critical API rule:
- order placement, modification, cancellation, super orders, and forever orders require static IP whitelisting

Current API note:
- Dhan's current order docs say API market orders are converted to limit orders with MPP

## Regular Orders

### Place Order

Current SDK signature:

```python
dhan.place_order(
    security_id,
    exchange_segment,
    transaction_type,
    quantity,
    order_type,
    product_type,
    price,
    trigger_price=0,
    disclosed_quantity=0,
    after_market_order=False,
    validity="DAY",
    amo_time="OPEN",
    bo_profit_value=None,
    bo_stop_loss_Value=None,
    tag=None,
    should_slice=False,
)
```

Recommended pattern:

```python
response = dhan.place_order(
    security_id="2885",
    exchange_segment=dhanhq.NSE,
    transaction_type=dhanhq.BUY,
    quantity=10,
    order_type=dhanhq.LIMIT,
    product_type=dhanhq.CNC,
    price=2450.0,
    validity=dhanhq.DAY,
    tag="rebalance_001",
)

if response["status"] == "success":
    print(response["data"]["orderId"], response["data"]["orderStatus"])
```

Validation rules to enforce before placement:
- `price` required for `LIMIT` and `STOP_LOSS`
- `trigger_price` required for `STOP_LOSS` and `STOP_LOSS_MARKET`
- derivatives require lot-size multiples
- derivatives only allow `INTRADAY` or `MARGIN`
- quote market structure first if you need a sensible limit price

### Slice Order

Use `should_slice=True` or the explicit SDK helper:

```python
response = dhan.place_slice_order(
    security_id="49081",
    exchange_segment=dhanhq.NSE_FNO,
    transaction_type=dhanhq.BUY,
    quantity=2500,
    order_type=dhanhq.LIMIT,
    product_type=dhanhq.INTRA,
    price=150.0,
    validity=dhanhq.DAY,
)
```

Use this only after checking current freeze-quantity requirements.

### Modify Order

Current SDK signature:

```python
dhan.modify_order(order_id, order_type, leg_name, quantity, price, trigger_price, disclosed_quantity, validity)
```

Example:

```python
response = dhan.modify_order(
    order_id="112111182198",
    order_type=dhanhq.LIMIT,
    leg_name=None,
    quantity=10,
    price=2455.0,
    trigger_price=0,
    disclosed_quantity=0,
    validity=dhanhq.DAY,
)
```

The SDK and release notes expect full placed quantity in modification requests, not pending quantity.

### Cancel Order

```python
response = dhan.cancel_order(order_id="112111182198")
```

### Order Retrieval

```python
order = dhan.get_order_by_id("112111182198")
order_by_tag = dhan.get_order_by_correlationID("my_tag")
orders = dhan.get_order_list()
trades = dhan.get_trade_book()
single_trade = dhan.get_trade_book(order_id="112111182198")
history = dhan.get_trade_history("2025-01-01", "2025-01-31", page_number=0)
ledger = dhan.ledger_report("2025-01-01", "2025-01-31")
```

## Super Orders

Current SDK support exists for:
- `place_super_order`
- `modify_super_order`
- `cancel_super_order`
- `get_super_order_list`

### Place Super Order

Current SDK signature:

```python
dhan.place_super_order(
    security_id,
    exchange_segment,
    transaction_type,
    quantity,
    order_type,
    product_type,
    price,
    targetPrice=0.0,
    stopLossPrice=0.0,
    trailingJump=0.0,
    tag=None,
)
```

Example:

```python
response = dhan.place_super_order(
    security_id="2885",
    exchange_segment=dhanhq.NSE,
    transaction_type=dhanhq.BUY,
    quantity=1,
    order_type=dhanhq.LIMIT,
    product_type=dhanhq.INTRA,
    price=2450.0,
    targetPrice=2500.0,
    stopLossPrice=2420.0,
    trailingJump=10.0,
)
```

### Modify Super Order

Current SDK signature:

```python
dhan.modify_super_order(order_id, order_type, leg_name, quantity=0, price=0.0, targetPrice=0.0, stopLossPrice=0.0, trailingJump=0.0)
```

Key rule from the API docs:
- `ENTRY_LEG` can modify the whole structure while the entry order is `PENDING` or `PART_TRADED`
- after entry is `TRADED`, only `TARGET_LEG` and `STOP_LOSS_LEG` changes remain

### Cancel Super Order

```python
response = dhan.cancel_super_order(order_id="...", order_leg="ENTRY_LEG")
```

### Super Order Book

```python
response = dhan.get_super_order_list()
```

## Forever Orders

Current SDK support exists for:
- `place_forever`
- `modify_forever`
- `cancel_forever`
- `get_forever`

### Place Forever Order

Current SDK signature:

```python
dhan.place_forever(
    security_id,
    exchange_segment,
    transaction_type,
    product_type,
    order_type,
    quantity,
    price,
    trigger_Price,
    order_flag="SINGLE",
    disclosed_quantity=0,
    validity="DAY",
    price1=0,
    trigger_Price1=0,
    quantity1=0,
    tag=None,
    symbol="",
)
```

Single trigger example:

```python
response = dhan.place_forever(
    security_id="2885",
    exchange_segment=dhanhq.NSE,
    transaction_type=dhanhq.BUY,
    product_type=dhanhq.CNC,
    order_type=dhanhq.LIMIT,
    quantity=1,
    price=2400.0,
    trigger_Price=2405.0,
)
```

Important:
- the SDK parameter is `trigger_Price`
- OCO fields use `price1`, `trigger_Price1`, `quantity1`

## Order Validation Checklist

Before live placement, confirm:
1. account access token is valid
2. required segment is active
3. data plan is active if quotes are needed
4. static IP is configured for trading APIs
5. product type matches segment
6. quantity matches lot size for derivatives
7. trigger/price fields are consistent with order type
8. limit price is reasonable for the market state

## Troubleshooting

### Order rejected with access/IP issue

Check:
- static IP whitelisting
- `DH-911` invalid IP

### Order rejected with product-type issue

Check:
- `CNC` / `MTF` only for eligible equity flows
- `INTRADAY` / `MARGIN` only for derivative segments

### User thinks a data error is an order error

Separate the failure domain:
- `806` / `DH-902` usually points to Data API access
- trading placement failures often point to static IP or order validation

### Destructive actions

Always preview and confirm before:
- `place_order`
- `modify_order`
- `cancel_order`
- `cancel_super_order`
- `cancel_forever`
- `kill_switch`
