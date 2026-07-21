# New Session Handoff

Paste the following into a new Codex session when continuing this work:

```text
Read the repository's knowledge-base/README.md and every file under
knowledge-base/init/. Also inspect final-capped-priority-sector-plan.md, the current
priority-refresh code, and PRs #13 and #14.

First report the current effective production values of BLOCK_STALE_AUTO_ENTRY,
PRIORITY_REFRESH_SHADOW, and PRIORITY_ACTIVE_SECTORS_SHADOW. Then inspect the
Priority Refresh shadow evidence from production.

Do not expose or enable USE_CAPPED_PRIORITY_REFRESH or
PRIORITY_INCLUDE_ACTIVE_SECTORS merely by adding buttons or database keys. The live
behavior, fail-closed guards, full-list fallback, Tier 0 protection, tests, telemetry,
and rollback control must be implemented and reviewed together.

If the evidence is sufficient, implement capped-live first while keeping sector-live
OFF. Preserve entry safety, exits, position guards, reconciliation, and square-off.
Use AWS as the production environment; Railway is not used.
```

## Quick current-state summary

As of 2026-07-21:

- stale-candle protection is live and ON;
- reduced priority refresh is shadow-only and ON;
- active-sector promotion is shadow-only and ON;
- live capped refresh is OFF and has no `/config` button;
- live sector promotion is OFF and has no `/config` button;
- production runs on AWS EC2 from the `prod` branch and GHCR image;
- PR #14 made suggestion-time freshness metadata failures non-fatal;
- PR #13 promoted the cumulative release to production.
