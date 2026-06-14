"""Prepare a super order with target and trailing stop loss."""

from dhanhq import OrderUpdate, dhanhq

from scripts.dhan_helpers import get_client

dhan, dhan_context = get_client()

ltp_data = dhan.ticker_data({"NSE_EQ": [2885]})
if ltp_data["status"] != "success":
    raise SystemExit(ltp_data["remarks"])

reliance_ltp = float(ltp_data["data"]["NSE_EQ"]["2885"]["last_price"])
print(f"Reliance LTP: Rs. {reliance_ltp:,.2f}")

entry_price = reliance_ltp
target_price = round(entry_price * 1.02, 2)
sl_price = round(entry_price * 0.99, 2)
trailing_jump = 5.0

print("\n--- Super Order Preview ---")
print("Action:        BUY 1 share of RELIANCE")
print(f"Entry Price:   Rs. {entry_price:,.2f}")
print(f"Target:        Rs. {target_price:,.2f}")
print(f"Stop Loss:     Rs. {sl_price:,.2f}")
print(f"Trailing Jump: Rs. {trailing_jump:,.2f}")
print("Product:       INTRADAY")

# Uncomment after confirmation:
# response = dhan.place_super_order(
#     security_id="2885",
#     exchange_segment=dhanhq.NSE,
#     transaction_type=dhanhq.BUY,
#     quantity=1,
#     order_type=dhanhq.LIMIT,
#     product_type=dhanhq.INTRA,
#     price=entry_price,
#     targetPrice=target_price,
#     stopLossPrice=sl_price,
#     trailingJump=trailing_jump,
#     tag="super_example",
# )
#
# if response["status"] == "success":
#     print(response["data"])
#
#     def on_update(data):
#         print(f"Update: {data}")
#
#     order_ws = OrderUpdate(dhan_context)
#     order_ws.on_update = on_update
#     order_ws.connect_to_dhan_websocket_sync()
