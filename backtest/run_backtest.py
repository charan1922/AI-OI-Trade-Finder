"""
Backtest engine for the /backtest page — vectorbt as the accounting engine.

Reads the isolated, per-trade copy from the `bt_*` tables (built by
lib/backtest/bt-prepare.ts), and for each TAKEN trade:
  1. PRECOMPUTES the exact exit in plain Python (vectorbt has no native
     "previous candle's low" stop), matching the rules agreed in the app:
       - Entry  : the entry bar (default 09:45), filled at its close.
       - Stop   : the PREVIOUS candle's low, trailed UP only; on a gap straight
                  through, fill no better than that bar's open.
       - Profit : the +Rs.<profit_target> price level.
       - Time   : otherwise the last bar's close.
  2. BOOKS the trade with vectorbt (Portfolio.from_orders) at those exact
     fill prices → authoritative gross P&L and return%.

Rupee charges / net P&L / the cross-trade scoreboard are computed on the
TypeScript side (real Indian option charge model + sequential equity curve).

Usage:
  python run_backtest.py --db <path-to-project-r.db> --run-id <id> [--profit-target 5000]
"""

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import vectorbt as vbt

IST = timezone(timedelta(hours=5, minutes=30))
INIT_CASH = 1_000_000_000.0  # large enough to never constrain a single option lot

# Indian F&O OPTIONS transaction costs (from the vectorbt-expert skill,
# rules/indian-market-costs.md): ~0.098% statutory per side + Rs.20/order.
# Applied inside vectorbt so total_profit() is the NET P&L (after charges).
FEES_OPTIONS = 0.00098
FIXED_FEES_OPTIONS = 20.0


def _hhmm(unix: int) -> str:
    return datetime.fromtimestamp(unix, tz=IST).strftime("%H:%M")


def compute_exit(candles, entry_index, profit_target, lot):
    """Deterministic exit for one trade. `candles`: list of dicts with ts/o/h/l/c.
    Returns the entry/exit indices, prices, times, and reason."""
    n = len(candles)
    o = [c["open"] for c in candles]
    h = [c["high"] for c in candles]
    low = [c["low"] for c in candles]
    cl = [c["close"] for c in candles]
    ts = [c["ts"] for c in candles]

    entry_price = cl[entry_index]
    profit_level = entry_price + profit_target / lot
    trail = low[entry_index - 1]  # previous candle's low

    exit_index = None
    exit_price = None
    reason = None
    for i in range(entry_index + 1, n):
        trail = max(trail, low[i - 1])  # ratchet up to the previous completed candle
        if low[i] <= trail:  # stop-loss first (conservative)
            exit_index, exit_price, reason = i, min(trail, o[i]), "stop-loss"
            break
        if h[i] >= profit_level:
            exit_index, exit_price, reason = i, profit_level, "profit-target"
            break
        if i == n - 1:
            exit_index, exit_price, reason = i, cl[i], "time-exit"

    if exit_index is None:  # only the entry bar exists → flat
        exit_index, exit_price, reason = entry_index, entry_price, "time-exit"

    return {
        "entry_index": entry_index,
        "entry_price": round(float(entry_price), 4),
        "entry_time": _hhmm(ts[entry_index]),
        "exit_index": exit_index,
        "exit_price": round(float(exit_price), 4),
        "exit_time": _hhmm(ts[exit_index]),
        "exit_reason": reason,
    }


def book_with_vectorbt(candles, ex, lot):
    """Book the precomputed entry/exit with vectorbt at the exact fill prices,
    applying the Indian F&O OPTIONS cost model. vectorbt computes the NET P&L.
    Returns (gross_pnl, net_pnl, charges, return_pct)."""
    if ex["exit_index"] <= ex["entry_index"]:
        return 0.0, 0.0, 0.0, 0.0  # flat trade — nothing to book

    n = len(candles)
    idx = pd.to_datetime([c["ts"] + int(IST.utcoffset(None).total_seconds()) for c in candles], unit="s")
    close = pd.Series([c["close"] for c in candles], index=idx)
    size = pd.Series(np.zeros(n), index=idx)
    price = pd.Series([np.nan] * n, index=idx)
    size.iloc[ex["entry_index"]] = lot
    size.iloc[ex["exit_index"]] = -lot
    price.iloc[ex["entry_index"]] = ex["entry_price"]
    price.iloc[ex["exit_index"]] = ex["exit_price"]

    pf = vbt.Portfolio.from_orders(
        close=close,
        size=size,
        price=price,
        fees=FEES_OPTIONS,
        fixed_fees=FIXED_FEES_OPTIONS,
        init_cash=INIT_CASH,
        freq="5min",
    )
    net = float(pf.total_profit())  # after the options cost model
    gross = (ex["exit_price"] - ex["entry_price"]) * lot
    charges = gross - net
    recs = pf.trades.records_readable
    ret_pct = round(float(recs["Return"].iloc[0]) * 100, 2) if len(recs) else 0.0
    return round(gross, 2), round(net, 2), round(charges, 2), ret_pct


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--run-id", type=int, required=True)
    ap.add_argument("--profit-target", type=float, default=5000.0)
    args = ap.parse_args()

    # Plain connection (we only SELECT). Robust across journal/WAL modes vs a
    # read-only URI, which can fail to open a WAL database's shared-memory files.
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row

    trades = conn.execute(
        """SELECT id, symbol, date, option_type, strike, lot_size, entry_bar_index,
                  has_candles, taken
           FROM bt_trade WHERE run_id = ? ORDER BY date DESC""",
        (args.run_id,),
    ).fetchall()

    results = []
    for t in trades:
        base = {"trade_id": t["id"], "taken": int(t["taken"])}
        if not t["taken"]:
            results.append({**base, "status": "skipped"})
            continue
        if not t["has_candles"] or t["entry_bar_index"] is None:
            results.append({**base, "status": "no-candles"})
            continue
        if t["lot_size"] is None or float(t["lot_size"]) <= 0:
            results.append({**base, "status": "no-lot"})
            continue

        rows = conn.execute(
            """SELECT timestamp AS ts, open, high, low, close
               FROM bt_candle WHERE trade_id = ? ORDER BY bar_index ASC""",
            (t["id"],),
        ).fetchall()
        candles = [
            {
                "ts": int(r["ts"]),
                "open": float(r["open"]),
                "high": float(r["high"]),
                "low": float(r["low"]),
                "close": float(r["close"]),
            }
            for r in rows
        ]

        entry_index = int(t["entry_bar_index"])
        if entry_index < 1 or entry_index >= len(candles):
            results.append({**base, "status": "no-candles"})
            continue

        try:
            ex = compute_exit(candles, entry_index, args.profit_target, float(t["lot_size"]))
            gross, net, charges, ret_pct = book_with_vectorbt(candles, ex, float(t["lot_size"]))
            results.append({
                **base,
                "status": "ok",
                **ex,
                "gross_pnl": gross,
                "charges": charges,
                "net_pnl": net,
                "return_pct": ret_pct,
            })
        except Exception as e:  # noqa: BLE001 — report, never crash the whole run
            results.append({**base, "status": "error", "error": str(e)})

    conn.close()
    json.dump(results, sys.stdout)


if __name__ == "__main__":
    main()
