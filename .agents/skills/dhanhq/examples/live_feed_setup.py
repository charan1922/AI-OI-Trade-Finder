"""Set up a live market data feed using DhanHQ WebSocket."""

from dhanhq import MarketFeed

from scripts.dhan_helpers import get_client

_, dhan_context = get_client()

# Define instruments to subscribe
# Format: (exchange_segment, security_id, subscription_mode)
instruments = [
    (MarketFeed.NSE, "2885", MarketFeed.Ticker),     # RELIANCE — LTP only
    (MarketFeed.NSE, "1333", MarketFeed.Quote),       # HDFCBANK — OHLC + Volume
    (MarketFeed.NSE, "11536", MarketFeed.Full),       # TCS — Full packet
]


def on_connect(instance):
    """Called when WebSocket connection is established."""
    print("Connected to DhanHQ MarketFeed")


def on_message(instance, message):
    """Called on every tick update."""
    print(f"Tick: {message}")


def on_close(instance):
    """Called when WebSocket connection is closed."""
    print("Disconnected")


# Create and start the feed
feed = MarketFeed(
    dhan_context,
    instruments,
    "v2",
    on_connect=on_connect,
    on_message=on_message,
    on_close=on_close,
)

print("Starting live market feed... (Ctrl+C to stop)")
try:
    feed.run_forever()
except KeyboardInterrupt:
    feed.close_connection()
    print("\nFeed stopped.")
