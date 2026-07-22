# Live Enablement Plan

## Current decision

Do not expose or enable live capped priority refresh yet.

The existing shadow switches collect evidence. They are not hidden live switches,
and manually creating database overrides for future flags is unsafe and misleading.

## Evidence required

Collect at least 5–10 complete trading days before proposing live activation.

Review the **Priority Refresh (shadow)** panel and stored telemetry. Confirm:

- suggestions outside the proposed cap are consistently zero or rare and harmless;
- Tier 0 always contains open/risk-bearing positions and earlier picks;
- no repeated shadow, database-lock, or freshness failures occur;
- missing or stale sector data falls back safely;
- proposed sector promotions improve useful coverage instead of displacing better
  candidates;
- Auto Trade, the poller, and the fast position guard remain stable.

Do not decide from one profitable or unprofitable day. Shadow membership does not
prove profitability by itself.

## Required capped-live implementation

The future capped-live PR must implement the behavior and the button together.
It must include:

1. A `/config` control named **Use capped priority refresh**.
2. Tier 0 unioned into the actual live download/wait universe.
3. A read-time fail-closed guard: capped live cannot run unless stale-entry blocking
   is effectively ON.
4. Full-list fallback for invalid settings, unavailable planner inputs, stale data,
   exceptions, or unsafe combinations.
5. Telemetry showing timing saved as well as coverage retained.
6. An immediate operator rollback to the existing full-priority behavior.
7. Tests for configuration drift, multi-process ownership, failures, and boundary
   conditions.

Enable capped-live first while keeping sector-live OFF.

## Required sector-live implementation

Only after capped-live is stable and sector evidence is sufficient, implement a
second control named **Include active sectors in priority refresh**.

Before sector-live, add:

- a final production-quality sector source, preferably full F&O coverage rather
  than only mover-feed candidates;
- strict validation of stored direction and numeric values;
- safe behavior for empty, stale, invalid, and future snapshots;
- proof that sector reservations do not reduce important coverage;
- rollback to ordinary capped selection.

## Future enablement order

When both reviewed implementations exist:

1. Keep **Block stale-candle Auto-Trade entries** ON.
2. Keep both shadow switches ON.
3. Turn **Use capped priority refresh** ON.
4. Observe several sessions and be ready to turn it OFF immediately.
5. Keep **Include active sectors in priority refresh** OFF until separately proven.
6. Enable sector-live only after its own review and evidence period.

The two live controls do not exist today. A note or UI button alone is not an
implementation and must not be used to imply production readiness.
