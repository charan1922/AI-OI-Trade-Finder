# Live-loss review — 2026-07-22

## Status and safety boundary

This review uses the full read-only production database clone pulled on
2026-07-22. Production was not written to or reconfigured.

The configurable cash-target implementation described below is currently a
local working-tree change. It is not active in production until it is reviewed,
committed, deployed, and its effective production setting is confirmed.

## Confirmed results

The profitable reference session was 2026-07-15:

- HYUNDAI: -₹1,911
- MANKIND: +₹3,988
- PATANJALI: +₹6,504
- day total: +₹8,581

The completed losing sessions after it were:

- 2026-07-17 AXISBANK: -₹1,344
- 2026-07-20 COLPAL: -₹1,499
- 2026-07-21 INDUSINDBK: -₹1,785
- 2026-07-22 POLYCAB: -₹2,056
- 2026-07-22 NESTLEIND: -₹1,725
- post-profit-day total: -₹8,409

Across all ten completed live trades retained from 14–22 July, actual realized
P&L is +₹4,882.

## What the tag comparison proves

`v1.18.0` was created at 11:24 IST on the +₹8,581 day. `v1.19.0` was created
after market at 16:14 and primarily added EOD history.

The auto-trader's entry doctrine and the core scanner thresholds remained the
same after `v1.18.0`: R-Factor 3.6, confidence 0.2, futures OI 1.1× or the
qualified NSE combined-OI path, trend alignment, and breakout evidence. The
later default chaotic-open gate is restrictive: it can block a candidate but
cannot admit a weaker one. Rank-climb and the other permissive bypasses are OFF
in the pulled production settings.

Most post-profit commits added safety or measurement: faster guards, executable
bid checks, stale-candle blocking, broker reconciliation, risk latches, and
shadow metrics. These do not explain why the five losing entries were admitted.

The material operating difference is time. The tagged default entry window was
09:45–11:00. The pulled production setting is 09:45–12:15, and the scanner
window is also extended to 12:15. COLPAL and NESTLEIND both entered at 11:10, so
the old tagged window would have blocked those two trades. The settings table
keeps only the latest value, so it cannot prove the exact setting-change moment
for COLPAL; it does prove the current production override and that NESTLEIND was
allowed by it.

## Today's two losses

### POLYCAB 9100 CE

- Entry fill: ₹127 at 10:11; exit: ₹110.55 at 10:24; realized: -₹2,056.
- The completed 10:05 candle closed at 9080, above the 8992 opening-range high,
  with strong volume. This passed a standard completed-candle ORB test.
- The retained 10:15 option LTP was ₹150.73.
- The old live target was ₹167, equivalent to roughly +₹5,000 for one lot.
- A ₹1,100 target from the actual fill is ₹135.80, which the retained LTP
  exceeded by ₹14.93.

### NESTLEIND 1500 CE

- Entry fill: ₹32.75 at 11:10; exit: ₹29.30 at 11:16; realized: -₹1,725.
- The completed 11:05 candle closed at 1491.5, above the 1472.9 opening-range
  high. Volume and sector direction supported the breakout.
- Futures OI continued rising; low or falling OI was not the cause of rejection
  or failure here.
- The position-management tool retained an exact-contract LTP of ₹35.75 at
  11:16, shortly before the stop.
- A ₹1,100 target from the actual fill is ₹34.95, 80 paise below that retained
  LTP.

Both entries therefore passed the proposed completed-candle ORB + hold + volume

- sector rule. Adding that rule alone would not have prevented either loss.
  Today's R-Factor also did not miss these names: it surfaced and traded both.

## Cash-target audit

`pnpm auto:target-audit` reconstructs a ₹1,100-per-trade target from actual fills
and exact-contract LTP evidence retained in scanner snapshots and autonomous
tool traces.

Results over the ten completed live trades:

- target observed: 8 of 10
- actual realized P&L: +₹4,882
- audited ₹1,100 policy P&L: +₹5,104
- post-profit-day audited result: +₹2,615 instead of -₹8,409

This is evidence, not a fill backtest. Historical executable bids were not
retained, so an observed LTP target must not be described as a guaranteed fill.
The current guard exits only when the target is executable on the bid.

The local follow-up now creates `auto_quote_snapshots` and records the exact
option LTP, executable bid, ask, spread, stop, and target on every active
5-second guard pass. Writes happen after protective exit submission and are
best-effort, so audit logging cannot delay or break a stop. After deployment,
`pnpm auto:target-audit` prefers this bid history; older trades remain clearly
labelled as LTP-only evidence.

The trade-off is real: the same fixed target would reduce the +₹8,581 reference
day to about +₹289 by clipping MANKIND and PATANJALI. The setting lowers variance;
it does not guarantee higher long-run profit.

## Local implementation

The local hotfix makes Auto Trade's cash target independent from the scanner's
wider ₹5,000 planning target:

- default: ₹1,100 per whole trade
- optional basis: per trade or per lot
- editable range: ₹500–₹20,000 on `/auto-trade`
- snapshotted before placement so changing settings cannot move a pending or
  open trade's target
- re-anchored to the broker's actual fill
- visible on `/auto-trade` and Telegram `/status`
- auditable with `pnpm auto:target-audit`

Existing pending or open trades keep their stored target. The scanner's wider
spot target and `/trade-suggest` display remain unchanged.

## Live P&L monitoring follow-up

The local follow-up also adds a separate, read-only FYERS market-data WebSocket
for filled FYERS option positions:

- subscribes only to exact contracts already open (normally one or two symbols;
  FYERS API v3 permits up to 5,000 unique symbols per API key)
- streams LTP plus depth/best bid and ask without consuming the REST quote
- may trigger the existing idempotent target exit immediately when a fresh,
  non-crossed best bid reaches target and displayed bid size covers the full
  position; the 5-second REST guard is still the fallback
- does not use WebSocket ticks as stop-loss authority yet
- calculates bid-based executable P&L per trade and combined across all tracked
  trades; LTP P&L is kept separate
- rejects crossed/malformed books and treats ticks older than 15 seconds as
  stale
- uses an application-owned bounded reconnect supervisor around the FYERS SDK
  singleton and exposes connection/error/freshness/retry state on `/auto-trade`;
  while a position is tracked it compares a private hash of the socket token
  with the current cached FYERS token, and replaces the socket when the morning
  token changes, so reliability does not depend on a daily AWS restart
- uses a read-only market-data connection; a qualifying bid can invoke the
  same idempotent `exitTrade()` sell path as the five-second REST guard

The deterministic guard remains the exit authority and now checks every five
seconds. The WebSocket is additional visibility, not a single point of failure;
if it disconnects, the existing batched Dhan REST guard continues to protect
stops, targets, and square-off.

## Entry-filter replay verdict

Six retained sessions were replayed before changing entry logic.
The comparison is reproducible with `pnpm auto:entry-filter-audit`.

- shipped filters, all fires: 14 picks, 3 targets, 10 stops, 1 open, -2.54R
- removing Supertrend: 15 picks, 3 targets, 11 stops, 1 open, -3.54R
- completed ORB + volume ≥1.2× + sector alignment, keeping Supertrend: 3 picks,
  1 target, 1 stop, 1 open, +2.46R
- same strict filter without Supertrend: 4 picks, 1 target, 2 stops, 1 open,
  +1.46R

Therefore Supertrend must not be removed based on current evidence. The stricter
ORB/volume/sector combination is promising but has only three fires and still
admits POLYCAB. Keep it research/shadow-only until more sessions accumulate.

## Recommended operating decision

1. Keep Supertrend.
2. Do not enable a new ORB entry gate yet.
3. Review the production 12:15 entry override; 11:00 is the tagged default and
   would have blocked two of the five post-profit-day losses.
4. Deploy the configurable ₹1,100 cash target only after review and validation.
5. Deploy the new bid/ask retention table so future target studies use
   executable prices instead of LTP-only estimates.

No configuration is battle-proof and no code can guarantee profit. The decisions
above are the narrowest changes supported by the retained production evidence.
