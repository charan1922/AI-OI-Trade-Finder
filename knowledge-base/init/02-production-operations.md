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

Find the **Priority Refresh** category. The important current controls are:

- **Block stale-candle Auto-Trade entries** — keep ON.
- **Shadow: reduced priority refresh** — keep ON while gathering evidence.
- **Shadow: active-sector promotion** — keep ON while gathering evidence.

The effective production values were checked on 2026-07-21 and all three were ON.
Runtime database overrides persist across deployments, so check `/config` again
instead of assuming code defaults are effective.

Shadow numeric settings include:

| Setting | Default | Meaning |
|---|---:|---|
| Names considered per feed | 10 | Eligible ranks read from each of five feeds |
| Max unique Tier 1 stocks | 40 | Proposed normal candidate cap |
| Sector-reserved Tier 1 slots | 10 | Part of the 40 reserved for sector alignment |
| Top sectors per side | 2 | Bullish sectors and bearish sectors considered |
| Max sector snapshot age | 420 sec | Previous-cycle data freshness limit |

Changing these values currently changes only shadow proposals, not the live wait.

### Shadow measurements

Open:

`https://charan-projectr.duckdns.org/trade-commentary`

Look for **Priority Refresh (shadow)**. The panel appears only after at least one
eligible cycle has stored data for the current day.

It shows:

- full priority count;
- Tier 0 count;
- base Tier 1 count;
- sector-promoted count;
- proposed wait-group count;
- suggestions outside the proposed cap;
- active bullish and bearish sectors.

The advanced read-only endpoint is:

`GET /api/priority-refresh`

### Entry safety and rejection reasons

Use:

- `https://charan-projectr.duckdns.org/auto-trade`
- `https://charan-projectr.duckdns.org/logs`

Search for:

```text
latest completed 5-min candle is stale
candle freshness metadata failed
priority-refresh shadow failed
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
