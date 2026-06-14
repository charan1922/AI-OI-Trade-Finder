"""Check margin requirements before placing an order via DhanHQ."""

from dhanhq import dhanhq

from scripts.dhan_helpers import check_margin, fetch_chain_df, find_atm_row, get_client

dhan, _ = get_client()

funds = dhan.get_fund_limits()
available = funds["data"]["availabelBalance"]
print(f"Available Balance: Rs. {available:,.2f}")

expiries = dhan.expiry_list(under_security_id=13, under_exchange_segment="IDX_I")
nearest_expiry = expiries["data"][0]
chain_df, spot = fetch_chain_df(dhan, under_security_id=13, expiry=nearest_expiry)
atm = find_atm_row(chain_df, spot)

print("\n--- Margin Check: Buy 1 Lot Nifty CE (INTRADAY) ---")
option_margin = check_margin(
    dhan,
    security_id=atm["ce_security_id"],
    exchange_segment=dhanhq.NSE_FNO,
    transaction_type=dhanhq.BUY,
    quantity=75,
    product_type=dhanhq.INTRA,
    price=float(atm["ce_ltp"]),
)
print(option_margin)

print("\n--- Margin Check: Buy 10 RELIANCE (CNC Delivery) ---")
equity_margin = check_margin(
    dhan,
    security_id="2885",
    exchange_segment=dhanhq.NSE,
    transaction_type=dhanhq.BUY,
    quantity=10,
    product_type=dhanhq.CNC,
    price=2450.0,
)
print(equity_margin)
