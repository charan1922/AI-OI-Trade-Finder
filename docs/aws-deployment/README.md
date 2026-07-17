# AWS Deployment — Start Here

How the trading app runs in production on AWS, and everything the deployment handles.
Plain and direct — it assumes you know general engineering (IPs, Docker, CI/CD, cron)
but not *this* system's specific wiring. Read in order or jump to what you need.

---

## The whole system in one picture

```
   Browser                              GitHub                        AWS
   ───────                              ──────                        ───
      │                                    │                           │
      │  1. GET https://…duckdns.org       │                    ┌──────────────┐
      │───────────────────────────────────────────────────────▶│  EC2 "box"   │
      │                                    │                    │  Caddy :443  │
      │                                    │                    │    → app     │
   (push code)                             │                    │      :5001   │
      │  2. git push origin :prod          │                    │  ┌────────┐  │
      │───────────────────────────────────▶│  3. Actions builds │  │ Docker │  │
      │                                    │     image → ghcr.io │  │ image  │  │
      │                                    │────────────────────────┘  ▲       │
      │                                    │  4. box cron pulls :latest │       │
      │                                    │     every 10m, restarts ───┘       │
      │                                    │                    └──────────────┘
```

**In one paragraph:** one always-on EC2 instance (*"the box"*) runs the app behind
Caddy (HTTPS). A push to the `prod` branch makes GitHub Actions build a Docker image
and push it to ghcr.io; a cron on the box pulls the new image and restarts itself
(unless a trade is open). The app also runs the whole trading loop **headlessly** —
market capture, auto-trade, position management — with no browser open.

---

## Why this exists at all

SEBI requires automated trading from **one fixed IP**, registered with the broker.
Railway's egress IP wasn't stable, so we moved to EC2 with an **Elastic IP** we
control and whitelisted at Fyers. That single constraint drove the whole move.
Details in [01](01-why-we-moved-to-aws.md).

---

## The files

| # | File | Covers |
|---|---|---|
| 01 | [why-we-moved-to-aws.md](01-why-we-moved-to-aws.md) | The fixed-IP requirement that forced the move |
| 02 | [the-server-box.md](02-the-server-box.md) | The EC2 instance, its Elastic IP, sizing, cost |
| 03 | [getting-a-secure-website.md](03-getting-a-secure-website.md) | DuckDNS + Caddy + Let's Encrypt; ports |
| 04 | [building-and-shipping-the-app.md](04-building-and-shipping-the-app.md) | Dockerfile → ghcr → CI/CD → auto-deploy cron |
| 05 | [settings-and-secrets.md](05-settings-and-secrets.md) | env-file, data volume, box-vs-laptop safety flags |
| 06 | [jobs-that-run-by-themselves.md](06-jobs-that-run-by-themselves.md) | The headless autonomous jobs |
| 07 | [saving-money-auto-onoff.md](07-saving-money-auto-onoff.md) | Auto power-off to cut idle cost |
| 08 | [everyday-commands.md](08-everyday-commands.md) | box start/stop, pull prod data, logs, deploy |
| 09 | [brokers-and-safety.md](09-brokers-and-safety.md) | Fyers type-200 app, two-key live, safety nets |

---

## Where the real config lives

Some config lives **on the box** and is edited in place under `/opt/projectr/` — it is
**not** in this repo: the Caddyfile, the auto-deploy cron script, the `docker run`
command, and the crontab. These docs describe their behaviour and intent. If a detail
here disagrees with the box, the box is authoritative. Everything in the repo (the
`Dockerfile`, the CI workflow, the app) is authoritative here.

---

## Quick reference

| Thing | Value |
|---|---|
| Public URL | `https://charan-projectr.duckdns.org` |
| Elastic IP | `3.108.33.64` (registered at Fyers — never release) |
| Instance | EC2 `t3.small`, region `ap-south-1` |
| Image | `ghcr.io/charan1922/project-r-simulator:latest` |
| Container | `projectr` |
| Deploy trigger | push to `prod` branch (`main` never deploys) |
| App port (internal) | `5001` (public only via Caddy on `443`) |
