"""Fetch and display a portfolio summary from DhanHQ."""

from scripts.dhan_helpers import format_pnl_report, get_client

dhan, _ = get_client()

holdings_resp = dhan.get_holdings()
positions_resp = dhan.get_positions()
funds_resp = dhan.get_fund_limits()
trades_resp = dhan.get_trade_book()

if not all(resp["status"] == "success" for resp in [holdings_resp, positions_resp, funds_resp, trades_resp]):
    raise SystemExit("One or more portfolio calls failed.")

holdings = holdings_resp["data"]
positions = positions_resp["data"]
funds = funds_resp["data"]
trades = trades_resp["data"]
summary = format_pnl_report(holdings_resp, positions_resp)

print("=" * 50)
print("             PORTFOLIO SUMMARY")
print("=" * 50)
print(f"\nHoldings count:   {summary['holdings_count']}")
print(f"Positions count:  {summary['positions_count']}")
print(f"Current value:    Rs. {summary['current_value']:>12,.2f}")
print(f"Total P&L:        Rs. {summary['total_pnl']:>12,.2f}")
print(f"Day P&L:          Rs. {summary['day_pnl']:>12,.2f}")

print("\nFUNDS")
print(f"  Available:      Rs. {funds['availabelBalance']:>12,.2f}")
print(f"  Utilized:       Rs. {funds['utilizedAmount']:>12,.2f}")
print(f"  Collateral:     Rs. {funds['collateralAmount']:>12,.2f}")
print(f"  Withdrawable:   Rs. {funds['withdrawableBalance']:>12,.2f}")

if holdings:
    print("\nTOP HOLDINGS")
    for holding in sorted(holdings, key=lambda row: row.get("totalQty", 0), reverse=True)[:5]:
        print(
            f"  {holding['tradingSymbol']:<15} "
            f"qty={holding['totalQty']:>5} "
            f"available={holding['availableQty']:>5}"
        )

open_positions = [row for row in positions if row["netQty"] != 0]
if open_positions:
    print("\nOPEN POSITIONS")
    for position in open_positions[:5]:
        pnl = position.get("realizedProfit", 0) + position.get("unrealizedProfit", 0)
        print(
            f"  {position['tradingSymbol']:<20} "
            f"netQty={position['netQty']:>5} "
            f"pnl=Rs. {pnl:>8,.0f}"
        )

print(f"\nTrades today:     {len(trades)}")
print("=" * 50)
