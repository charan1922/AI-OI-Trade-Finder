#!/usr/bin/env python3
"""Resolve human-readable instruments to Dhan security IDs.

Usage:
    python scripts/resolve_security.py RELIANCE
    python scripts/resolve_security.py HDFC Bank
    python scripts/resolve_security.py NIFTY 24000 CE 2025-03-27

This script uses the current SDK security-master path
(`dhanhq.fetch_security_list`) instead of downloading the CSV directly.
"""

from __future__ import annotations

import sys

import pandas as pd
from dhanhq import dhanhq


def load_security_master(mode: str = "compact") -> pd.DataFrame:
    """Fetch the Dhan security master through the SDK."""

    print("Loading security master via dhanhq.fetch_security_list()...")
    security_master = dhanhq.fetch_security_list(mode)
    if security_master is None or security_master.empty:
        raise SystemExit("Unable to fetch the Dhan security master.")
    return security_master


def search_equity(df: pd.DataFrame, query: str, limit: int = 10) -> pd.DataFrame:
    """Return deterministic equity matches for NSE/BSE cash instruments."""

    query_upper = query.upper().strip()
    base_mask = (
        df["SEM_INSTRUMENT_NAME"].astype(str).str.upper() == "EQUITY"
    ) & df["SEM_EXM_EXCH_ID"].astype(str).str.upper().isin(["NSE", "BSE"])

    exact = df[
        base_mask
        & (df["SEM_TRADING_SYMBOL"].astype(str).str.upper() == query_upper)
    ]
    if not exact.empty:
        return exact[
            [
                "SEM_SMST_SECURITY_ID",
                "SEM_TRADING_SYMBOL",
                "SEM_CUSTOM_SYMBOL",
                "SEM_EXM_EXCH_ID",
                "SEM_INSTRUMENT_NAME",
            ]
        ].head(limit)

    contains = df[
        base_mask
        & df["SEM_CUSTOM_SYMBOL"].astype(str).str.upper().str.contains(query_upper, na=False)
    ]
    return contains[
        [
            "SEM_SMST_SECURITY_ID",
            "SEM_TRADING_SYMBOL",
            "SEM_CUSTOM_SYMBOL",
            "SEM_EXM_EXCH_ID",
            "SEM_INSTRUMENT_NAME",
        ]
    ].head(limit)


def search_derivative(
    df: pd.DataFrame,
    underlying: str,
    *,
    strike: float | None = None,
    option_type: str | None = None,
    expiry: str | None = None,
    limit: int = 20,
) -> pd.DataFrame:
    """Return derivative matches for options and futures."""

    base_mask = (
        df["SEM_CUSTOM_SYMBOL"].astype(str).str.upper() == underlying.upper().strip()
    ) & df["SEM_INSTRUMENT_NAME"].astype(str).str.upper().isin(
        ["OPTIDX", "OPTSTK", "FUTIDX", "FUTSTK"]
    )

    if option_type == "FUT":
        base_mask &= df["SEM_INSTRUMENT_NAME"].astype(str).str.upper().isin(["FUTIDX", "FUTSTK"])
    elif option_type in {"CE", "PE"}:
        base_mask &= df["SEM_OPTION_TYPE"].astype(str).str.upper() == option_type

    if strike is not None:
        base_mask &= df["SEM_STRIKE_PRICE"].astype(float) == float(strike)

    if expiry is not None:
        base_mask &= df["SEM_EXPIRY_DATE"].astype(str) == expiry

    results = df[base_mask].sort_values(
        by=["SEM_EXPIRY_DATE", "SEM_TRADING_SYMBOL"],
        na_position="last",
    )
    return results[
        [
            "SEM_SMST_SECURITY_ID",
            "SEM_TRADING_SYMBOL",
            "SEM_CUSTOM_SYMBOL",
            "SEM_EXM_EXCH_ID",
            "SEM_INSTRUMENT_NAME",
            "SEM_STRIKE_PRICE",
            "SEM_OPTION_TYPE",
            "SEM_EXPIRY_DATE",
            "SEM_LOT_UNITS",
            "SEM_TICK_SIZE",
        ]
    ].head(limit)


def parse_query(query: str) -> dict[str, str | float | None]:
    """Parse a free-form equity or derivative query."""

    parts = query.upper().split()

    if len(parts) <= 2 and not any(part in {"CE", "PE", "FUT", "FUTURE"} for part in parts):
        return {"type": "equity", "name": query}

    underlying = parts[0]
    strike = None
    option_type = None
    expiry = None

    for part in parts[1:]:
        if part in {"CE", "PE"}:
            option_type = part
        elif part in {"FUT", "FUTURE"}:
            option_type = "FUT"
        elif "-" in part and len(part) == 10:
            expiry = part
        else:
            try:
                strike = float(part)
            except ValueError:
                underlying += f" {part}"

    return {
        "type": "fno",
        "underlying": underlying,
        "strike": strike,
        "option_type": option_type,
        "expiry": expiry,
    }


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python scripts/resolve_security.py <query>")
        print('Examples: "RELIANCE", "HDFC Bank", "NIFTY 24000 CE 2025-03-27"')
        raise SystemExit(1)

    query = " ".join(sys.argv[1:])
    df = load_security_master()
    parsed = parse_query(query)

    if parsed["type"] == "equity":
        results = search_equity(df, str(parsed["name"]))
    else:
        results = search_derivative(
            df,
            str(parsed["underlying"]),
            strike=parsed["strike"],
            option_type=str(parsed["option_type"]) if parsed["option_type"] else None,
            expiry=str(parsed["expiry"]) if parsed["expiry"] else None,
        )

    if results.empty:
        print(f"No instruments found for: {query}")
        return

    print(f"\nResults for: {query}\n")
    print(results.to_string(index=False))


if __name__ == "__main__":
    main()
