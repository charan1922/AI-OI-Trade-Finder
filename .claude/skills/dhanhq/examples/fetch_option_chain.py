"""Fetch and display the Nifty option chain using the repo helper layer."""

from scripts.dhan_helpers import fetch_chain_df, find_atm_row, get_client

dhan, _ = get_client()

expiries = dhan.expiry_list(under_security_id=13, under_exchange_segment="IDX_I")
nearest_expiry = expiries["data"][0]
print(f"Using expiry: {nearest_expiry}")

chain_df, spot = fetch_chain_df(dhan, under_security_id=13, expiry=nearest_expiry)
atm = find_atm_row(chain_df, spot)

print(f"Nifty Spot: {spot}")
print(f"ATM Strike: {atm['strike']}")

view = chain_df[
    ["strike", "ce_ltp", "ce_oi", "ce_iv", "pe_ltp", "pe_oi", "pe_iv"]
].copy()
nearby = view[(view["strike"] >= atm["strike"] - 500) & (view["strike"] <= atm["strike"] + 500)]

print("\nOption Chain (ATM ± 500 points):\n")
print(nearby.to_string(index=False))
