#!/usr/bin/env python3
"""Pre-flight order validation for DhanHQ orders.

This validator is intentionally conservative. It checks obvious SDK/order-rule
issues before an order is placed, while treating hardcoded lot sizes and freeze
quantities as fallback heuristics only.
"""

from __future__ import annotations

from datetime import datetime


# These are fallback heuristics only. Prefer security-master-derived values.
LOT_SIZES = {
    "NIFTY": 75,
    "BANKNIFTY": 15,
    "FINNIFTY": 25,
    "MIDCPNIFTY": 50,
    "SENSEX": 10,
}

# Fallback freeze-quantity heuristics only.
FREEZE_QTY = {
    "NIFTY": 1800,
    "BANKNIFTY": 900,
    "FINNIFTY": 1000,
    "MIDCPNIFTY": 2800,
    "SENSEX": 500,
}

VALID_EXCHANGE_SEGMENTS = {
    "NSE_EQ",
    "BSE_EQ",
    "NSE_FNO",
    "BSE_FNO",
    "MCX_COMM",
    "NSE_CURRENCY",
    "BSE_CURRENCY",
}

EQUITY_SEGMENTS = {"NSE_EQ", "BSE_EQ"}
DERIVATIVE_SEGMENTS = {"NSE_FNO", "BSE_FNO", "MCX_COMM", "NSE_CURRENCY", "BSE_CURRENCY"}

EQUITY_PRODUCT_TYPES = {"CNC", "INTRADAY", "MARGIN", "MTF"}
DERIVATIVE_PRODUCT_TYPES = {"INTRADAY", "MARGIN"}

VALID_ORDER_TYPES = {"LIMIT", "MARKET", "STOP_LOSS", "STOP_LOSS_MARKET"}
VALID_TRANSACTION_TYPES = {"BUY", "SELL"}
VALID_VALIDITY = {"DAY", "IOC"}

NOTIONAL_WARNING_THRESHOLD = 50000


def _infer_lot_size(trading_symbol: str | None) -> int | None:
    if not trading_symbol:
        return None

    symbol_upper = trading_symbol.upper()
    for name, lot_size in LOT_SIZES.items():
        if name in symbol_upper:
            return lot_size
    return None


def _infer_freeze_qty(trading_symbol: str | None) -> int | None:
    if not trading_symbol:
        return None

    symbol_upper = trading_symbol.upper()
    for name, freeze_qty in FREEZE_QTY.items():
        if name in symbol_upper:
            return freeze_qty
    return None


def validate_order(
    *,
    security_id: str | None = None,
    exchange_segment: str | None = None,
    transaction_type: str | None = None,
    quantity: int | None = None,
    order_type: str | None = None,
    product_type: str | None = None,
    price: float = 0,
    trigger_price: float = 0,
    validity: str = "DAY",
    after_market_order: bool = False,
    trading_symbol: str | None = None,
    lot_size: int | None = None,
) -> dict[str, object]:
    """Validate common DhanHQ order parameters before placement."""

    errors: list[str] = []
    warnings: list[str] = []

    exchange_segment = exchange_segment.upper() if exchange_segment else exchange_segment
    transaction_type = transaction_type.upper() if transaction_type else transaction_type
    order_type = order_type.upper() if order_type else order_type
    product_type = product_type.upper() if product_type else product_type
    validity = validity.upper() if validity else validity

    if not security_id:
        errors.append("security_id is required")
    if not exchange_segment:
        errors.append("exchange_segment is required")
    if not transaction_type:
        errors.append("transaction_type is required")
    if quantity is None or quantity <= 0:
        errors.append("quantity must be a positive integer")
    if not order_type:
        errors.append("order_type is required")
    if not product_type:
        errors.append("product_type is required")

    if exchange_segment and exchange_segment not in VALID_EXCHANGE_SEGMENTS:
        errors.append(f"Invalid exchange_segment: {exchange_segment}")
    if transaction_type and transaction_type not in VALID_TRANSACTION_TYPES:
        errors.append(f"Invalid transaction_type: {transaction_type}")
    if order_type and order_type not in VALID_ORDER_TYPES:
        errors.append(f"Invalid order_type: {order_type}")
    if validity and validity not in VALID_VALIDITY:
        errors.append(f"Invalid validity: {validity}")

    if order_type in {"LIMIT", "STOP_LOSS"} and price <= 0:
        errors.append(f"price is required for {order_type} orders")
    if order_type in {"STOP_LOSS", "STOP_LOSS_MARKET"} and trigger_price <= 0:
        errors.append(f"trigger_price is required for {order_type} orders")

    if exchange_segment in EQUITY_SEGMENTS and product_type and product_type not in EQUITY_PRODUCT_TYPES:
        errors.append(
            f"Invalid product_type '{product_type}' for equity segment '{exchange_segment}'. "
            f"Valid values: {sorted(EQUITY_PRODUCT_TYPES)}"
        )

    if exchange_segment in DERIVATIVE_SEGMENTS and product_type and product_type not in DERIVATIVE_PRODUCT_TYPES:
        errors.append(
            f"Invalid product_type '{product_type}' for derivative segment '{exchange_segment}'. "
            f"Valid values: {sorted(DERIVATIVE_PRODUCT_TYPES)}"
        )

    if order_type == "MARKET":
        warnings.append(
            "Dhan's current order docs say API market orders are converted to limit orders with MPP."
        )

    effective_lot_size = lot_size or _infer_lot_size(trading_symbol)
    if exchange_segment in DERIVATIVE_SEGMENTS and quantity:
        if effective_lot_size is not None and quantity % effective_lot_size != 0:
            errors.append(
                f"Derivative quantity must be a multiple of lot size {effective_lot_size}. Got {quantity}."
            )
        elif effective_lot_size is None:
            warnings.append(
                "Could not resolve a lot size from the provided data. Confirm lot size from the security master before placing."
            )

        freeze_qty = _infer_freeze_qty(trading_symbol)
        if freeze_qty is not None and quantity > freeze_qty:
            warnings.append(
                f"Quantity {quantity} exceeds fallback freeze quantity {freeze_qty}. "
                "Consider place_slice_order() after verifying the latest exchange freeze limits."
            )

    if price and quantity:
        notional = price * quantity
        if notional > NOTIONAL_WARNING_THRESHOLD:
            warnings.append(
                f"High notional value: Rs. {notional:,.2f} exceeds the Rs. 50,000 warning threshold."
            )

    if not after_market_order:
        now = datetime.now()
        if now.weekday() >= 5:
            warnings.append("Market is closed on weekends. Use AMO only if that is intentional.")
        elif now.hour < 9 or (now.hour == 9 and now.minute < 15):
            warnings.append("Regular market is not yet open.")
        elif now.hour > 15 or (now.hour == 15 and now.minute > 30):
            warnings.append("Regular market is closed. Use AMO only if that is intentional.")

    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
    }


def print_validation(result: dict[str, object]) -> None:
    """Pretty-print validation output."""

    if result["valid"]:
        print("Order validation: PASS")
    else:
        print("Order validation: FAIL")
        for error in result["errors"]:
            print(f"  ERROR: {error}")

    for warning in result["warnings"]:
        print(f"  WARNING: {warning}")


if __name__ == "__main__":
    sample = validate_order(
        security_id="2885",
        exchange_segment="NSE_EQ",
        transaction_type="BUY",
        quantity=10,
        order_type="LIMIT",
        product_type="CNC",
        price=2450,
    )
    print_validation(sample)
