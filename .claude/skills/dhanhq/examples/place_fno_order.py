"""Prepare a Nifty option order using current option-chain data."""

from dhanhq import dhanhq

from scripts.dhan_helpers import (
    check_margin,
    fetch_chain_df,
    find_atm_row,
    get_client,
    get_lot_size,
    preview_order,
)

dhan, _ = get_client()

expiries = dhan.expiry_list(under_security_id=13, under_exchange_segment="IDX_I")
nearest_expiry = expiries["data"][0]
print(f"Nearest expiry: {nearest_expiry}")

chain_df, spot = fetch_chain_df(dhan, under_security_id=13, expiry=nearest_expiry)
atm = find_atm_row(chain_df, spot)

ce_security_id = atm["ce_security_id"]
ce_ltp = float(atm["ce_ltp"])
lot_size = get_lot_size(underlying="NIFTY") or 75
quantity = lot_size

print(f"Nifty spot: {spot}")
print(f"ATM strike: {atm['strike']}")
print(f"CE security ID: {ce_security_id}, LTP: Rs. {ce_ltp:,.2f}")

print()
print(
    preview_order(
        security_id=ce_security_id,
        exchange_segment=dhanhq.NSE_FNO,
        transaction_type=dhanhq.BUY,
        quantity=quantity,
        order_type=dhanhq.LIMIT,
        product_type=dhanhq.INTRA,
        price=ce_ltp,
        trading_symbol=f"NIFTY {int(atm['strike'])} CE",
    )
)

margin = check_margin(
    dhan,
    security_id=ce_security_id,
    exchange_segment=dhanhq.NSE_FNO,
    transaction_type=dhanhq.BUY,
    quantity=quantity,
    product_type=dhanhq.INTRA,
    price=ce_ltp,
)

print(
    f"Margin check: sufficient={margin['sufficient']} "
    f"required=Rs. {margin['total_margin']:,.2f} "
    f"available=Rs. {margin['available_balance']:,.2f}"
)

# Uncomment only after confirmation:
# response = dhan.place_order(
#     security_id=ce_security_id,
#     exchange_segment=dhanhq.NSE_FNO,
#     transaction_type=dhanhq.BUY,
#     quantity=quantity,
#     order_type=dhanhq.LIMIT,
#     product_type=dhanhq.INTRA,
#     price=ce_ltp,
#     validity=dhanhq.DAY,
# )
# print(response)
