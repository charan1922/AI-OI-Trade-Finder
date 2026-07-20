# AI OI Trade Finder  
## Auto-Trade Safety Gap Analysis and Detailed Remediation Plan

**Repository:** `charan1922/AI-OI-Trade-Finder`  
**Reviewed ref:** Current `main` branch, including changes after `v1.22.0`  
**Review date:** 20 July 2026  
**Revision:** Updated with stop-loss cadence, target/R-multiple semantics, executable-price checks, and token-efficient AI architecture.  
**Scope:** Auto-trade engine, AI tool execution, broker adapters, order and position reconciliation, approval mode, risk gates, fast position guard, runtime settings, alerts, persistence, CI/CD, deployment, and strategy/replay alignment.

> **Important:** This is a static engineering review of the repository code. It does not claim that broker payloads, live fills, network failures, or production recovery paths were executed during this review. Broker-facing safety changes must be validated with captured real responses and controlled live tests before unattended trading.

---

# 1. Executive Summary

The application has a strong core design:

> **The AI proposes; deterministic code disposes.**

The scanner supplies candidates, the AI can act only through a restricted tool set, and every entry is rechecked by code-enforced gates. Entry and exit orders are persisted before submission, correlation IDs support recovery, pending orders are reconciled, a fast deterministic guard runs independently of the AI, and approval mode revalidates the trade against fresh market data.

The last releases also fixed several serious problems:

- Phantom positions created by failed orders.
- Lost broker rejection messages.
- Exit-order claims without correlation IDs.
- Stale previous-day database positions causing a possible naked SELL.
- Holiday-calendar fail-open behavior in the poller.
- Unbounded AI calls.
- Mid-pass kill-switch staleness.
- Production boot without an application password.
- Operational visibility through cycle timelines.

These are meaningful improvements. However, the remaining risk is concentrated in a smaller number of high-impact paths.

## Current readiness verdict

| Mode | Readiness | Assessment |
|---|---:|---|
| Paper | **Ready for continued use** | Appropriate for collecting data, testing gates, and validating strategy behavior. |
| Approval | **Conditionally ready** | Use one lot, one trade at a time, and manually verify broker positions and fills. |
| Fully autonomous live | **Not yet recommended unattended** | Broker quantity truth, orphan-position discovery, guard blindness, and code-level per-pass entry enforcement should be fixed first. |

## Highest-priority blockers

1. **Malformed broker position quantities can be interpreted as flat.**
2. **Partial, excess, or negative broker positions are not reconciled safely.**
3. **The application checks DB positions against the broker, but does not discover broker positions missing from the DB.**
4. **An order can be declared failed after order-book misses without a full broker-position/trade-book cross-check.**
5. **Option quote errors are swallowed, and spot freshness is not actually validated.**
6. **“One entry per AI pass” and “check before place” are prompt rules, not hard runtime rules.**
7. **Entry gates use a weekday/time check in some paths instead of one central fail-closed exchange-session verdict.**
8. **Critical safety alerts can be disabled or silently dropped.**
9. **Daily risk considers realized P&L but not unrealized or unresolved exposure.**
10. **CI builds and deploys without mandatory trading-safety tests and publishes only `latest`.**

---

# 2. Scope and Method

The review followed the live-trading chain:

```text
Market data
    ↓
Scanner and candidate ranking
    ↓
AI decision loop
    ↓
Tool executor
    ↓
Entry risk gates
    ↓
Trade and order persistence
    ↓
Broker adapter
    ↓
Order reconciliation
    ↓
Position reconciliation
    ↓
Fast position guard
    ↓
Exit execution
    ↓
Audit, alerting, deployment and recovery
```

Primary files reviewed include:

```text
lib/auto-trade/engine.ts
lib/auto-trade/tools/execute.ts
lib/auto-trade/decision/system-prompt.ts
lib/auto-trade/risk/gates.ts
lib/auto-trade/risk/position-guard.ts
lib/auto-trade/guard-loop.ts
lib/auto-trade/execution.ts
lib/auto-trade/approval.ts
lib/auto-trade/store.ts
lib/auto-trade/settings.ts
lib/auto-trade/quotes.ts
lib/auto-trade/alerts.ts
lib/auto-trade/types.ts
lib/auto-trade/brokers/adapter.ts
lib/auto-trade/brokers/fyers-adapter.ts
lib/auto-trade/brokers/dhan-adapter.ts
lib/auto-trade/brokers/paper-adapter.ts
lib/fyers/poller.ts
lib/dhan/market-feed.ts
instrumentation.ts
.github/workflows/build-image.yml
package.json
scripts/replay-lib.ts
```

Severity means:

- **P0 – Critical:** Can create an unknown or unmanaged live position, an oversized SELL, or materially defeat a safety control.
- **P1 – High:** Can delay exits, understate account risk, hide failures, or make deployment/recovery unsafe.
- **P2 – Medium:** Primarily affects strategy quality, calibration, observability, or maintainability.
- **P3 – Improvement:** Useful hardening, but not a live blocker.

---

# 3. What the Current Design Already Does Well

The remediation plan should preserve these strengths.

## 3.1 Deterministic entry gates

`checkEntryGates()` validates:

- Trading mode.
- Kill switch.
- Second live-mode environment key.
- Market-hours flag.
- Entry window.
- Square-off boundary.
- Daily trade cap.
- Open-lot cap.
- Per-symbol no-re-entry rule.
- Daily realized-loss halt.
- Broker funds.
- Per-lot premium cost.
- Capital budget.
- Premium slippage from the scanner quote.
- Option spread.
- Presence of a spot stop.

Corrupt numeric inputs fail closed.

## 3.2 Entry is limited to current scanner picks

`findPick()` resolves symbols only from the scan passed into the current engine cycle. The AI cannot freely invent a stock or contract and send it to the broker.

## 3.3 Approval mode re-runs all gates

A pending proposal does not touch the broker. On approval:

- The proposal date is checked.
- Runtime mode is rechecked.
- A fresh option quote is fetched.
- Slippage is recalculated.
- Broker funds are fetched.
- Exposure, entries, daily P&L, time window, and spread are revalidated.
- Status is atomically changed from `pending_approval` to `placing`.

This is the correct model for human-in-the-loop trading.

## 3.4 Atomic trade and order claims

The store uses atomic inserts and unique idempotency keys:

- One trade row per symbol per day.
- One BUY claim per trade.
- Numbered SELL attempts.
- Correlation IDs persisted before broker submission.
- Active SELL orders block concurrent duplicate exits.

## 3.5 Ambiguous order submission is treated cautiously

Network or SDK ambiguity is not automatically retried. The order is marked unknown and is reconciled by broker order ID or correlation ID.

## 3.6 The deterministic guard is independent of the AI

The guard runs:

- At the beginning of each engine pass.
- Approximately every 60 seconds through the fast guard loop.
- Even when mode is off or the kill switch is enabled.

It handles:

- Premium stop.
- Premium target.
- Spot stop and target.
- End-of-day square-off.
- Breakeven trailing.
- Supertrend momentum exit.

## 3.7 Existing-trade exits stay with the opening broker

The trade row stores the broker used for entry. Changing the active runtime broker does not reroute an existing trade’s exit to a different broker.

## 3.8 Runtime settings fail safely

A DB failure in `getAutoTradeSettings()` returns defaults, where mode is `off`.

## 3.9 Cycle-level visibility

The cycle timeline records scanner, reconciliation, guard, AI, tool, and commentary timing. It is useful for diagnosing delayed passes or missing decisions.

---

# 4. Priority Summary

| ID | Priority | Problem | Potential live impact |
|---|---|---|---|
| AT-001 | P0 | Invalid broker `netQty` becomes zero | Local row may close while the real position remains open |
| AT-002 | P0 | Partial/excess/short quantities not handled | Oversized SELL or unmanaged residual quantity |
| AT-003 | P0 | No broker-to-DB orphan scan | Real broker position may exist with no local guard |
| AT-004 | P0 | Order give-up relies mainly on order-book misses | Late broker fill can become an orphan position |
| AT-005 | P0 | Guard quote failures are silent; spot age is unknown | Stops can become blind without a critical alarm |
| AT-006 | P0 | One entry per AI pass is not code-enforced | AI may place two entries in one model pass |
| AT-007 | P0 | Entry-session verification is not centralized | Manual/approval path can rely on stale weekday data |
| AT-008 | P0 | Critical alerts can be disabled or absent | Operator may not know about unknown orders or blind guard |
| AT-009 | P1 | Daily loss halt ignores unrealized and unresolved risk | New entry can be allowed while account is already over risk |
| AT-010 | P1 | Filled status does not validate filled quantity | Partial fill can be recorded as a full position |
| AT-011 | P1 | Flat-close P&L uses broker day sell average | P&L attribution may be inaccurate |
| AT-012 | P1 | No broker-native protective order | ₹1,500 “maximum” is not guaranteed |
| AT-013 | P1 | Auto-stop trusts local DB only | EC2 can stop while an orphan broker position exists |
| AT-014 | P1 | Guard heartbeat is not surfaced or dead-man monitored | Headless protection can fail silently |
| AT-015 | P1 | No audit trail for settings changes | Cannot prove who changed live mode, caps, broker, or times |
| AT-016 | P1 | CI does not run mandatory safety checks | Broken money-touching code can deploy |
| AT-017 | P1 | Deployment uses only mutable `latest` image | Exact rollback and production identification are weak |
| AT-018 | P1 | Runtime schema changes and backup discipline are weak | Rollback can leave app and DB out of sync |
| AT-019 | P1 | Paper broker does not simulate live failure states | Paper success can overstate live reliability |
| AT-020 | P1 | Entry liquidity checks omit required book quantity | Tight spread can still have insufficient quantity |
| AT-021 | P2 | Chaotic-open gate uses limited evidence | Possible overfitting and missed valid trends |
| AT-022 | P2 | Replay and live configuration can drift | Backtest validates a different strategy |
| AT-023 | P2 | Decision rows do not snapshot effective configuration | Hard to reproduce why a trade was accepted |
| AT-024 | P2 | Realized P&L excludes charges and taxes | Loss halt understates actual account loss |
| AT-025 | P2 | AI workflow ordering is mostly prompt-enforced | Model can skip intended management order |

---

# 5. Detailed Findings and Solutions

---

## AT-001 — Broker position parsing can fail open

**Priority:** P0 – Critical

### Current problem

Both real broker adapters effectively use this pattern:

```ts
const net = Number(row.netQty);

return {
  netQtyUnits: Number.isFinite(net) ? net : 0,
  sellAvg: ...
};
```

The adapter contract says:

```text
null = broker cannot say
0    = broker definitively confirms flat
```

But a malformed, renamed, missing, or unexpected quantity field becomes `0`.

Examples that could be incorrectly interpreted as flat:

```json
{ "netQuantity": 75 }
```

```json
{ "netQty": null }
```

```json
{ "netQty": "" }
```

```json
{ "netQty": "unexpected" }
```

The execution layer then checks:

```ts
if (pos && pos.netQtyUnits <= 0) {
  // treat broker as flat
}
```

This also treats a **negative quantity** as flat, even though a negative quantity means an unexpected short position and should be treated as a critical incident.

### Live impact

The application may:

1. Mark the local trade closed.
2. Stop monitoring and protecting it.
3. Release local exposure.
4. Permit another entry.
5. Leave the actual broker position open.

Alternatively, a negative short position could be hidden as “flat.”

### Recommended solution

Use a strict discriminated result:

```ts
export type BrokerPositionRead =
  | {
      kind: 'verified';
      netQtyUnits: number;
      buyAvg: number | null;
      sellAvg: number | null;
      rawSymbol: string;
    }
  | {
      kind: 'unavailable';
      reason: string;
    };
```

Strict parser:

```ts
function parseRequiredFiniteNumber(
  row: Record<string, unknown>,
  fieldNames: string[]
): number | null {
  for (const name of fieldNames) {
    const raw = row[name];
    if (raw === null || raw === undefined || raw === '') continue;

    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }

  return null;
}
```

Adapter logic:

```ts
const netQty = parseRequiredFiniteNumber(row, [
  'netQty',
  'netQuantity',
  'net_qty'
]);

if (netQty === null) {
  return {
    kind: 'unavailable',
    reason: 'position row found but net quantity was missing or invalid'
  };
}
```

Execution must distinguish:

```ts
if (position.kind === 'unavailable') {
  alertCritical(...);
  doNotMarkFlat();
}

if (position.netQtyUnits === 0) {
  markBrokerFlat();
}

if (position.netQtyUnits < 0) {
  triggerEmergencyShortIncident();
}

if (position.netQtyUnits > 0) {
  validateExpectedQuantity();
}
```

### Required tests

- Valid numeric number.
- Valid numeric string.
- Missing field.
- Empty string.
- `null`.
- `NaN`.
- Alternative field name.
- Zero.
- Positive quantity.
- Negative quantity.
- Broker returns successful response with no matching position.
- Broker returns malformed matching position.

### Definition of done

- No non-finite quantity can become zero.
- Negative quantity is a critical incident, never “flat.”
- A malformed response cannot close a local trade.
- Tests use captured Fyers and Dhan payload fixtures.

---

## AT-002 — Partial, excess, and unexpected short positions are not reconciled

**Priority:** P0 – Critical

### Current problem

For an open trade, the expected broker quantity is:

```ts
expectedQty = trade.lotSize * trade.lots
```

Current reconciliation mainly asks whether broker quantity is positive or non-positive.

It does not distinguish:

| Broker quantity | Meaning |
|---:|---|
| `0` | Flat |
| `expectedQty` | Correct |
| `0 < qty < expectedQty` | Partial position |
| `qty > expectedQty` | Excess position |
| `< 0` | Unexpected short |
| Non-lot multiple | Corrupt or partially executed position |

If the broker has only part of the expected quantity, `exitTrade()` can still create a SELL order for the full DB quantity.

Example:

```text
DB expects:       75 units
Broker actually:  25 units
Current exit:     SELL 75
Risk:             50-unit unintended short
```

### Additional fill-state problem

`applyEntryState()` treats:

```ts
state.status === 'filled' && state.avgFillPrice != null
```

as a complete fill without first confirming that `filledQtyUnits` equals the requested order quantity.

Similarly, a completed exit can be booked using price alone.

### Recommended solution

Track quantity as a first-class position field.

Add fields:

```text
auto_trades.entryQtyUnits
auto_trades.openQtyUnits
auto_trades.exitQtyUnits
auto_trades.positionState
```

Suggested states:

```ts
type PositionState =
  | 'opening'
  | 'open_exact'
  | 'open_partial'
  | 'open_excess'
  | 'unexpected_short'
  | 'closing'
  | 'flat'
  | 'unknown';
```

Validate every broker state:

```ts
function classifyQuantity(actual: number, expected: number) {
  if (actual === 0) return 'flat';
  if (actual < 0) return 'unexpected_short';
  if (actual === expected) return 'exact';
  if (actual < expected) return 'partial';
  return 'excess';
}
```

Before an exit:

1. Read broker position.
2. Require a verified quantity.
3. Compare it with expected local quantity.
4. If exact, SELL exact quantity.
5. If partial, quarantine and either:
   - SELL only verified held quantity under an explicit recovery path, or
   - require manual confirmation.
6. If excess or short, block normal automation and raise a critical incident.

### Important design rule

Do not “repair” a mismatch silently. Any mismatch means the local model of the account is not trustworthy. New entries should be disabled until reconciliation is resolved.

### Required tests

- Entry filled exactly.
- Entry reports filled with no filled quantity.
- Entry reports filled with smaller quantity.
- Entry partially trades and remains pending.
- Exit partially fills.
- Broker position is smaller than local expected.
- Broker position is larger than local expected.
- Broker position is negative.
- Quantity is not a lot-size multiple.
- Duplicate guard and AI exit calls during a mismatch.

### Definition of done

- A SELL can never exceed verified held quantity.
- Filled state cannot be applied without quantity validation.
- Quantity mismatches activate a safety latch and block new entries.
- Position state and quantity are visible in the UI.

---

## AT-003 — No reverse broker-to-database orphan-position discovery

**Priority:** P0 – Critical

### Current problem

The current adapter contract supports:

```ts
getNetPosition(query)
```

This starts from a known DB trade and asks the broker about that contract.

It does not support:

```ts
listNetPositions()
```

Therefore the application cannot answer:

> “Which live broker positions exist that have no matching local trade?”

This can happen if:

- Broker accepted an order but the response was lost.
- Order-book correlation lookup temporarily failed.
- The process crashed after placement.
- The DB write failed after a broker fill.
- A manual broker order was placed.
- An order declared failed later appeared or filled.
- The wrong production DB or volume was mounted.

### Live impact

An orphan long option can remain:

- Without premium stop.
- Without spot stop.
- Without EOD square-off from this application.
- Missing from exposure and daily risk.
- Invisible on `/auto-trade`.

### Recommended solution

Extend the adapter:

```ts
export interface BrokerPosition {
  broker: 'fyers' | 'dhan';
  contractKey: string;
  symbol: string;
  securityId: string | null;
  optionType: 'CE' | 'PE' | null;
  strike: number | null;
  expiryDate: string | null;
  netQtyUnits: number;
  buyAvg: number | null;
  sellAvg: number | null;
}

export interface BrokerAdapter {
  ...
  listNetPositions?(): Promise<BrokerPositionRead[]>;
}
```

Run two-way reconciliation:

```text
DB → Broker
For every local risk-bearing trade, confirm broker truth.

Broker → DB
For every non-zero broker F&O position, find a matching local trade.
```

When an orphan is detected:

1. Enable a persistent risk latch:
   ```text
   liveEntryBlocked = true
   reason = orphan broker position
   ```
2. Send an unavoidable critical alert.
3. Store the incident in an `auto_trade_incidents` table.
4. Show it prominently on `/auto-trade`.
5. Continue monitoring the broker quantity.
6. Do not invent entry price, stop, or P&L.
7. Allow an explicit recovery workflow:
   - Attach to an existing trade.
   - Import as a recovery position.
   - Close verified broker quantity.
   - Mark as intentionally external/manual.

### Run frequency

- At application startup.
- Before every entry.
- Every fast-guard tick when live/approval mode is active.
- Before EC2 auto-shutdown.
- Immediately after an ambiguous BUY.
- After a reconnect or broker-auth refresh.

### Definition of done

- Every non-zero live broker position is either matched or reported as an incident.
- New entries are blocked while an orphan exists.
- EC2 cannot auto-stop while an orphan exists.
- Recovery action requires explicit operator intent.

---

## AT-004 — Order “give-up” is not sufficiently corroborated

**Priority:** P0 – Critical

### Current problem

An unresolved order without a broker order ID can be marked rejected after:

- At least five checks.
- At least five minutes.
- No correlation match in the order book.

The code comment assumes any accepted broker order appears immediately in the order book.

That assumption is too strong for a money-touching recovery decision.

Possible causes of a false miss:

- Temporary broker order-book lag.
- API response truncation or filtering.
- SDK field changes.
- Different day-book behavior.
- Correlation/tag normalization.
- Broker accepted and later processed the order.
- Position exists even when order lookup fails.

### Live impact

The application can:

1. Mark BUY as failed.
2. Release the daily slot and capital.
3. Stop treating the row as risk-bearing.
4. Later discover that a real broker position exists.

This creates the exact orphan-position problem described above.

### Recommended solution

Introduce a quarantine state:

```ts
type TradeStatus =
  | ...
  | 'unknown_broker_state'
  | 'quarantined';
```

Do not release exposure merely because the order book has no match.

A BUY may be declared “verified not placed” only after all applicable checks agree:

```text
1. Correlation lookup returns no order.
2. Full order book returns no order.
3. Trade book returns no execution.
4. Position book returns no matching quantity.
5. Checks succeed repeatedly across a reasonable time.
6. Broker API responses are valid and complete.
```

Recommended outcome matrix:

| Order lookup | Position lookup | Action |
|---|---|---|
| Found | Any | Reconcile order |
| Not found | Positive position | Create orphan/recovery incident |
| Not found | Verified flat | Candidate for verified failure |
| Not found | Unavailable | Keep quarantined |
| API error | Any | Keep quarantined |

For SELL orders, do not automatically retry until position quantity confirms what remains to be sold.

### Definition of done

- “Rejected/failed” means broker absence was positively verified.
- “Unknown” remains risk-bearing.
- Quarantined rows reserve exposure and block conflicting entries.
- A position-book check is required before releasing a BUY slot.

---

## AT-005 — The position guard can become blind silently

**Priority:** P0 – Critical

### Current problem: option quotes

`fetchOptionQuotes()` catches every error and returns an empty map.

The guard then continues with no premium quote. This preserves spot checks, but:

- No error reason is returned.
- No consecutive-failure count is maintained.
- No critical alert is emitted.
- No “guard blind” state is visible.
- Premium stop and target silently stop working.

### Current problem: spot freshness

`latestSpot()` queries only:

```sql
SELECT close
...
ORDER BY bucketTs DESC
LIMIT 1
```

It does not return or validate `bucketTs`.

Therefore the code comment that the close is recent is not enforced. A stalled poller can leave an old close that still looks valid.

### Live impact

During a Dhan outage or poller failure:

- Premium stop is unavailable.
- Spot stop may use stale data.
- Position can remain open while the UI appears operational.
- ₹1,500 risk can be exceeded materially.

### Recommended solution

Return structured quote health:

```ts
export interface QuoteBatchResult {
  quotes: Map<string, OptionQuote>;
  requestedIds: string[];
  missingIds: string[];
  fetchedAt: string;
  sourceOk: boolean;
  error: string | null;
  latencyMs: number;
}
```

Return timestamped spot:

```ts
export interface SpotQuote {
  price: number;
  bucketTs: number;
  ageMs: number;
  fresh: boolean;
}
```

Recommended freshness rules:

```text
Option quote:
- Timestamp from broker when available.
- Otherwise request completion timestamp.
- Treat missing contract quote separately from total request failure.

Spot candle:
- During market hours, reject if older than a configured threshold.
- Example: more than 7–10 minutes old.
- After market close, different rules may apply for reporting, but not entries.
```

Maintain health state:

```ts
interface GuardHealth {
  consecutiveOptionQuoteFailures: number;
  consecutiveSpotStaleChecks: number;
  lastSuccessfulOptionQuoteAt: string | null;
  lastFreshSpotAt: string | null;
  blindSince: string | null;
  status: 'healthy' | 'degraded' | 'blind';
}
```

Actions:

- First failure: warn and record.
- Repeated failure with an open position: critical alert.
- Both option and spot unavailable: set risk latch.
- A verified exact broker position plus prolonged blindness may optionally trigger an emergency market exit, controlled by an explicit setting and tested carefully.
- Never place a new entry while core market data is degraded.

### Definition of done

- A quote API error is never indistinguishable from “no stop hit.”
- Every open position has visible quote/spot freshness.
- Consecutive blindness generates critical alerts.
- New entries fail closed when current data health is insufficient.

---

## AT-006 — One entry per AI pass is prompt-enforced, not code-enforced

**Priority:** P0 – Critical policy gap

### Current problem

The system prompt says:

```text
At most ONE place_entry_order call per pass.
Only after check_order says ALLOW.
```

However, `executeAutoTradeTool()` does not maintain a pass-level flag that blocks a second symbol.

The normal caps may still allow two trades:

```text
maxTradesPerDay = 2
maxOpenLots = 2
```

A model can theoretically:

1. Check and place symbol A.
2. Check and place symbol B in the same tool loop.

Both can pass deterministic account caps.

The hard safety gates prevent excessive account totals, but the documented policy “one decision, one entry per cycle” is not actually enforced by code.

### Live impact

- Two market orders can be sent in the same AI pass.
- Both trades are based on one market snapshot.
- Exposure can double before the next guard cycle.
- A model/prompt regression can bypass intended caution.

### Recommended solution

Extend `ToolRuntime`:

```ts
export interface ToolRuntime {
  scan: SuggestResponse | null;
  settings: AutoTradeSettings;
  date: string;
  passId: string;
  checkedSymbols: Map<string, {
    allowedAt: number;
    scanPremium: number;
    freshPremium: number;
  }>;
  entryAttempted: boolean;
  entryTradeId: number | null;
}
```

On `check_order` ALLOW:

```ts
rt.checkedSymbols.set(symbol, {
  allowedAt: Date.now(),
  scanPremium,
  freshPremium
});
```

On `place_entry_order`:

```ts
if (rt.entryAttempted) {
  refuse('one entry attempt is allowed per engine pass');
}

const priorCheck = rt.checkedSymbols.get(symbol);
if (!priorCheck || Date.now() - priorCheck.allowedAt > MAX_CHECK_AGE_MS) {
  refuse('check_order ALLOW is required immediately before placement');
}

rt.entryAttempted = true;
```

The placement function should still re-run all gates. The prior check requirement is workflow enforcement; the second gate evaluation is actual safety.

For multi-process safety, persist a cycle/pass claim if multiple server processes can run the same logical pass.

### Definition of done

- A second entry call in one pass is rejected before DB insert.
- A placement requires a recent successful `check_order` for the same symbol.
- Tests simulate a model issuing two entry calls.
- The audit trace clearly records the refusal.

---

## AT-007 — Exchange-session truth is not centralized across all entry paths

**Priority:** P0

### Current problem

The poller has fail-closed holiday logic.

However, some entry decisions use:

```ts
isMarketHours()
```

That function checks:

- Weekday.
- Time between 09:15 and 15:30.

It does not itself verify:

- NSE holiday.
- Exchange special session.
- Market status.
- Feed/session date.
- Whether current quotes belong to today.

Approval mode and tool gates receive `marketOpen` from this simpler function.

### Live impact

A manual run or approval path can theoretically rely on stale broker/NSE data during a weekday holiday or abnormal session.

The poller being safe is not enough; **every money-touching entry path must share the same session verifier.**

### Recommended solution

Create one service:

```ts
export interface MarketSessionState {
  date: string;
  weekday: boolean;
  withinRegularHours: boolean;
  holidayVerified: boolean;
  exchangeStatus: 'open' | 'closed' | 'unknown';
  dataSessionVerified: boolean;
  allowNewEntries: boolean;
  reasons: string[];
}
```

Example:

```ts
const session = await getMarketSessionState();

if (!session.allowNewEntries) {
  failClosed(session.reasons);
}
```

Use it in:

- Poller.
- Scanner.
- `buildGateInput()`.
- Approval.
- Manual run-pass.
- Any API action that can produce a new entry.
- Order smoke test, with separate rules.

Exits remain allowed even if the session verifier is degraded, because exits reduce risk.

### Definition of done

- There is one implementation of “may a new order be opened now?”
- Weekday/time alone can never authorize a live entry.
- Holiday data failure is fail closed.
- Session state is included in the decision audit.

---

## AT-008 — Critical alerts can be disabled or silently absent

**Priority:** P0

### Current problem

Alert routing currently allows:

```text
No Telegram configuration
AND no webhook
→ silently drop alerts
```

When Telegram is configured, `telegramAlerts = false` suppresses messages. The same toggle appears to cover both:

- Optional commentary/normal notifications.
- Critical safety incidents.

Examples that must not be treated as optional:

- Unknown BUY.
- Unknown SELL.
- Partial fill.
- Position mismatch.
- Orphan broker position.
- Guard blind.
- Repeated exit failure.
- Unexpected short position.
- Live mode activation.
- Kill-switch activation.
- Daily loss halt.

The alert helper defines kill-switch and daily-loss messages, but critical state transitions should be explicitly wired and tested rather than relying on unused helper availability.

### Recommended solution

Split alert classes:

```ts
type AlertSeverity = 'info' | 'warning' | 'critical';
```

```ts
sendOperationalAlert(...)   // may respect user toggle
sendCriticalAlert(...)      // cannot be disabled in approval/live mode
```

Add live-mode preflight:

```text
Before approval/live mode is accepted:
- At least one critical channel must be configured.
- A test message must be acknowledged.
- Store last successful alert delivery time.
```

Critical alert delivery should:

- Retry with bounded backoff.
- Use a secondary channel if configured.
- Record delivery success/failure in DB.
- Surface failures in the UI.
- Never block a protective exit.

### Definition of done

- Live/approval mode cannot be enabled without a tested critical alert channel.
- Commentary can be disabled without disabling safety incidents.
- Every P0 incident has an alert test.
- Delivery failures are visible and audited.

---

## AT-009 — Daily loss halt ignores unrealized and unresolved risk

**Priority:** P1 – High

### Current problem

The gate uses:

```text
dailyRealizedPnl
```

It does not include:

- Unrealized loss on open positions.
- Worst-case loss to active stops.
- Unknown-order exposure.
- Partial fills.
- Positions being exited.
- Charges and taxes.

Example:

```text
Trade A unrealized: -₹1,400
Trade B unrealized: -₹1,400
Realized P&L:        ₹0
```

The daily loss gate can still see zero realized loss.

### Recommended solution

Create a deterministic account risk snapshot:

```ts
export interface PortfolioRiskSnapshot {
  realizedPnl: number;
  unrealizedPnl: number | null;
  estimatedCharges: number;
  worstCaseToStops: number | null;
  unresolvedExposureRupees: number;
  unknownPositionCount: number;
  totalCurrentRisk: number | null;
  dataHealthy: boolean;
}
```

New-entry rule:

```text
Block when any is true:
- Realized loss exceeds halt.
- Realized + unrealized loss exceeds halt.
- Worst-case portfolio loss exceeds limit.
- Any position/order quantity is unknown.
- Market data required to calculate risk is unhealthy.
```

Do not let missing live prices become zero unrealized loss.

### Definition of done

- Account risk includes open positions.
- Unknown risk fails closed for new entries.
- The UI shows realized, unrealized, stop risk, and unresolved exposure separately.

---

## AT-010 — “Filled” is accepted without verifying full requested quantity

**Priority:** P1, elevated to P0 when broker payloads are unreliable

### Current problem

The entry/exit application functions mainly require:

```ts
status === 'filled'
avgFillPrice != null
```

They do not require:

```ts
filledQtyUnits === order.qtyUnits
```

A broker or adapter defect could report a fill status with an incomplete or missing quantity.

### Recommended solution

Every state application must receive the order row and validate:

```ts
function validateTerminalFill(
  state: OrderState,
  expectedQty: number
): FillValidation
```

Possible results:

```ts
type FillValidation =
  | { kind: 'full'; qty: number; avgPrice: number }
  | { kind: 'partial'; qty: number; avgPrice: number | null }
  | { kind: 'invalid'; reason: string };
```

Do not open or close a full trade unless full quantity is verified.

### Definition of done

- `filled` without quantity is either reconciled from trade book or treated unknown.
- Partial fill creates a partial position state.
- P&L is calculated only from actual executed quantity.

---

## AT-011 — Broker-flat P&L attribution can be inaccurate

**Priority:** P1

### Current problem

When the broker shows flat, `sellAvg` may represent the day’s aggregate sell average for the contract, not necessarily the exact exit associated with this application’s trade.

This becomes unreliable when:

- Manual transactions occurred.
- Multiple orders used the same contract.
- Partial exits occurred.
- Another system traded the contract.

### Recommended solution

Prefer exact execution records:

1. Correlation ID.
2. Broker order ID.
3. Trade-book executions for that order.
4. Weighted average from exact executions.
5. Only then fall back to contract-level day average, clearly marked estimated.

Store:

```text
pnlSource = exact_order_fills | broker_day_average | unknown
```

### Definition of done

- Realized P&L identifies its source.
- Daily halt can choose whether estimated P&L is trusted.
- Broker statement reconciliation can correct the record later.

---

## AT-012 — ₹1,500 maximum loss is a software threshold, not a guaranteed cap

**Priority:** P1

### Current problem

The premium stop is checked periodically and sends a market exit after price crosses the level.

Real loss can exceed the target because of:

- Up to roughly 60 seconds between fast-guard checks.
- Quote queue latency.
- Dhan outage.
- Network delay.
- Broker rejection.
- Gap in option premium.
- Wide spread.
- Market-order slippage.
- Partial fill.
- Process restart.

### Recommended solution options

#### Option A — Broker-native protective stop

After confirmed entry:

1. Place broker-side protective SL order.
2. Persist its order ID and correlation ID.
3. Reconcile it like every other order.
4. Modify it when trailing.
5. Cancel it before discretionary market exit.

This gives protection even if the server is down.

#### Option B — Websocket guard

Use a broker market-data stream for held option contracts and evaluate stops continuously. Keep the 60-second loop as a recovery/dead-man layer.

#### Option C — Market-protected limit orders

For entries, use a marketable limit with a maximum acceptable price instead of an unlimited market order.

For exits, use a protected market/limit strategy that prioritizes getting flat while avoiding extreme prints.

### Important wording

The UI and documentation should say:

```text
“Configured loss threshold: ₹1,500 per lot.”
```

Not:

```text
“Maximum possible loss: ₹1,500.”
```

No software-only periodic stop can guarantee the exact rupee outcome.

---

## AT-013 — EC2 auto-stop trusts local database state only

**Priority:** P1

### Current problem

The auto-stop script checks for local rows in open/placing/pending states.

If an orphan broker position exists while the DB appears flat, the box can shut down.

### Recommended solution

Before shutdown:

1. Confirm local DB has no risk-bearing trades.
2. Confirm no unresolved orders.
3. Query the active broker position book.
4. Confirm no non-zero relevant F&O positions.
5. Confirm no unknown reconciliation incidents.
6. Confirm guard/engine heartbeat is recent.
7. Fail safe and stay on if any check is unavailable.

Until broker-wide orphan discovery is implemented:

```text
Disable AUTO_SHUTDOWN in autonomous live mode.
```

### Definition of done

- Auto-stop needs both DB-flat and broker-flat proof.
- Any API failure prevents shutdown.
- Shutdown decision is logged with broker and DB evidence.

---

## AT-014 — Fast-guard heartbeat is not operationally enforced

**Priority:** P1

### Current problem

`getGuardLoopStatus()` exists, but the code comment says it is not yet surfaced in the UI.

There is also no external dead-man monitor verifying:

- Process is running.
- Fast guard is ticking.
- Last active check is recent.
- Quote health is good.
- Engine passes are completing.
- EC2 is reachable during market hours.

### Recommended solution

Add:

```text
GET /api/auto-trade/health
```

Response:

```json
{
  "mode": "live",
  "engine": {
    "lastPassAt": "...",
    "lastPassStatus": "completed"
  },
  "guard": {
    "lastTickAt": "...",
    "lastTickStatus": "guard-ran",
    "lastFreshQuoteAt": "..."
  },
  "broker": {
    "authOk": true,
    "positionsVerifiedAt": "..."
  },
  "riskLatch": {
    "blocked": false,
    "reasons": []
  }
}
```

Use an independent monitor outside the EC2 instance to alert when this endpoint is stale or unavailable.

### Definition of done

- A dead process during market hours produces an alert.
- Guard heartbeat appears on `/auto-trade`.
- “Healthy” requires fresh broker and market-data checks, not only a running timer.

---

## AT-015 — Runtime settings changes lack a complete audit trail

**Priority:** P1

### Current problem

Settings are persisted with only key, value, and update time.

Money-touching changes include:

- `mode`.
- `broker`.
- `killSwitch`.
- `maxTradesPerDay`.
- `maxOpenLots`.
- `maxCapitalRupees`.
- `dailyLossHaltRupees`.
- Entry and square-off times.
- Alert toggle.

There is no immutable old/new audit event with actor and source.

### Recommended solution

Add `auto_trade_setting_events`:

```text
id
at
actor
source          // UI, Telegram, API, boot, migration
key
oldValue
newValue
requestId
ipHash
reason
```

For critical changes:

- Send alert.
- Require confirmation for live mode.
- Refuse broker change while unresolved orders exist.
- Record whether the change passed preflight.

### Definition of done

- Every setting change is attributable.
- Live mode and kill-switch transitions are alerted.
- History cannot be overwritten.

---

## AT-016 — CI does not run mandatory safety validation

**Priority:** P1

### Current problem

The Docker workflow checks out code, builds, and pushes.

It does not require:

- TypeScript typecheck.
- ESLint.
- Auto-trade verification bench.
- Broker-adapter fixture tests.
- Reconciliation integration tests.
- Migration test.
- Replay smoke test.

`package.json` also has no standard test script and does not expose `verify-auto-trade` as a package script.

### Recommended solution

Add scripts:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:auto-trade": "vitest run lib/auto-trade",
    "verify:auto-trade": "tsx scripts/verify-auto-trade.ts",
    "replay:smoke": "tsx scripts/replay-window.ts --smoke",
    "ci": "pnpm typecheck && pnpm lint && pnpm test:auto-trade && pnpm verify:auto-trade && pnpm replay:smoke && pnpm build"
  }
}
```

Suggested workflow:

```yaml
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - checkout
      - setup pnpm/node
      - pnpm install --frozen-lockfile
      - pnpm typecheck
      - pnpm lint
      - pnpm test:auto-trade
      - pnpm verify:auto-trade
      - pnpm replay:smoke
      - pnpm build

  image:
    needs: validate
    ...
```

Branch protection should require `validate`.

### Required test suites

1. Broker payload fixtures.
2. Entry and exit idempotency.
3. Partial fills.
4. Unknown submissions.
5. Position mismatch.
6. Orphan discovery.
7. Holiday/session failure.
8. Quote blindness.
9. Kill switch during AI pass.
10. Two entry calls in one pass.
11. Approval concurrency.
12. EOD square-off failure.
13. DB restart recovery.
14. Auto-stop preflight.

---

## AT-017 — Deployment uses a mutable image only

**Priority:** P1

### Current problem

The workflow publishes:

```text
ghcr.io/.../project-r-simulator:latest
```

The production branch can move ahead of the latest semantic tag. `latest` does not uniquely identify the running code.

### Recommended solution

Publish:

```yaml
tags: |
  ghcr.io/${{ github.repository_owner }}/project-r-simulator:latest
  ghcr.io/${{ github.repository_owner }}/project-r-simulator:sha-${{ github.sha }}
```

For release tags:

```text
:v1.23.0
:sha-d88db190...
```

Record the deployed digest in:

- Deployment log.
- `/api/health`.
- `/config` or `/logs`.
- Decision rows if useful.

Deploy by immutable digest:

```text
ghcr.io/...@sha256:<digest>
```

### Definition of done

- Production reports exact commit and image digest.
- Rollback selects a known digest.
- `latest` is only a convenience alias.

---

## AT-018 — Schema changes and backups need release discipline

**Priority:** P1

### Current problem

Some tables and columns are created or altered at runtime.

Risks:

- Concurrent startup migration.
- Partial migration.
- Rollback to code that does not understand the current schema.
- No guaranteed snapshot immediately before deployment.
- DB and box-side scripts can drift from application version.

### Recommended solution

1. Use versioned migrations.
2. Store `schema_version`.
3. Run migrations as an explicit deployment step.
4. Snapshot SQLite consistently:
   - SQLite backup API, or
   - checkpoint WAL and copy safely.
5. Copy backup off the instance.
6. Test restore.
7. Include box-side scripts in versioned deployment.
8. Record deployment version in DB.

### Definition of done

- Every deployment has a restorable DB snapshot.
- Rollback procedure is documented and tested.
- App refuses to run against an unsupported schema.

---

## AT-019 — Paper mode does not exercise real failure states

**Priority:** P1

### Current problem

Paper mode fills synchronously at ask/bid/LTP and never simulates:

- Broker rejection.
- Timeout after broker acceptance.
- Partial fill.
- Delayed fill.
- Missing order ID.
- Unknown order state.
- Position mismatch.
- Quote outage.
- Cancel failure.
- Broker-side square-off.

This is useful for strategy P&L, but not sufficient for execution reliability.

### Recommended solution

Add a deterministic fault-injection broker:

```ts
class ScenarioBrokerAdapter implements BrokerAdapter {
  scenario:
    | 'success'
    | 'reject'
    | 'ambiguous_then_fill'
    | 'partial_then_fill'
    | 'partial_then_cancel'
    | 'accepted_missing_orderbook'
    | 'position_mismatch'
    | 'quote_outage';
}
```

Use it in integration tests and optionally a non-production simulation mode.

### Definition of done

- Every broker recovery branch is testable without real money.
- Restart recovery is tested using persisted DB state.

---

## AT-020 — Spread alone does not prove executable liquidity

**Priority:** P1

### Current problem

The entry gate checks spread percentage but does not require sufficient bid/ask quantity for the lot.

A contract can show a narrow top-of-book spread with insufficient size.

### Recommended solution

Extend option quote:

```ts
interface OptionQuote {
  ...
  bestBidQty: number | null;
  bestAskQty: number | null;
  cumulativeBidQty5: number | null;
  cumulativeAskQty5: number | null;
}
```

For BUY:

```text
Require ask-side executable quantity >= intended units,
or calculate expected VWAP across visible levels.
```

Add:

- Maximum expected execution slippage.
- Minimum number of active orders.
- Maximum price impact.
- Minimum premium turnover where available.

For exits, liquidity warnings must never block getting flat; they should influence order method and alerting.

---

# 6. Additional Auto-Trade Engine Suggestions

---

## 6.1 Add a persistent risk latch

A kill switch is operator controlled. The system also needs an automatic safety latch.

```ts
interface RiskLatch {
  blocked: boolean;
  reasons: string[];
  activatedAt: string | null;
  requiresManualClear: boolean;
}
```

Activate when:

- Orphan broker position.
- Position quantity mismatch.
- Unexpected short.
- Unknown BUY beyond SLA.
- Repeated guard blindness.
- Broker auth unhealthy with open positions.
- DB integrity failure.
- Clock/session integrity failure.

The latch should:

- Block all new entries.
- Never block exits.
- Persist across restart.
- Require explicit operator acknowledgement for P0 incidents.
- Appear in every account-state response.

---

## 6.2 Enforce AI pass phases in code

Current intended order:

```text
1. Manage positions.
2. Consider one entry.
3. Write final note.
```

The deterministic guard already handles mandatory exits, so a model ordering mistake is not catastrophic. Still, code can better enforce the contract.

Suggested runtime phases:

```ts
type PassPhase =
  | 'position_management'
  | 'entry_consideration'
  | 'completed';
```

Possible rules:

- Entry is blocked until open positions have been loaded/reviewed.
- One entry attempt per pass.
- No entry after an exit becomes unresolved.
- No entry when any position has stale data.
- No entry if an open position is already close to its loss threshold.
- Final note must accurately reflect tool results.

Do not rely on the prompt alone for any money-touching rule.

---

## 6.3 Add a per-entry cooldown

Even with one entry per pass, consecutive five-minute cycles could open two trades quickly.

Suggested control:

```text
Minimum minutes after a confirmed fill before another entry.
```

Example:

```text
15 minutes, or until the first position is at breakeven/protected.
```

This should be a deterministic setting with conservative clamps.

---

## 6.4 Separate “entry attempt” from “entry filled”

Useful daily counters:

```text
proposalsToday
entryAttemptsToday
confirmedEntriesToday
failedBrokerAttemptsToday
unknownEntryAttemptsToday
```

Current trade caps intentionally exclude failed entries, while symbol lock prevents retry storms. Keep that behavior, but expose all counters.

A high number of broker failures should automatically block new attempts even if no fills occurred.

---

## 6.5 Add broker circuit breakers

Per broker:

```ts
interface BrokerHealth {
  consecutiveOrderErrors: number;
  consecutiveAuthErrors: number;
  consecutivePositionErrors: number;
  lastSuccessfulOrderAt: string | null;
  lastSuccessfulPositionReadAt: string | null;
  circuit: 'closed' | 'open' | 'half-open';
}
```

Open the circuit after repeated failures:

- No new entries.
- Reconciliation and exits continue.
- Require smoke/preflight success to close the circuit.

---

## 6.6 Add pre-open and pre-live readiness checks

Before the first possible entry:

```text
- Server time/IST correct.
- Market holiday/session verified.
- Fyers data current.
- Dhan quote API healthy.
- Broker auth healthy.
- Broker funds readable.
- Position book readable.
- Order book readable.
- No broker orphans.
- Master contracts current.
- Expiry resolution valid.
- Critical alert delivered.
- Guard heartbeat running.
- DB writable.
- Disk space sufficient.
- Live second key present.
```

Expose a simple verdict:

```text
READY / NOT READY
```

Live entry gates should require `READY`.

---

## 6.7 Use exact contract identity everywhere

Contract identity should be normalized into one key:

```ts
type ContractKey = `${broker}:${exchange}:${securityId}`;
```

Fallback:

```text
symbol + expiry + strike + option type
```

This avoids mismatch between:

- Fyers symbol.
- Dhan security ID.
- Master contract row.
- Trade suggestion.
- Broker position.
- Broker order.

Store both normalized identity and raw broker symbol for audit.

---

## 6.8 Track entry and exit costs

Actual strategy P&L should include:

- Brokerage.
- STT.
- Exchange charges.
- GST.
- Stamp duty.
- SEBI charges.
- Slippage.

Store:

```text
grossPnl
estimatedCharges
netPnl
```

Use conservative net P&L for the daily halt.

---

## 6.9 Make manual overrides explicit recovery actions

Normal actions:

```text
approve
reject
exit
```

Recovery actions should be separate:

```text
confirm-broker-flat
attach-orphan
close-verified-quantity
mark-external-position
resolve-unknown-order
```

Each recovery action needs:

- Confirmation.
- Broker snapshot.
- Actor.
- Reason.
- Before/after state.
- Immutable incident record.

---

## 6.10 Add database integrity checks

At boot and periodically:

```text
- Open trade must have a filled BUY order.
- Closed trade must have a filled SELL or verified broker-flat incident.
- No trade has more than one active SELL.
- Filled order quantity is positive.
- Trade lot size is positive.
- Contract identity is present.
- Unknown orders remain risk-bearing.
- No closed trade has an open broker position.
```

Any violation activates the risk latch.

---

# 7. Strategy and Replay Suggestions

---

## 7.1 Move chaotic-open to shadow evaluation until evidence grows

The chaotic-open rule was based on a small number of observed examples. The code itself documents the overfitting risk.

Recommended approach:

1. Continue calculating the ratio.
2. Record:
   ```text
   wouldBlock = true/false
   ```
3. Do not block live picks initially.
4. Measure:
   - Win rate.
   - Average R.
   - Maximum adverse excursion.
   - Missed winner cost.
   - Performance by market regime.
5. Require a minimum number of out-of-sample sessions.
6. Enable only if results remain positive.

Suggested evidence threshold:

```text
At least 20–30 sessions and a meaningful number of fired cases.
```

Do not optimize the threshold repeatedly on the same small dataset.

---

## 7.2 Snapshot effective strategy configuration with every scan

Runtime toggles and compile-time constants should be stored with each scan/decision:

```json
{
  "minRFactor": 3.6,
  "minConfidence": 0.2,
  "chaoticOpenEnabled": true,
  "chaoticOpenMaxRatio": 5,
  "rankClimbEnabled": false,
  "entryWindow": "09:45-11:00",
  "maxSpreadPct": 3,
  "codeCommit": "d88db190..."
}
```

This is required to reproduce a trade later.

---

## 7.3 Make replay consume the exact production configuration

A replay marked “shipped” should use:

- Same gates.
- Same thresholds.
- Same candidate universe.
- Same max picks.
- Same runtime toggle snapshot.
- Same entry window.
- Same session context.
- Same chaotic-open rule.
- Same regime adjustment.
- Same no-reentry and daily-cap behavior.

If option premium data is missing, the result should clearly say:

```text
Not execution-equivalent.
```

Do not present it as a full live simulation.

---

## 7.4 Separate scanner quality from execution quality

Maintain two scorecards:

### Signal scorecard

- Spot movement.
- Stop/target outcome.
- Maximum favorable excursion.
- Maximum adverse excursion.
- Breakout quality.
- OI behavior.

### Execution scorecard

- Suggested premium.
- Pre-submit quote.
- Fill.
- Slippage.
- Spread.
- Order latency.
- Exit latency.
- Charges.
- Net P&L.

This avoids blaming strategy logic for broker execution defects, or vice versa.

---

## 7.5 Evaluate OI direction, not only magnitude

Absolute OI change can reward strong unwinding even when it contradicts the intended accumulation thesis.

Suggested classification:

```text
Price ↑ + OI ↑ = long build-up
Price ↓ + OI ↑ = short build-up
Price ↑ + OI ↓ = short covering
Price ↓ + OI ↓ = long unwinding
```

The scanner should explicitly decide which classes are allowed for CE and PE entries rather than treating large magnitude as universally positive.

Momentum-breakout/short-covering should remain a separate, separately validated path.

---

## 7.6 Require data-quality coverage in strategy scores

Every suggestion should include:

```text
availableFactors
missingFactors
dataFreshness
coverageScore
```

Do not let a high score based on a small subset look equivalent to a high score with full evidence.

---

# 8. Proposed Implementation Plan

A single huge PR would be difficult to review safely. The work should be divided into focused PRs.

## PR 1 — Broker Position Truth

**Scope**

- Strict Fyers/Dhan quantity parser.
- New broker position result type.
- Exact/partial/excess/short classification.
- Fill quantity validation.
- `openQtyUnits` tracking.
- Block oversized SELL.
- Broker payload fixture tests.

**Exit criteria**

- No malformed quantity becomes flat.
- No SELL exceeds verified quantity.
- All broker fixture tests pass.

---

## PR 2 — Orphan and Unknown-State Reconciliation

**Scope**

- `listNetPositions()`.
- Reverse broker-to-DB reconciliation.
- Risk latch.
- Quarantine status.
- Stronger unknown-order give-up criteria.
- Incident table and UI.
- Startup and periodic reconciliation.

**Exit criteria**

- Every broker position is matched or incidented.
- Unknown BUY remains risk-bearing.
- New entries blocked during mismatch/orphan.

---

## PR 3 — Guard Health and Session Integrity

**Scope**

- Structured quote health.
- Timestamped spot reads.
- Guard-blind alerts.
- Central market-session verifier.
- Pre-entry readiness verdict.
- Fast-guard health API/UI.
- External dead-man endpoint.

**Exit criteria**

- No silent quote failure.
- Stale spot cannot trigger/skip a stop as if fresh.
- All entry paths use one session verifier.

---

## PR 4 — AI Pass Policy and Account Risk

**Scope**

- Code-enforced one entry per pass.
- Require recent `check_order` ALLOW.
- Pass phases.
- Entry cooldown.
- Unrealized/worst-case portfolio risk.
- Automatic risk latch integration.
- Setting-change audit.

**Exit criteria**

- Two entry calls in one pass are impossible.
- Unknown risk blocks new entries.
- Account state reports full risk.

---

## PR 5 — CI, Deployment and Recovery

**Scope**

- Test runner and scripts.
- Mandatory validation workflow.
- Immutable SHA image.
- Release tag image.
- Versioned migrations.
- DB backups.
- Broker-flat auto-stop check.
- Exact version/digest health output.

**Exit criteria**

- No image builds if safety tests fail.
- Production version is exactly identifiable.
- Backup and rollback are tested.

---

## PR 6 — Strategy Validation Discipline

**Scope**

- Strategy config snapshots.
- Replay/live parity.
- Chaotic-open shadow mode.
- Signal vs execution scorecards.
- OI direction classification.
- Data coverage scoring.

**Exit criteria**

- “Shipped replay” matches production logic.
- Every decision is reproducible from stored config.

---

# 9. Test Matrix

## 9.1 Broker payload tests

| Case | Expected outcome |
|---|---|
| Valid exact Fyers quantity | Verified exact |
| Valid exact Dhan quantity | Verified exact |
| Missing quantity field | Unavailable, not flat |
| Alternative field name | Parsed only if explicitly supported |
| Negative quantity | Critical short incident |
| Partial quantity | Quarantined partial |
| Excess quantity | Critical mismatch |
| Empty position list with successful response | Verified flat for queried contract |
| Failed positions endpoint | Unavailable |
| Matching symbol but invalid quantity | Unavailable |

## 9.2 Order recovery tests

| Scenario | Expected outcome |
|---|---|
| POST timeout, order found by tag | Recovered |
| POST timeout, position found, no order found | Orphan/recovery incident |
| Five order misses, position API unavailable | Remain quarantined |
| Five order misses, verified flat, no trade | Verified failure |
| Partial BUY then cancel | Partial position, no full open |
| Partial SELL then cancel | Residual position tracked |
| Restart with unknown order | Reconciliation resumes |
| Duplicate exit callers | One broker submission |

## 9.3 Guard tests

| Scenario | Expected outcome |
|---|---|
| Premium below SL | Exit attempt |
| Dhan quote request fails once | Degraded health |
| Dhan quote request fails repeatedly | Critical alert and risk latch |
| Spot candle stale | Spot rule not trusted |
| Premium missing but fresh spot hits stop | Exit via spot rule |
| Premium and spot blind | Critical blind state |
| Square-off with quote outage | Exit still attempted |
| Exit rejected repeatedly | Escalation |

## 9.4 AI policy tests

| Scenario | Expected outcome |
|---|---|
| Place without check | Rejected |
| Check A, place B | Rejected |
| Check A ALLOW, wait too long, place A | Recheck required |
| Place A, then place B same pass | Rejected |
| Kill switch flips mid-pass | Entry refused |
| Existing unresolved position | New entry refused |
| Market session unknown | Entry refused |

## 9.5 Deployment tests

- Migration from production-like DB.
- Rollback to previous image against restored DB.
- Backup consistency with WAL enabled.
- Health endpoint reports commit and digest.
- Auto-stop refuses when broker lookup fails.
- CI fails on a deliberately broken broker fixture.
- CI fails on TypeScript/lint error.
- SHA image can be redeployed exactly.

---

# 10. Controlled Live Rollout Plan

After P0 changes are implemented:

## Stage 1 — Paper with fault injection

Run all broker scenarios using the simulated fault adapter.

Minimum:

- 5 trading sessions.
- No unresolved DB invariants.
- Guard health visible.
- Reconciliation incidents behave correctly.

## Stage 2 — Broker preflight only

- Test auth.
- Test funds.
- Test order book.
- Test position book.
- Run ₹0 unfillable limit/cancel test.
- Capture and store real broker payloads.
- Validate parsers against captured payloads.

## Stage 3 — Approval mode, one lot

Settings:

```text
mode = approval
maxTradesPerDay = 1
maxOpenLots = 1
AUTO_SHUTDOWN = off
critical alerts = required
```

Operator verifies:

- Order appears in broker.
- Filled quantity matches.
- Position appears in broker.
- Local trade matches.
- Stop levels are correct.
- Exit quantity matches.
- Local P&L matches broker.

## Stage 4 — Limited autonomous live

Only after multiple clean approval trades:

```text
maxTradesPerDay = 1
maxOpenLots = 1
one entry per pass
entry cooldown enabled
orphan scan enabled
risk latch enabled
dead-man monitor enabled
```

## Stage 5 — Increase limits cautiously

Increase only after evidence, not simply elapsed time.

---

# 11. Pre-Live Checklist

## Broker truth

- [ ] Fyers quantity parser tested with real payload.
- [ ] Dhan quantity parser tested with real payload.
- [ ] Negative quantity is a critical incident.
- [ ] Partial quantity is handled.
- [ ] Excess quantity is handled.
- [ ] Filled order quantity is validated.
- [ ] Broker-wide orphan scan is active.

## Order safety

- [ ] BUY and SELL correlation recovery tested.
- [ ] Unknown BUY remains risk-bearing.
- [ ] Unknown SELL blocks duplicate exits.
- [ ] Give-up requires position/trade-book proof.
- [ ] Restart recovery tested.

## Guard

- [ ] Option quote health is visible.
- [ ] Spot age is visible.
- [ ] Guard blind alert tested.
- [ ] EOD exit works during quote failure.
- [ ] Broker-native protection or documented residual risk accepted.

## Entry policy

- [ ] One entry per pass enforced in code.
- [ ] Recent check-order requirement enforced.
- [ ] Central session verification used.
- [ ] Risk latch blocks entries.
- [ ] Unrealized risk included.

## Operations

- [ ] Critical alert channel tested.
- [ ] Guard dead-man monitor active.
- [ ] Auto-stop checks broker positions.
- [ ] Immutable image deployed.
- [ ] DB backup created.
- [ ] Restore tested.
- [ ] Exact production commit/digest visible.

## Strategy

- [ ] Replay config matches production.
- [ ] Runtime config snapshot stored.
- [ ] Chaotic-open evidence reviewed out of sample.
- [ ] Signal and execution scorecards separated.

---

# 12. Recommended Immediate Actions

Before the next unattended live session:

1. Keep autonomous live mode off or use approval mode.
2. Set max trades and open lots to one.
3. Disable EC2 auto-shutdown while live positions are possible.
4. Verify the Fyers/Dhan position response fields using a real account payload.
5. Fix invalid `netQty` fallback-to-zero.
6. Block exits when broker quantity does not exactly match local quantity.
7. Add one-entry-per-pass enforcement.
8. Add critical guard-blind alerts.
9. Add spot timestamp validation.
10. Require a critical alert channel before approval/live mode.
11. Add CI validation before the next deployment.
12. Publish the next image by commit SHA.

---

# 13. Final Assessment

The application is not poorly designed. In fact, much of the difficult foundation is already present:

- Deterministic risk gates.
- Restricted AI tools.
- Atomic idempotency.
- Fresh approval rechecks.
- Correlation-based recovery.
- Independent guard.
- Fail-safe runtime defaults.
- Useful audit and timing data.

The main remaining issue is **truth reconciliation**:

```text
What does the broker actually hold?
How many units does it hold?
Which exact order created or closed them?
How fresh is the data protecting them?
```

Until those questions are answered strictly and bidirectionally, the system can still become locally confident while the broker account is in a different state.

The recommended sequence is therefore:

```text
Broker quantity truth
    ↓
Orphan discovery
    ↓
Guard health
    ↓
Code-enforced AI workflow
    ↓
Full account risk
    ↓
CI/deployment recovery
    ↓
Strategy optimization
```

Profitability improvements should come only after execution truth and recovery are provably reliable.

---

# Appendix A — Suggested Core Types

```ts
export type BrokerPositionRead =
  | {
      kind: 'verified';
      contractKey: string;
      netQtyUnits: number;
      buyAvg: number | null;
      sellAvg: number | null;
      rawSymbol: string;
      readAt: string;
    }
  | {
      kind: 'unavailable';
      contractKey: string | null;
      reason: string;
      readAt: string;
    };

export type QuantityVerdict =
  | { kind: 'flat'; actual: 0; expected: number }
  | { kind: 'exact'; actual: number; expected: number }
  | { kind: 'partial'; actual: number; expected: number }
  | { kind: 'excess'; actual: number; expected: number }
  | { kind: 'unexpected-short'; actual: number; expected: number }
  | { kind: 'unverifiable'; reason: string };

export interface RiskLatch {
  blocked: boolean;
  reasons: string[];
  activatedAt: string | null;
  requiresManualClear: boolean;
}

export interface GuardHealth {
  status: 'healthy' | 'degraded' | 'blind';
  lastTickAt: string | null;
  lastFreshOptionQuoteAt: string | null;
  lastFreshSpotAt: string | null;
  consecutiveOptionFailures: number;
  consecutiveStaleSpotChecks: number;
  reasons: string[];
}
```

---

# Appendix B — Suggested Safety Invariants

```text
Invariant 1:
A local open real trade must map to a verified positive broker quantity.

Invariant 2:
A normal automated SELL must never exceed verified broker-held quantity.

Invariant 3:
A non-zero broker F&O position must map to a local trade or an active incident.

Invariant 4:
Unknown BUY/SELL states remain risk-bearing until positively resolved.

Invariant 5:
Missing or invalid broker quantity is unknown, never flat.

Invariant 6:
No new entry is allowed while the risk latch is active.

Invariant 7:
No more than one entry attempt is allowed per AI pass.

Invariant 8:
A live entry requires a current verified exchange session and healthy market data.

Invariant 9:
Critical alerts cannot be disabled in approval/live mode.

Invariant 10:
Production can run only an immutable, validated image with a restorable DB backup.
```
---

# 14. Stop-Loss Cadence and Target-Execution Improvements

This section clarifies how frequently the live position guard should run, which market price should trigger an exit, and what “1:2 risk/reward” means in the current implementation.

---

## AT-026 — Reduce the 60-second guard interval, but do not treat faster REST polling as a complete solution

**Priority:** P0/P1 depending on live mode

### Current behavior

The fast guard currently targets:

```ts
export const FAST_GUARD_TICK_MS = 60_000;
```

It batches all held option contracts into one quote request and evaluates deterministic exits. This is materially safer than checking only on the five-minute engine cycle, but one minute is still long for intraday stock options.

Actual reaction time is greater than the configured interval:

```text
Detection delay
+ request queue delay
+ broker/data latency
+ application processing
+ order-submission latency
+ exchange execution latency
```

A configured 60-second interval can therefore become a materially longer end-to-end exit.

### Recommended immediate setting

Start with:

```ts
export const FAST_GUARD_TICK_MS = 10_000;
```

This is a **10-second target cadence**, not a guarantee of a 10-second exit.

Before deployment:

- Confirm the broker/data API’s current account-wide rate limits.
- Count scanner, approval, AI quote refresh, guard, and other consumers together.
- Keep a shared rate limiter.
- Measure actual quote latency and guard drift.
- Alert when the achieved cadence is slower than expected.

### Recommended enterprise architecture

```text
Primary protection:
WebSocket/tick stream
    ↓
Immediate deterministic stop/target evaluation

Secondary protection:
10–15 second REST quote guard
    ↓
Detect stream failure or missed events

Tertiary protection:
Broker-native protective order
    ↓
Protect the position even if the server is unavailable
```

The REST loop should eventually become a dead-man/recovery control rather than the only active stop checker.

### Adaptive cadence

A fixed 10-second interval is simple and safe as a first improvement. A later optimization can use an adaptive interval:

| Position state | Suggested cadence |
|---|---:|
| No open positions | No position quote polling |
| Healthy and far from any level | 10–15 seconds |
| Within 0.5R of stop or target | 2–5 seconds |
| Exit order in flight | Reconcile according to broker limits |
| Market-data degraded | Bounded retry/backoff plus critical alert |
| After square-off time | Immediate exit/reconcile loop |

Do not retry aggressively during a broker outage. A retry storm can worsen rate limiting and hide the original failure.

### Guard concurrency

The current single-flight guard behavior should remain:

```text
If a five-minute engine pass and fast guard overlap,
only one guard evaluation owns the quote and exit attempt.
```

Reducing the interval must not create duplicate quote or SELL calls.

### Definition of done

- Target interval is 10 seconds initially.
- Actual drift and latency are measured.
- Shared API rate-budget usage is visible.
- Duplicate guard execution remains impossible.
- Guard health becomes degraded if achieved cadence exceeds a configured SLA.
- WebSocket and broker-native protection are separately planned.

---

## AT-027 — Use executable exit price rather than LTP alone

**Priority:** P0 for target correctness; P1 for general execution quality

### Current problem

The guard compares premium stop and target against option LTP.

For a long option position, the system exits by **selling**. The immediately executable side is therefore the bid, not the last traded price.

Example:

```text
LTP:          ₹180
Best bid:     ₹168
Best ask:     ₹182
Target:       ₹178
```

An LTP-based rule says the target was reached. However, the position may be sellable only around ₹168.

### Recommended trigger prices

For a long option:

```ts
const executableSellPrice =
  quote.bid != null && quote.bidQty != null && quote.bidQty > 0
    ? quote.bid
    : null;
```

Target trigger:

```ts
if (
  quote.fresh &&
  executableSellPrice != null &&
  executableSellPrice >= trade.targetPremium &&
  quote.bidQty >= verifiedExitQty
) {
  // target is executable for the intended quantity
}
```

Stop trigger:

```ts
if (
  quote.fresh &&
  executableSellPrice != null &&
  executableSellPrice <= trade.slPremium
) {
  // protective exit
}
```

### Different confirmation rules for stop and target

The stop and target should not be treated identically.

#### Target

Use a stricter executable test:

- Fresh bid.
- Bid at or above target.
- Sufficient visible bid quantity where available.
- Optionally place a resting limit SELL at the target after entry.

#### Stop

Capital protection has priority:

- Fresh bid below stop should trigger an exit.
- A normal shallow breach can be confirmed by two closely spaced observations.
- A deep/emergency breach should exit immediately.
- Do not wait for a five-minute candle confirmation for the premium hard stop.

Example policy:

```ts
if (bid <= emergencyStop) exitImmediately();
else if (bid <= normalStop && secondFreshSampleConfirms()) exit();
```

The confirmation delay must be very short and must not apply during rapid deterioration.

### Order-book quality

A bid should not be trusted blindly. Validate:

- Quote timestamp/freshness.
- Positive bid quantity.
- Bid/ask sanity.
- Spread.
- Sudden impossible jumps.
- Instrument identity.
- Sequence/order of updates when using a stream.

### Definition of done

- Premium target does not fire from LTP alone.
- Stop decisions use a fresh executable-side price.
- Missing/stale bid is reported as degraded protection.
- Quantity needed for the exit is compared with visible/verified liquidity.
- Tests include LTP-above-target but bid-below-target.

---

## AT-028 — Define target policy explicitly; current behavior is not exactly 1:2

**Priority:** P1

### Current behavior

The system currently has more than one exit target:

1. Scanner structure-based spot target, described as approximately 1:2.
2. Premium rupee stop anchored to the actual fill:
   - Maximum configured loss threshold: ₹1,500 per lot.
3. Premium fixed profit target:
   - ₹5,000 per lot.
4. AI discretionary early exit.
5. Supertrend/momentum exit.
6. Trailing stop to breakeven after a premium gain.
7. EOD square-off.

The premium fixed target has a nominal relationship of:

```text
₹1,500 risk : ₹5,000 target
≈ 1 : 3.33
```

It is not 1:2.

The actual premium stop can be even tighter than ₹1,500 because the code chooses the tighter of:

```text
40% premium loss
or
₹1,500 per-lot loss
```

Therefore the planned premium reward multiple can be greater than 3.33R in some contracts.

### Why spot 1:2 does not equal premium 1:2

Option premium does not move linearly with the underlying because of:

- Delta.
- Gamma.
- Implied volatility.
- Theta.
- Spread and liquidity.

A spot target at 2R does not guarantee that the option premium will be at 2R.

### Recommended explicit target policy

Add a runtime setting:

```ts
type TargetPolicy =
  | 'spot_structure'
  | 'premium_r_multiple'
  | 'fixed_rupees'
  | 'hybrid_first_hit';
```

Add:

```ts
rewardMultiple: number; // e.g. 2.0
```

For an exact **planned premium 1:2 trigger**:

```ts
const premiumRiskPerUnit = entryFillPremium - slPremium;
const targetPremium =
  entryFillPremium + rewardMultiple * premiumRiskPerUnit;
```

For `rewardMultiple = 2`:

```text
Entry fill:       ₹200
Premium stop:     ₹180
Risk:             ₹20
Premium target:   ₹240
Planned trigger:  1:2
```

### Recommended policy choice

For the current strategy, use one of these deliberately:

#### Option 1 — Keep current TF-style hybrid

```text
Spot structure target
OR ₹5,000 premium target
OR earlier risk exit
```

Rename it clearly:

```text
hybrid_first_hit
```

Do not describe it as an exact 1:2 system.

#### Option 2 — Enforce premium 1:2

```text
Premium stop derived from actual fill
Premium target = 2 × actual premium risk
```

This is easier to measure in realized R but can conflict with the scanner’s structural spot target.

#### Option 3 — Structure first, R as a minimum filter

Use the scanner’s spot target, but accept the trade only when the estimated premium reward is at least 2R. This preserves market structure while maintaining a risk standard.

### Trigger is not fill

Even with a 1:2 premium target, the application can only guarantee:

```text
The exit condition was detected at or beyond 2R.
```

It cannot guarantee:

```text
The exchange filled exactly at 2R.
```

Actual fill is affected by:

- Spread.
- Bid quantity.
- Network and broker latency.
- Gaps.
- Partial fills.
- Exchange queue.

Track three different values:

```ts
plannedTargetR
triggeredAtR
realizedR
```

### Broker-native target order

A resting limit SELL at the target can improve target execution:

- Fill occurs at target or better.
- It does not guarantee a fill merely because LTP touched the level.
- The protective stop and target orders must be managed as an OCO pair.
- Filling one leg must cancel the other safely.
- Partial fills must update remaining quantity.

### Definition of done

- UI states the configured target policy.
- “1:2” refers to planned trigger R, not guaranteed fill R.
- Planned, triggered, and realized R are stored separately.
- Premium and spot target semantics are not mixed silently.
- Backtests use the same target policy as live execution.

---

---

# 15. Conservative Token and Latency Policy

Token cost is secondary to:

1. Exit safety.
2. Decision quality.
3. Freshness of market and account state.
4. Predictable latency.
5. Auditability.

No token-saving change should be deployed merely because it reduces usage. It must first prove that it does **not** reduce trading performance, skip a relevant decision, delay an exit, or weaken the model’s grounding.

The current implementation already includes several safe optimizations:

- AI is skipped when auto-trade mode is off.
- AI is skipped when the kill switch is active.
- AI is skipped when there are no open positions and no valid entry opportunity.
- The guard’s option quotes are reused in the initial AI context.
- The auto-trade decision replaces a second standalone commentary call.
- Redundant read-tool calls are measured.

These optimizations should remain. They save tokens without changing the trading decision that would otherwise be made.

---

## AT-029 — Do not create subagents in the live trading path

**Priority:** Strong architecture recommendation  
**Confidence:** High

### Recommendation

Do **not** add separate live agents for:

- Entry selection.
- Position management.
- Stop-loss decisions.
- Exit decisions.
- Risk approval.
- Commentary synthesis.

A multi-agent live path would normally add:

- Additional model calls.
- Repeated market/account context.
- More tokens.
- More network latency.
- More timeout points.
- Coordination complexity.
- Possibility of conflicting decisions.
- Harder incident reconstruction.

The safest live architecture remains:

```text
Deterministic reconciliation
        ↓
Deterministic risk and stop guard
        ↓
One decision model
        ↓
Deterministic validation and execution
        ↓
Audit and presentation
```

Risk, reconciliation, stop-loss enforcement, quantity validation, and broker execution must remain deterministic.

### Acceptable use of subagents

Subagents may be used outside the live execution path for read-only work:

- End-of-day analysis.
- Replay interpretation.
- Broker-statement comparison.
- Incident summarization.
- Weekly performance reports.
- Strategy research.
- Code review.

They must not own live orders or be required for the position guard to function.

---

## AT-030 — Do not suppress regular AI passes yet using a material-change filter

**Priority:** Future experiment only  
**Confidence for immediate production use:** Insufficient

### Why this was downgraded

A material-change filter could save significant tokens, but an incorrectly designed filter can suppress a useful discretionary review.

Examples:

- Several individually small changes combine into a meaningful thesis change.
- OI, trend, and price each change slightly but collectively justify an exit.
- A position deteriorates without crossing a simple R bucket.
- A candidate improves gradually rather than through one discrete event.
- The filter itself uses stale or incomplete data.

The deterministic guard will still protect hard stops, but discretionary AI performance could decline.

### Safe approach

Do not skip the AI initially.

Implement the filter in **shadow mode** only:

```text
AI continues to run normally.
The filter records:
- wouldRun = true/false
- reasons
- fingerprint
```

Then compare:

```text
When the filter said “skip,” did the AI:
- take an exit?
- move a stop?
- identify thesis deterioration?
- select a new trade?
- materially change its verdict?
```

### Production acceptance criteria

A material-change gate may be considered only after sufficient paper/approval evidence shows:

- No missed AI exits.
- No missed stop-tightening actions.
- No missed high-quality entries.
- No increase in adverse excursion.
- No increase in average decision latency.
- Stable results across different market regimes.
- Deterministic guard behavior remains unchanged.

Until then:

```text
Do not enable AI-call suppression in live mode.
```

---

## AT-031 — Keep the current decision-plus-commentary model until equivalence is proven

**Priority:** Future optimization  
**Confidence for immediate replacement:** Insufficient

### Earlier suggestion

A structured JSON decision followed by deterministic Markdown rendering could reduce output tokens and improve presentation consistency.

### Risk

The current natural-language output may contain useful contextual judgment that a narrow schema could accidentally remove.

Examples:

- Nuanced reason for holding instead of exiting.
- Interaction between open-position management and a new candidate.
- Market-wide caution not represented in a fixed schema.
- A warning that does not fit one predeclared action field.

A schema can also create migration risk:

- Provider structured-output differences.
- Parser failure.
- Missing optional fields.
- Incorrect rendering of actual execution results.
- New code path between model decision and operator visibility.

### Recommendation

Do not replace the current production decision format immediately.

First build an offline/shadow prototype:

```text
Current model output remains authoritative.
Structured output is generated and compared.
No live action depends on the new schema.
```

Approve only after:

- Every current action can be represented.
- No reasoning needed by operators is lost.
- Tool actions and rendered commentary always agree.
- Parser failure is fail safe.
- End-to-end latency is equal or lower.
- Replay and paper sessions show decision equivalence.

---

## AT-032 — Keep the existing refresh tools for now

**Priority:** No immediate change  
**Confidence:** High

The model currently receives preloaded:

- Account state.
- Open positions.
- Scanner picks.

It can still call:

- `get_account_state`.
- `get_open_positions`.
- `get_scan_picks`.

Those tools consume schema tokens, but they also provide an explicit way to refresh stale information during a longer model loop.

Removing or merging them could:

- Make the model use stale context.
- Add ambiguity about what a combined refresh returned.
- Increase the size of unnecessary refresh results.
- Change established tool-calling behavior.

### Recommendation

Keep the existing tools.

Continue measuring:

```text
redundantReadTools
```

Only optimize after real evidence shows the calls are consistently redundant and not protecting freshness.

A safe minor improvement is to add timestamps to all preloaded context so the model can decide whether refresh is necessary.

---

## AT-033 — Keep `check_order` and `place_entry_order` separate

**Priority:** No immediate change  
**Confidence:** High

### Earlier suggestion

Combining both into one `attempt_entry` tool could reduce a model/tool round trip.

### Why it should remain separate for now

The two-step flow provides:

1. An explicit dry-run gate result.
2. A model opportunity to stop after seeing a rejection.
3. Better audit separation between intention and execution.
4. Visibility into which gate refused the trade.
5. A clear contract that placement occurs only after an ALLOW result.

`place_entry_order` re-runs all gates, which protects against time-of-check/time-of-use changes.

The extra round trip adds some latency, but entry latency is less safety-critical than exit latency. The system is not intended to chase microsecond entries.

### Recommendation

Keep:

```text
check_order
    ↓
place_entry_order
```

Also enforce in code:

- `place_entry_order` requires a recent ALLOW for the same symbol.
- Only one entry attempt per engine pass.
- Placement still re-runs all gates using fresh state.

This improves safety without removing the existing deliberation step.

---

## AT-034 — Keep previous commentary until structured memory proves equivalent

**Priority:** Future experiment only  
**Confidence for immediate removal:** Insufficient

The previous commentary consumes tokens, but it helps preserve continuity during the trading day.

Replacing it with a compact memory may lose:

- Why a name was previously rejected.
- What the model was waiting to see.
- Earlier thesis language.
- Operator-facing continuity.

### Recommendation

Keep the existing previous-read input in production.

Possible safe evaluation:

1. Generate structured memory in parallel.
2. Keep full previous commentary authoritative.
3. Compare decisions using:
   - Full commentary.
   - Structured memory only.
4. Measure differences over replay and paper sessions.

Remove the full text only if decision quality and continuity are proven equivalent.

---

## AT-035 — Do not reduce `MAX_TOOL_STEPS` now

**Priority:** No immediate change  
**Confidence:** High

The current maximum is a ceiling, not a requirement that all ten steps be used.

Reducing the ceiling can cause:

- Forced final responses.
- Incomplete position review.
- Missing final commentary.
- Failure to recover from one rejected or refreshed tool call.
- Different behavior with two open positions.

### Recommendation

Keep:

```ts
MAX_TOOL_STEPS = 10;
```

Measure:

- Actual steps per pass.
- 95th and 99th percentile steps.
- Forced-final-call frequency.
- Timeout frequency.
- Empty-response frequency.
- Tool retries.

A lower limit should be considered only after the flow is simplified and all historical/replay cases fit comfortably below the proposed ceiling.

---

## AT-036 — Do not reduce model token budgets without provider-specific evidence

**Priority:** No immediate change  
**Confidence:** High

Reasoning models may consume hidden or visible reasoning tokens before producing the final answer. An aggressive output cap can cause:

- Empty responses.
- Truncated decisions.
- Missing final commentary.
- More retries.
- Higher total latency and cost.

### Recommendation

Keep current budgets until actual usage data is collected.

Track per scenario:

```text
prompt tokens
completion tokens
model latency
tool rounds
empty responses
forced-final calls
decision type
number of open positions
number of candidates
```

Any future budget reduction must show:

- No truncation.
- No empty output.
- No increase in retries.
- No decision-quality regression.
- Equal or lower p95 latency.

---

## AT-037 — Safe token optimizations that do not change model behavior

The following are the only recommended low-risk token actions at this stage.

### 1. Preserve existing skip conditions

Continue skipping AI only when there is truly nothing to decide, as already implemented.

### 2. Reuse data already fetched in the same cycle

Continue reusing the deterministic guard’s quotes when building AI context.

This reduces duplicate API calls and improves latency without removing information.

### 3. Keep one AI analysis per cycle

Continue avoiding a second standalone commentary call after the auto-trade AI already produced the cycle read.

### 4. Measure redundant tools before changing them

Keep telemetry for repeated getter calls. Do not remove tools based on intuition alone.

### 5. Keep static prompt/tool content stable

Where the selected provider offers transparent prompt-prefix caching, use it without changing prompt semantics.

Caching must be treated as an infrastructure optimization only:

```text
Same instructions
Same tools
Same model behavior
Lower repeated-input cost where supported
```

The trading system must not depend on cache availability.

### 6. Separate offline analysis from live analysis

Run detailed EOD and research analysis after market hours. Do not include large historical datasets in every live decision turn.

### 7. Trim only demonstrably unused fields

A field may be removed from live context only after:

- Usage review.
- Replay comparison.
- Paper A/B testing.
- Confirmation that the model never relies on it for a correct decision.

Do not trim safety, freshness, liquidity, position, or execution fields merely to save tokens.

---

# 16. Required Evaluation Framework for Any Token Change

Every optimization must be evaluated against a fixed baseline.

## Baseline

The current production flow remains the control:

```text
Current prompt
Current tools
Current token budget
Current tool-step ceiling
Current AI-call schedule
```

## Evaluation modes

1. Historical replay.
2. Recorded-cycle replay.
3. Paper trading.
4. Approval-mode shadow comparison.
5. Limited live observation only after prior stages pass.

## Decision-equivalence metrics

Compare:

- Entry selected.
- Entry skipped.
- Exit requested.
- Hold decision.
- Stop modification.
- Watch candidate.
- Gate outcome.
- Explanation quality.
- Unsupported/invented claims.

## Trading-performance metrics

Compare:

- Win rate.
- Average realized R.
- Maximum adverse excursion.
- Maximum favorable excursion.
- Missed exits.
- Missed entries.
- Entry delay.
- Exit delay.
- Slippage.
- Drawdown.

## Reliability and latency metrics

Compare:

- End-to-end AI pass latency.
- p50, p95, and p99 latency.
- Model-call count.
- Tool-call count.
- Timeout rate.
- Empty-response rate.
- Forced-final rate.
- Parser failures.
- Provider errors.

## Minimum acceptance rule

A token optimization should not be promoted when it produces merely “similar-looking” commentary.

It must show:

```text
No safety regression
AND no meaningful decision regression
AND no latency regression
AND measurable token/cost improvement
```

For live trading, uncertain results mean:

```text
Keep the existing implementation.
```

---

# 17. Conservative Live Architecture

```text
1. Reconcile unresolved orders                    Deterministic
2. Reconcile broker and local positions           Deterministic
3. Run stop/target/EOD guard                       Deterministic
4. Compute risk and safety latch                   Deterministic
5. Apply existing “nothing to decide” check        Deterministic
6. Build fresh, complete context                   Deterministic
7. Run one decision model                          AI
8. Run check_order                                 Deterministic
9. Run placement/exit tools                        Deterministic
10. Store audit and commentary                     Deterministic + AI text
```

No live subagent is required.

The AI must never be placed in the mandatory stop-loss path.

---

# 18. Updated Immediate Recommendations

## Stop-loss and execution improvements

1. Reduce the fast guard target from 60 seconds to 10 seconds only after confirming shared API-rate capacity.
2. Measure actual guard drift and end-to-end exit latency.
3. Add quote freshness and guard-blind monitoring.
4. Use a fresh executable bid for target validation.
5. Treat a target trigger and actual fill as different values.
6. Define whether the strategy uses spot structure, premium R multiple, fixed rupees, or a hybrid target.
7. Do not describe the current ₹1,500/₹5,000 premium plan as exact 1:2.
8. Store planned R, triggered R, and realized R separately.
9. Add WebSocket or broker-native protection as a later resilience improvement.

## Token and agent policy

1. Do not add subagents to the live execution flow.
2. Do not enable a material-change AI skip gate in production yet.
3. Do not replace natural-language decisions with structured output yet.
4. Do not remove or merge refresh tools yet.
5. Keep `check_order` and `place_entry_order` separate.
6. Keep the current previous commentary input.
7. Keep the 10-step tool ceiling.
8. Keep current model token budgets.
9. Continue only the token optimizations already proven by the existing engine.
10. Evaluate every future optimization in shadow mode against decision, performance, reliability, and latency metrics.

The correct priority is:

```text
Safety and decision quality
        ↓
Latency
        ↓
Reliability
        ↓
Token cost
```
