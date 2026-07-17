# 08 — Everyday commands

[← Saving money](07-saving-money-auto-onoff.md) · Next: [Brokers and safety →](09-brokers-and-safety.md)

---

The things you'll actually run, and the two ways in (browser / SSH).

## Power control (from the laptop)

Requires the **AWS CLI** configured (`aws configure`, region `ap-south-1`) with
start/stop permission on the instance. The scripts resolve the instance by its Elastic
IP, so there's no instance ID to remember.

```bash
pnpm box:status     # instance power state + app HTTPS health
pnpm box:start      # aws ec2 start-instances (only the control plane can wake a stopped box)
pnpm box:stop       # aws ec2 stop-instances — blunt lever; requires --force
```

`box:stop` is **not** position-guarded (unlike the auto-stop cron) — it's a manual
override. Run it only when you know you're flat, or pass `--force`.

## Pull prod data to local (HTTPS, no SSH)

```bash
pnpm db:pull-prod         # curated subset (~20 MB): /live + scanner tables
pnpm db:pull-prod:full    # full clone: all tables + indexes/triggers/views
```

The box builds the copy in-process from its live DB (ATTACHed **read-only** — never
writes prod) via `POST /api/db-explorer/dump` (admin, HTTP Basic with `APP_PASSWORD`),
and streams it back. It goes over **443**, so it works whenever the box is up,
regardless of your laptop's IP — unlike the old SSH transport, which broke on IP change
and while the box slept.

## Logs

- **`/logs`** — the raw server console, live-tailing, survives restarts. Admin-only.
  Backed by `data/logs/app-<date>.log`.
- On the box directly: `sudo docker logs -f projectr`, or tail
  `/opt/projectr/deploy.log` for deploy history.

## Deploy a change

```bash
git push origin main:prod    # or <branch>:prod — triggers CI → :latest
```

The box's cron pulls it within ~10 min and restarts — unless a trade is open, in which
case it waits for a later tick (see [04](04-building-and-shipping-the-app.md)). Watch
it land via `pnpm box:status` or `/logs`.

## Getting in

- **Browser:** Google sign-in is the norm. The password form is hidden but still live
  at `/login?password=1` — the operator's break-glass path if Google is misconfigured.
- **SSH:** `ssh -i <key.pem> ubuntu@3.108.33.64`. If it times out, your public IP
  changed — add it to the security group's port-22 inbound rule (AWS console → EC2 →
  Security Groups).

## Quick "is it healthy?" checklist

1. `pnpm box:status` → instance `running` + app `HTTP 200`.
2. Open `/logs` → poller cycles ticking every ~5 min.
3. `/fyers` and `/dhan` → token chips green (or check `lastWarmup`).

---

**Takeaway:** `box:*` for power (needs AWS CLI), `db:pull-prod` for data (over HTTPS),
`/logs` for live output, `git push …:prod` to deploy. Break-glass login at
`/login?password=1`.

Next: [broker setup + the safety nets →](09-brokers-and-safety.md)
