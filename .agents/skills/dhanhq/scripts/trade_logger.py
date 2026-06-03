"""Trade journal for logging and reviewing DhanHQ orders.

Persists trade data to ${CLAUDE_PLUGIN_DATA}/trades.jsonl so history
survives across sessions and skill upgrades.

Usage:
    from trade_logger import log_order, get_today_orders, get_trade_history
"""

import os
import json
from datetime import datetime, timedelta


def _get_log_path():
    """Get the stable path for trade log storage."""
    plugin_data = os.environ.get("CLAUDE_PLUGIN_DATA")
    if plugin_data:
        os.makedirs(plugin_data, exist_ok=True)
        return os.path.join(plugin_data, "trades.jsonl")
    # Fallback to skill directory (may not persist across upgrades)
    return os.path.join(os.path.dirname(__file__), "..", "data", "trades.jsonl")


def log_order(order_params, response, notes=""):
    """Append an order record to the trade journal.

    Args:
        order_params: dict of parameters passed to place_order()
        response: dict response from the DhanHQ API
        notes: Optional user-facing notes about this trade
    """
    log_path = _get_log_path()
    os.makedirs(os.path.dirname(log_path), exist_ok=True)

    record = {
        "timestamp": datetime.now().isoformat(),
        "order_params": order_params,
        "response": response,
        "order_id": response.get("data", {}).get("orderId") if isinstance(response.get("data"), dict) else None,
        "status": response.get("status"),
        "notes": notes,
    }

    with open(log_path, "a") as f:
        f.write(json.dumps(record) + "\n")

    return record


def _read_all_records():
    """Read all records from the trade log."""
    log_path = _get_log_path()
    if not os.path.exists(log_path):
        return []
    records = []
    with open(log_path) as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def get_today_orders():
    """Get all orders logged today.

    Returns:
        list of order records from today
    """
    today = datetime.now().date().isoformat()
    return [r for r in _read_all_records() if r["timestamp"].startswith(today)]


def get_trade_history(days=7):
    """Get order history for the last N days.

    Args:
        days: Number of days to look back (default 7)

    Returns:
        list of order records, newest first
    """
    cutoff = (datetime.now() - timedelta(days=days)).isoformat()
    records = [r for r in _read_all_records() if r["timestamp"] >= cutoff]
    return sorted(records, key=lambda r: r["timestamp"], reverse=True)


def get_trade_summary(days=7):
    """Generate a summary of recent trading activity.

    Returns:
        dict with total_orders, successful, failed, buy_count, sell_count,
        instruments_traded (unique set)
    """
    records = get_trade_history(days)
    summary = {
        "period_days": days,
        "total_orders": len(records),
        "successful": sum(1 for r in records if r.get("status") == "success"),
        "failed": sum(1 for r in records if r.get("status") != "success"),
        "buy_count": 0,
        "sell_count": 0,
        "instruments_traded": set(),
    }
    for r in records:
        params = r.get("order_params", {})
        txn = params.get("transaction_type", "")
        if txn == "BUY":
            summary["buy_count"] += 1
        elif txn == "SELL":
            summary["sell_count"] += 1
        sid = params.get("security_id") or params.get("trading_symbol")
        if sid:
            summary["instruments_traded"].add(str(sid))

    summary["instruments_traded"] = list(summary["instruments_traded"])
    return summary


def print_today_orders():
    """Print today's orders in a human-readable format."""
    orders = get_today_orders()
    if not orders:
        print("No orders placed today.")
        return

    print(f"--- Today's Orders ({len(orders)} total) ---")
    for r in orders:
        params = r.get("order_params", {})
        status = r.get("status", "unknown")
        oid = r.get("order_id", "N/A")
        txn = params.get("transaction_type", "?")
        sym = params.get("trading_symbol") or params.get("security_id", "?")
        qty = params.get("quantity", "?")
        price = params.get("price", "MKT")
        time = r["timestamp"].split("T")[1][:8]
        print(f"  [{time}] {status.upper():8s} | {txn:4s} {qty}x {sym} @ {price} | ID: {oid}")


if __name__ == "__main__":
    print_today_orders()
