# Production Operations

## Production environment

- Application: `https://charan-projectr.duckdns.org`
- Host: AWS EC2
- Container: `projectr`
- Image: `ghcr.io/charan1922/project-r-simulator:latest`
- Deployment source: a push/merge to the `prod` branch
- AWS box deployment: guarded pull/restart from `/opt/projectr/auto-deploy.sh`

Railway is not used for this production application. A Railway status visible on a
GitHub commit is a leftover integration and is not the deployment source of truth.

## Where to inspect the feature

### Configuration

Open:

`https://charan-projectr.duckdns.org/config`

Find the **Candle Freshness** category. The important current control is:

- **Block stale-candle Auto-Trade entries** — keep ON.

Runtime database overrides persist across deployments, so check `/config` again
instead of assuming code defaults are effective.

> **Removed 2026-08-13.** The capped priority-refresh SHADOW (its `/config`
> numeric settings, the `Priority Refresh (shadow)` panel on `/trade-commentary`
> and `GET /api/priority-refresh`) was deleted along with its planner, sector
> snapshots and cycle telemetry. The stale-candle entry gate documented below is
> the only part of that work still running. Sections of this document describing
> shadow panels or proposed-cap numbers are history.

### Entry safety and rejection reasons

Use:

- `https://charan-projectr.duckdns.org/auto-trade`
- `https://charan-projectr.duckdns.org/logs`

Search for:

```text
latest completed 5-min candle is stale
candle freshness metadata failed
priority EQ refresh
database is locked
```

An informational `candle freshness metadata failed` warning should not stop the
scan. A placement-time stale-candle rejection should block only the new entry.

## Normal operating expectations

- Shadow panels can be empty outside market-time cycles or immediately after a
  deployment.
- The live full-priority wait remains unchanged.
- The AWS auto-deploy cron can defer a restart while a trade is open, placing, or
  pending approval.
- A production merge builds and publishes the GHCR image before the AWS box pulls it.
