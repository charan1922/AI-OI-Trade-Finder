"""Build and analyze a Nifty iron condor from normalized option-chain data."""

import numpy as np

from scripts.dhan_helpers import fetch_chain_df, get_client

dhan, _ = get_client()

expiries = dhan.expiry_list(under_security_id=13, under_exchange_segment="IDX_I")
nearest_expiry = expiries["data"][0]

chain_df, spot = fetch_chain_df(dhan, under_security_id=13, expiry=nearest_expiry)
print(f"Nifty Spot: {spot}, Expiry: {nearest_expiry}")

strike_prices = sorted(chain_df["strike"].tolist())
sell_ce_strike = min(strike_prices, key=lambda x: abs(x - (spot + 200)))
buy_ce_strike = sell_ce_strike + 200
sell_pe_strike = min(strike_prices, key=lambda x: abs(x - (spot - 200)))
buy_pe_strike = sell_pe_strike - 200


def get_row(target_strike):
    match = chain_df[chain_df["strike"] == target_strike]
    return None if match.empty else match.iloc[0]


sell_ce = get_row(sell_ce_strike)
buy_ce = get_row(buy_ce_strike)
sell_pe = get_row(sell_pe_strike)
buy_pe = get_row(buy_pe_strike)

if any(row is None for row in [sell_ce, buy_ce, sell_pe, buy_pe]):
    raise SystemExit("Could not find all required strikes. Try different offsets.")

lot_size = 65  # fallback — prefer get_lot_size("NIFTY") from security master
legs = [
    {
        "label": f"Sell {int(sell_pe_strike)} PE",
        "type": "PE",
        "strike": sell_pe_strike,
        "premium": float(sell_pe["pe_ltp"]),
        "qty": -1,
        "sid": sell_pe["pe_security_id"],
    },
    {
        "label": f"Buy {int(buy_pe_strike)} PE",
        "type": "PE",
        "strike": buy_pe_strike,
        "premium": float(buy_pe["pe_ltp"]),
        "qty": 1,
        "sid": buy_pe["pe_security_id"],
    },
    {
        "label": f"Sell {int(sell_ce_strike)} CE",
        "type": "CE",
        "strike": sell_ce_strike,
        "premium": float(sell_ce["ce_ltp"]),
        "qty": -1,
        "sid": sell_ce["ce_security_id"],
    },
    {
        "label": f"Buy {int(buy_ce_strike)} CE",
        "type": "CE",
        "strike": buy_ce_strike,
        "premium": float(buy_ce["ce_ltp"]),
        "qty": 1,
        "sid": buy_ce["ce_security_id"],
    },
]

net_premium = sum(-leg["qty"] * leg["premium"] for leg in legs)
spot_range = np.arange(spot - 1000, spot + 1000, 10)
payoff = np.zeros_like(spot_range, dtype=float)

for leg in legs:
    if leg["type"] == "CE":
        intrinsic = np.maximum(spot_range - leg["strike"], 0)
    else:
        intrinsic = np.maximum(leg["strike"] - spot_range, 0)
    payoff += (intrinsic - leg["premium"]) * leg["qty"] * lot_size

max_profit = payoff.max()
max_loss = payoff.min()
sign_changes = np.where(np.diff(np.sign(payoff)))[0]
breakevens = spot_range[sign_changes]

print(f"\n{'=' * 55}")
print(f"  NIFTY IRON CONDOR — Expiry: {nearest_expiry}")
print(f"{'=' * 55}")
print("\n  Legs:")
for leg in legs:
    action = "SELL" if leg["qty"] < 0 else "BUY "
    print(f"    {action} 1 lot {leg['label']} @ Rs. {leg['premium']:.1f}")

print(f"\n  Analysis (1 lot = {lot_size} qty):")
print(f"    Net Premium:   Rs. {net_premium * lot_size:>8,.0f} ({'credit' if net_premium > 0 else 'debit'})")
print(f"    Max Profit:    Rs. {max_profit:>8,.0f}")
print(f"    Max Loss:      Rs. {max_loss:>8,.0f}")
print(f"    Breakevens:    {', '.join(f'{b:.0f}' for b in breakevens)}")
print(f"    Risk/Reward:   1:{abs(max_profit / max_loss):.1f}" if max_loss != 0 else "")

print("\n  Orders to place after confirmation:")
for leg in legs:
    action = "SELL" if leg["qty"] < 0 else "BUY"
    print(f"    {action} {lot_size} qty | SID: {leg['sid']} | Rs. {leg['premium']:.1f}")
