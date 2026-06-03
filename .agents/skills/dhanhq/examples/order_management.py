"""Complete order lifecycle: place, monitor, modify, cancel via DhanHQ.

Demonstrates:
- Placing an order
- Checking order status
- Modifying a pending order
- Cancelling an order
- Viewing the order book and trade book
"""

import time
import os

from dhanhq import dhanhq

from scripts.dhan_helpers import get_client, preview_order

dhan, _ = get_client()

security_id = "2885"
price = 2000.0
quantity = 1

print(
    preview_order(
        security_id=security_id,
        exchange_segment=dhanhq.NSE,
        transaction_type=dhanhq.BUY,
        quantity=quantity,
        order_type=dhanhq.LIMIT,
        product_type=dhanhq.CNC,
        price=price,
        trading_symbol="RELIANCE",
    )
)

if os.environ.get("RUN_LIVE_EXAMPLE") != "1":
    raise SystemExit("Set RUN_LIVE_EXAMPLE=1 to place, modify, and cancel a live demo order.")

# Step 1: Place a limit order (well below market for demo — won't fill)
print("Step 1: Placing limit buy order for RELIANCE...")
response = dhan.place_order(
    security_id=security_id,
    exchange_segment=dhanhq.NSE,
    transaction_type=dhanhq.BUY,
    quantity=quantity,
    order_type=dhanhq.LIMIT,
    product_type=dhanhq.CNC,
    price=price,                      # Below market — will stay pending
    validity=dhanhq.DAY,
    tag="lifecycle_demo",
)

if response["status"] != "success":
    raise SystemExit(f"Order failed: {response['remarks']}")

order_id = response["data"]["orderId"]
print(f"Order placed: {order_id}")

# Step 2: Check order status
print("\nStep 2: Checking order status...")
time.sleep(1)
order = dhan.get_order_by_id(order_id=order_id)
status = order["data"]["orderStatus"]
print(f"Status: {status}")
print(f"  Security:  {order['data'].get('tradingSymbol', 'N/A')}")
print(f"  Qty:       {order['data']['quantity']}")
print(f"  Price:     ₹{order['data']['price']}")
print(f"  Filled:    {order['data'].get('filledQty', 0)}")

# Step 3: Modify the order (change price)
if status == "PENDING":
    print("\nStep 3: Modifying order price to ₹2050...")
    mod_response = dhan.modify_order(
        order_id=order_id,
        order_type=dhanhq.LIMIT,
        leg_name=None,                # None for regular orders
        quantity=quantity,
        price=2050.00,
        trigger_price=0,
        disclosed_quantity=0,
        validity=dhanhq.DAY,
    )
    print(f"Modify result: {mod_response['status']}")

# Step 4: Cancel the order
print("\nStep 4: Cancelling order...")
cancel_response = dhan.cancel_order(order_id=order_id)
print(f"Cancel result: {cancel_response['status']}")

# Step 5: View order book
print("\nStep 5: Today's order book:")
orders = dhan.get_order_list()
if orders["data"]:
    for o in orders["data"][-5:]:  # Last 5 orders
        print(f"  {o.get('orderId', 'N/A')[:12]} | "
              f"{o.get('tradingSymbol', 'N/A'):>12} | "
              f"{o.get('transactionType', ''):>4} | "
              f"{o.get('orderStatus', 'N/A'):>12} | "
              f"₹{o.get('price', 0):>8.2f}")

# Step 6: View trade book
print("\nStep 6: Today's trade book:")
trades = dhan.get_trade_book()
if trades["data"]:
    for t in trades["data"][-5:]:
        print(f"  {t.get('tradingSymbol', 'N/A'):>12} | "
              f"{t.get('transactionType', ''):>4} | "
              f"Qty: {t.get('tradedQuantity', 0):>5} | "
              f"₹{t.get('tradedPrice', 0):>8.2f}")
else:
    print("  No trades today")
