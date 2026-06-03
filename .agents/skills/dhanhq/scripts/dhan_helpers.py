"""Composable helper functions for DhanHQ trading workflows.

The DhanHQ Python SDK wraps HTTP responses as:
    {"status": "success|failure", "remarks": ..., "data": ...}

The helper functions in this file keep that SDK wrapper explicit while also
providing a small set of repo-defined normalization utilities for analysis.
Most notably, option-chain normalization lives here so the docs can stay
clear about what is raw Dhan payload and what is repo-defined convenience.
"""

from __future__ import annotations

import json
import os
from typing import Any

import pandas as pd
from dhanhq import DhanContext, dhanhq


def _load_config(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def get_client(config_path: str | None = None):
    """Initialize a DhanHQ client from config or environment variables.

    Resolution order:
    1. Explicit ``config_path``
    2. ``DHAN_CONFIG_PATH`` environment variable
    3. ``config.json`` in the current working directory
    4. ``DHAN_CLIENT_ID`` + ``DHAN_ACCESS_TOKEN`` environment variables
    """

    client_id = None
    access_token = None

    paths_to_try = [
        config_path,
        os.environ.get("DHAN_CONFIG_PATH"),
        "config.json",
    ]

    for path in paths_to_try:
        if not path or not os.path.exists(path):
            continue
        config = _load_config(path)
        client_id = config.get("client_id") or client_id
        access_token = config.get("access_token") or access_token
        if client_id and access_token:
            break

    client_id = client_id or os.environ.get("DHAN_CLIENT_ID")
    access_token = access_token or os.environ.get("DHAN_ACCESS_TOKEN")

    if not client_id or not access_token:
        raise ValueError(
            "Credentials not found. Set DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN, "
            "or point DHAN_CONFIG_PATH to a config file."
        )

    context = DhanContext(client_id, access_token)
    return dhanhq(context), context


def unwrap_sdk_data(response: dict[str, Any]) -> Any:
    """Return the ``data`` field from a successful SDK response.

    Raises:
        ValueError: if the SDK response is not successful.
    """

    if response.get("status") != "success":
        raise ValueError(response.get("remarks") or "Dhan SDK call failed")
    return response.get("data")


_security_master_cache: pd.DataFrame | None = None


def get_security_master(mode: str = "compact") -> pd.DataFrame:
    """Fetch and cache the Dhan security master.

    The SDK downloads the CSV locally and returns a DataFrame.
    """

    global _security_master_cache
    if _security_master_cache is None:
        _security_master_cache = dhanhq.fetch_security_list(mode)
        if _security_master_cache is None:
            raise ValueError("Unable to fetch the Dhan security master")
    return _security_master_cache


def resolve_symbol(
    symbol: str,
    exchange_segment: str = "NSE_EQ",
    instrument_name: str = "EQUITY",
) -> dict[str, Any] | None:
    """Resolve a cash-market symbol to a security ID using the security master."""

    df = get_security_master()
    query = symbol.upper().strip()
    exchange = exchange_segment.split("_")[0]

    exact = df[
        (df["SEM_EXM_EXCH_ID"].astype(str).str.upper() == exchange)
        & (df["SEM_INSTRUMENT_NAME"].astype(str).str.upper() == instrument_name.upper())
        & (df["SEM_TRADING_SYMBOL"].astype(str).str.upper() == query)
    ]
    if exact.empty:
        exact = df[
            (df["SEM_EXM_EXCH_ID"].astype(str).str.upper() == exchange)
            & (df["SEM_INSTRUMENT_NAME"].astype(str).str.upper() == instrument_name.upper())
            & (df["SEM_CUSTOM_SYMBOL"].astype(str).str.upper().str.contains(query, na=False))
        ]
    if exact.empty:
        return None

    row = exact.iloc[0]
    return {
        "security_id": str(row["SEM_SMST_SECURITY_ID"]),
        "trading_symbol": str(row["SEM_TRADING_SYMBOL"]),
        "display_name": str(row.get("SEM_CUSTOM_SYMBOL", "")),
        "exchange_segment": exchange_segment,
        "instrument_name": str(row["SEM_INSTRUMENT_NAME"]),
    }


def resolve_derivative(
    underlying: str,
    *,
    instrument_names: tuple[str, ...] = ("OPTIDX", "OPTSTK", "FUTIDX", "FUTSTK"),
    strike: float | None = None,
    option_type: str | None = None,
    expiry: str | None = None,
    exchange: str = "NSE",
) -> dict[str, Any] | None:
    """Resolve a derivative contract from the security master."""

    df = get_security_master()
    mask = (
        (df["SEM_EXM_EXCH_ID"].astype(str).str.upper() == exchange.upper())
        & (df["SEM_INSTRUMENT_NAME"].isin(instrument_names))
        & (df["SEM_CUSTOM_SYMBOL"].astype(str).str.upper() == underlying.upper())
    )

    if strike is not None:
        mask &= df["SEM_STRIKE_PRICE"].astype(float) == float(strike)
    if option_type is not None:
        mask &= df["SEM_OPTION_TYPE"].astype(str).str.upper() == option_type.upper()
    if expiry is not None:
        mask &= df["SEM_EXPIRY_DATE"].astype(str) == expiry

    matches = df[mask].sort_values(["SEM_EXPIRY_DATE", "SEM_TRADING_SYMBOL"])
    if matches.empty:
        return None

    row = matches.iloc[0]
    return {
        "security_id": str(row["SEM_SMST_SECURITY_ID"]),
        "trading_symbol": str(row["SEM_TRADING_SYMBOL"]),
        "lot_size": int(row["SEM_LOT_UNITS"]),
        "tick_size": float(row["SEM_TICK_SIZE"]),
        "expiry": str(row.get("SEM_EXPIRY_DATE", "")),
        "instrument_name": str(row["SEM_INSTRUMENT_NAME"]),
    }


def get_lot_size(
    *,
    security_id: str | None = None,
    trading_symbol: str | None = None,
    underlying: str | None = None,
) -> int | None:
    """Return lot size from the security master when possible."""

    df = get_security_master()

    if security_id is not None:
        match = df[df["SEM_SMST_SECURITY_ID"].astype(str) == str(security_id)]
        if not match.empty:
            return int(match.iloc[0]["SEM_LOT_UNITS"])

    if trading_symbol is not None:
        match = df[df["SEM_TRADING_SYMBOL"].astype(str).str.upper() == trading_symbol.upper()]
        if not match.empty:
            return int(match.iloc[0]["SEM_LOT_UNITS"])

    if underlying is not None:
        match = df[
            (df["SEM_CUSTOM_SYMBOL"].astype(str).str.upper() == underlying.upper())
            & (df["SEM_INSTRUMENT_NAME"].isin(["OPTIDX", "OPTSTK", "FUTIDX", "FUTSTK"]))
        ]
        if not match.empty:
            return int(match.iloc[0]["SEM_LOT_UNITS"])

    return None


def preview_order(
    security_id: str,
    exchange_segment: str,
    transaction_type: str,
    quantity: int,
    order_type: str,
    product_type: str,
    *,
    price: float = 0.0,
    trading_symbol: str | None = None,
) -> str:
    """Build a human-readable order preview for confirmation."""

    notional = price * quantity if price else 0
    lines = [
        "--- ORDER PREVIEW ---",
        f"Security:     {trading_symbol or security_id}",
        f"Exchange:     {exchange_segment}",
        f"Action:       {transaction_type}",
        f"Quantity:     {quantity}",
        f"Order Type:   {order_type}",
        f"Product Type: {product_type}",
        f"Price:        {'MARKET / MPP' if order_type == 'MARKET' else f'Rs. {price:,.2f}'}",
    ]
    if notional:
        lines.append(f"Notional:     Rs. {notional:,.2f}")
    if notional > 50000:
        lines.append("Warning:      Notional exceeds Rs. 50,000")
    lines.append("---------------------")
    return "\n".join(lines)


def normalize_option_chain(response: dict[str, Any]) -> tuple[float, list[dict[str, Any]]]:
    """Normalize raw option-chain data into analysis-friendly rows.

    Raw REST response:
    - underlying spot is ``data.last_price``
    - strikes are keyed under ``data.oc`` as strings like ``"25650.000000"``

    Normalized row fields are repo-defined conveniences like:
    - ``strike``
    - ``ce_ltp`` / ``pe_ltp``
    - ``ce_oi`` / ``pe_oi``
    - ``ce_iv`` / ``pe_iv``
    - ``ce_delta`` / ``pe_delta``
    """

    data = unwrap_sdk_data(response)
    spot = float(data["last_price"])
    option_chain = data.get("oc", {}) or {}

    rows: list[dict[str, Any]] = []
    for strike_key, strike_payload in sorted(option_chain.items(), key=lambda item: float(item[0])):
        row: dict[str, Any] = {"strike": float(strike_key)}

        for side in ("ce", "pe"):
            leg = strike_payload.get(side) or {}
            greeks = leg.get("greeks") or {}
            row[f"{side}_security_id"] = str(leg["security_id"]) if leg.get("security_id") is not None else None
            row[f"{side}_ltp"] = leg.get("last_price")
            row[f"{side}_avg_price"] = leg.get("average_price")
            row[f"{side}_oi"] = leg.get("oi")
            row[f"{side}_oi_change"] = leg.get("oi_change")
            row[f"{side}_volume"] = leg.get("volume")
            row[f"{side}_iv"] = leg.get("implied_volatility")
            row[f"{side}_bid_price"] = leg.get("top_bid_price")
            row[f"{side}_bid_qty"] = leg.get("top_bid_quantity")
            row[f"{side}_ask_price"] = leg.get("top_ask_price")
            row[f"{side}_ask_qty"] = leg.get("top_ask_quantity")
            row[f"{side}_delta"] = greeks.get("delta")
            row[f"{side}_gamma"] = greeks.get("gamma")
            row[f"{side}_theta"] = greeks.get("theta")
            row[f"{side}_vega"] = greeks.get("vega")

        rows.append(row)

    return spot, rows


def fetch_chain_df(
    dhan_client,
    under_security_id: int,
    expiry: str,
    under_exchange_segment: str = "IDX_I",
) -> tuple[pd.DataFrame, float]:
    """Fetch option-chain data and return a normalized DataFrame plus spot."""

    response = dhan_client.option_chain(
        under_security_id=under_security_id,
        under_exchange_segment=under_exchange_segment,
        expiry=expiry,
    )
    spot, rows = normalize_option_chain(response)
    return pd.DataFrame(rows), spot


def find_atm_row(chain_df: pd.DataFrame, spot: float) -> pd.Series:
    """Return the nearest strike row to the provided spot value."""

    return chain_df.iloc[(chain_df["strike"] - spot).abs().argsort().iloc[0]]


def format_pnl_report(holdings_response: dict[str, Any], positions_response: dict[str, Any]) -> dict[str, Any]:
    """Generate a small structured P&L summary from SDK responses."""

    holdings = unwrap_sdk_data(holdings_response)
    positions = unwrap_sdk_data(positions_response)

    report = {
        "total_investment": 0.0,
        "current_value": 0.0,
        "total_pnl": 0.0,
        "day_pnl": 0.0,
        "holdings_count": len(holdings or []),
        "positions_count": len(positions or []),
    }

    for holding in holdings or []:
        total_qty = holding.get("totalQty", 0)
        report["total_investment"] += holding.get("avgCostPrice", 0) * total_qty
        report["current_value"] += holding.get("marketValue", 0)
        report["total_pnl"] += holding.get("pnl", 0)
        report["day_pnl"] += holding.get("dayPnl", 0)

    for position in positions or []:
        report["total_pnl"] += position.get("realizedProfit", 0) + position.get("unrealizedProfit", 0)

    return report


def check_margin(
    dhan_client,
    *,
    security_id: str,
    exchange_segment: str,
    transaction_type: str,
    quantity: int,
    product_type: str,
    price: float,
    trigger_price: float = 0,
) -> dict[str, Any]:
    """Run a single-order margin check against the current SDK."""

    margin_response = dhan_client.margin_calculator(
        security_id=security_id,
        exchange_segment=exchange_segment,
        transaction_type=transaction_type,
        quantity=quantity,
        product_type=product_type,
        price=price,
        trigger_price=trigger_price,
    )
    funds_response = dhan_client.get_fund_limits()

    margin = unwrap_sdk_data(margin_response)
    funds = unwrap_sdk_data(funds_response)

    total_margin = margin.get("totalMargin", 0.0)
    available_balance = funds.get("availabelBalance", 0.0)

    return {
        "total_margin": total_margin,
        "available_balance": available_balance,
        "brokerage": margin.get("brokerage", 0.0),
        "leverage": margin.get("leverage"),
        "sufficient": available_balance >= total_margin,
        "shortfall": max(0.0, total_margin - available_balance),
    }
