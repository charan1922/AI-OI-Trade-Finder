# TF browser worker

Runs the TradeFinder headless-Chromium relay on its own host so Chromium never
competes for CPU with the trading app. Design:
`docs/superpowers/specs/2026-08-24-tf-browser-remote-worker-design.md`.

## Why it is not on the main box

Real CPU history (2026-08-24): the trading box averaged ~2.5-4% CPU on trading
days before this relay existed and ~37-65% sustained afterwards, with
Fyers/Dhan polling unchanged. Three in-place mitigations shipped and none fixed
it (v1.55.5 Chromium flags, v1.55.6 staggered reloads, v1.55.7 OS `nice`); a
latency probe after the last still caught a 13.4s stall on `GET /api/health`, a
handler that does no async work at all.

## Host requirement: a STABLE outbound IP

Not a preference. All TradeFinder traffic currently leaves from one Elastic IP.
TF already signs this account out roughly daily, and a rotating pool of
datacenter IPs is a scraping signature aimed at the feed the entire trade
selector depends on — and that selector is fail-closed, so a blocked account
means zero picks, not degraded picks.

This is why AWS Lambda was rejected: its egress IP changes per invocation, and
pinning it requires a NAT Gateway at ~$33/month — more than the small VM it was
meant to undercut.

Suitable hosts: an Oracle Cloud Always Free VM, or a small AWS EC2 instance.

## Setup

```bash
npm install playwright
npx playwright install --with-deps chromium

export MAIN_APP_URL="https://charan-projectr.duckdns.org"
export TF_WORKER_SECRET="<same value as the main app's env>"
node worker.mjs
```

Keep it running under systemd with `Restart=always` so a crash recovers without
a human. The worker is stateless — it re-reads cookie, page list and cadence
from the main app every 60s, so a fresh "Copy as cURL" paste on `/tf` takes
effect within one poll and needs no worker restart.

### systemd unit

```ini
[Unit]
Description=TradeFinder browser worker
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/tf-worker
Environment=MAIN_APP_URL=https://charan-projectr.duckdns.org
Environment=TF_WORKER_SECRET=<secret>
ExecStart=/usr/bin/node worker.mjs
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## Verifying it works

- `/tf` on the main app shows *browser running* within ~1 minute of start.
- `/tf`'s capture log shows fresh `all_sector` / `daily-index` / `market_pulse`
  rows.
- The worker log prints `[tf_worker] launching Chromium for 2 page(s)`.
- If `/tf` says *running, not capturing*, the worker is alive but TradeFinder is
  rejecting it — paste a fresh cURL on `/tf`. That distinction is the whole
  point of the badge (see the 2026-08-10 incident in `lib/tf-live/ingest.ts`).

## Adding another TradeFinder feed

Do not edit this worker. On the MAIN app:

1. Add the endpoint to `lib/tf-live/endpoints.ts` — **and give it its own
   `endsWith` case in `endpointTagFor()`** (`lib/tf-live/ingest.ts`). The
   generic fallback matches none of TradeFinder's real paths; skipping this
   step is exactly how `market_pulse` sat silently dead from 2026-08-08 until
   2026-08-26.
2. Add a parser in `parse.ts` if you want per-symbol rows.
3. If the feed lives on a TradeFinder page not already opened, add that URL to
   `TF_PAGES` in `app/api/tf/worker-config/route.ts`.

The worker picks all of it up on its next poll, unchanged and un-redeployed.
