"""Place GTT (Good Till Triggered) Forever Orders via DhanHQ.

Demonstrates:
- Single trigger GTT (buy on dip)
- OCO (One Cancels Other) for target + stop loss
- Listing and cancelling forever orders
"""

from dhanhq import dhanhq

from scripts.dhan_helpers import get_client

dhan, _ = get_client()

# Example 1: Single GTT — Buy Reliance if it dips to ₹2300
print("--- GTT Single: Buy RELIANCE on dip ---")
# response = dhan.place_forever(
#     security_id="2885",
#     exchange_segment=dhanhq.NSE,
#     transaction_type=dhanhq.BUY,
#     product_type=dhanhq.CNC,              # Equity delivery
#     order_type=dhanhq.LIMIT,
#     quantity=5,
#     price=2300.00,                         # Limit price
#     trigger_Price=2305.00,                 # Trigger price (note: capital P)
#     order_flag="SINGLE",
#     validity=dhanhq.DAY,
#     tag="gtt_buy_dip",
# )
# print(f"GTT placed: {response}")

# Example 2: OCO — Sell Reliance at ₹2700 (target) OR ₹2200 (stop loss)
print("\n--- GTT OCO: Target + Stop Loss for RELIANCE holding ---")
# response = dhan.place_forever(
#     security_id="2885",
#     exchange_segment=dhanhq.NSE,
#     transaction_type=dhanhq.SELL,
#     product_type=dhanhq.CNC,              # Selling from holdings
#     order_type=dhanhq.LIMIT,
#     quantity=5,
#     price=2700.00,                         # Target price
#     trigger_Price=2695.00,                 # Target trigger (capital P!)
#     price1=2200.00,                        # Stop loss price
#     trigger_Price1=2205.00,                # Stop loss trigger (capital P!)
#     order_flag="OCO",                      # One Cancels Other
#     validity=dhanhq.DAY,
# )
# print(f"OCO placed: {response}")

# Example 3: List all active forever orders
print("\n--- Active Forever Orders ---")
forever_orders = dhan.get_forever()
if forever_orders["status"] == "success" and forever_orders["data"]:
    for order in forever_orders["data"]:
        print(f"  ID: {order.get('orderId', 'N/A')} | "
              f"{order.get('tradingSymbol', 'N/A')} | "
              f"Type: {order.get('orderFlag', 'N/A')} | "
              f"Trigger: ₹{order.get('triggerPrice', 'N/A')}")
else:
    print("  No active forever orders")

# Example 4: Cancel a forever order
# dhan.cancel_forever(order_id="YOUR_ORDER_ID")
