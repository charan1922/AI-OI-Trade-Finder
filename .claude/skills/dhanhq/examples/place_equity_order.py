"""Prepare a simple equity delivery order on NSE via DhanHQ."""

from dhanhq import dhanhq

from scripts.dhan_helpers import get_client, preview_order

dhan, _ = get_client()

security_id = "2885"  # RELIANCE
price = 2450.0
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

# Uncomment after confirmation:
# response = dhan.place_order(
#     security_id=security_id,
#     exchange_segment=dhanhq.NSE,
#     transaction_type=dhanhq.BUY,
#     quantity=quantity,
#     order_type=dhanhq.LIMIT,
#     product_type=dhanhq.CNC,
#     price=price,
#     validity=dhanhq.DAY,
#     tag="example_order",
# )
# print(response)
