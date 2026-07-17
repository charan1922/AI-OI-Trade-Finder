---
name: aws-ops
description: Operate the AI OI Trade Finder production AWS box — power start/stop/status, the automatic 08:15 start / 16:30 stop scheduler, deploy, pull prod DB, view logs, and fix SSH/security-group access. Includes the key facts (instance id, Elastic IP, security group, IAM role, container, image) and the Windows AWS-CLI PATH gotcha. Use for any routine production/AWS operation on this project.
allowed-tools: Bash, PowerShell, Read, Edit, Write
---

Operate the self-hosted AWS EC2 box that runs AI OI Trade Finder in production.
Full background/runbook lives in `docs/aws-deployment/`; this skill is the fast
operational reference for things done frequently.

> **This repo is PUBLIC.** So `$BOX_INSTANCE_ID`, `$BOX_SG_ID` and `$AWS_ACCOUNT_ID`
> below are placeholders — the real values live in the gitignored
> `.agents/skills/aws-ops/box-ids.local.md` (read it before running the commands, or
> re-derive them with the snippets in that file). Never paste real IDs, keys, or
> passwords back into this file or any committed doc.

## Key facts (confirmed 2026-07-17)

| Thing | Value |
|---|---|
| EC2 instance id | `$BOX_INSTANCE_ID` |
| Type / region | `t3.small` / `ap-south-1` (Mumbai) |
| Elastic IP | `3.108.33.64` — permanent, whitelisted at Fyers. **Never release it.** |
| Public URL | `https://charan-projectr.duckdns.org` (Caddy → app :5001; TLS via DuckDNS + Let's Encrypt) |
| Docker container | `projectr` |
| Image (hardcoded) | `ghcr.io/charan1922/project-r-simulator:latest` — name is fixed in CI, **independent of the GitHub repo name** (repo was renamed to `AI-OI-Trade-Finder`; image name unchanged so deploys keep working) |
| On-box dir | `/opt/projectr/` — `auto-deploy.sh` (root cron `*/10`), `autostop.sh` (root cron `5,15,25,35,45,55`), `checkopen.js` (open-position guard), `checkshutdown.js` (AUTO_SHUTDOWN toggle reader), `deploy.log`, `autostop.log` |
| SSH | `ubuntu@3.108.33.64`, key `~/.ssh/projectr-throwaway.pem` (port 22 is IP-allowlisted). `sudo` is passwordless. |
| Security group | `$BOX_SG_ID` (the port-22 allowlist lives here) |
| Scheduler IAM role | `ProjectR-BoxScheduler` — least-privilege: `ec2:StartInstances` on this one instance only |
| Start schedule | EventBridge `projectr-start-box-weekday-0815-ist` (region `ap-south-1`) |
| Shutdown behavior | `stop` (verified) — so `shutdown -h now` STOPS the box, never terminates it |

## AWS CLI on this Windows machine (PATH gotcha)

The CLI is a **user-scoped install**: `%LOCALAPPDATA%\Programs\Amazon\AWSCLIV2\aws.exe`
(e.g. `C:\Users\charan.chatakondu\AppData\Local\Programs\Amazon\AWSCLIV2\aws.exe`).
It **is** on the User PATH, but tool shells / terminals opened before the install
have a stale PATH and report `aws: command not found`. Don't reinstall.

- In a **tool call**, invoke aws by **full path** (PATH there is often stale):
  ```powershell
  & "$env:LOCALAPPDATA\Programs\Amazon\AWSCLIV2\aws.exe" sts get-caller-identity
  ```
- `pnpm box:*` already handles this — `scripts/box.mjs` resolves the aws binary
  from `%LOCALAPPDATA%`/Program Files, so it works even with a stale PATH.
- For the user: a terminal launched from a **freshly restarted** app (VS Code, etc.)
  or after re-login will have `aws` on PATH.

Configured identity: IAM user `cli-user` (account `$AWS_ACCOUNT_ID`), region `ap-south-1`.
It has EC2 start/stop + describe. (Re-check other perms with `--dry-run` before relying on them.)

## Power control

Preferred (handles the PATH gotcha, position-safe wording):
```bash
pnpm box:status     # instance power state + app HTTPS health
pnpm box:start      # start the instance (only the control plane can wake a stopped box)
pnpm box:stop       # stop it — NOT position-guarded; requires --force
```
Raw equivalents (full-path aws in a tool call), region always `ap-south-1`:
```
aws ec2 describe-instances --region ap-south-1 --instance-ids $BOX_INSTANCE_ID \
  --query "Reservations[].Instances[].State.Name" --output text
aws ec2 start-instances --region ap-south-1 --instance-ids $BOX_INSTANCE_ID
aws ec2 stop-instances  --region ap-south-1 --instance-ids $BOX_INSTANCE_ID
```
Check a permission without acting: append `--dry-run` (success shows
`DryRunOperation ... Request would have succeeded`; `--dry-run` always exits non-zero).

## Automatic power on/off (built + verified 2026-07-17)

Master switch: the **`AUTO_SHUTDOWN`** feature toggle on `/config` (default **OFF** =
box stays up 24×7). A stopped box can't start itself, so the feature is two halves:

**START — AWS EventBridge Scheduler** (external; the only thing that can wake a stopped box)
- Schedule `projectr-start-box-weekday-0815-ist`: `cron(15 8 ? * MON-FRI *)`, TZ
  `Asia/Kolkata`, flexible-window OFF, target `arn:aws:scheduler:::aws-sdk:ec2:startInstances`,
  input `{"InstanceIds":["$BOX_INSTANCE_ID"]}`, role `ProjectR-BoxScheduler`.
- **The start half ignores AUTO_SHUTDOWN** — it starts the box every weekday morning
  regardless (starting an already-running box is a harmless no-op). Only the stop half
  is toggle-gated. To stop the morning starts entirely: disable the schedule.
```
aws scheduler get-schedule --region ap-south-1 --name projectr-start-box-weekday-0815-ist
aws scheduler update-schedule --region ap-south-1 --name projectr-start-box-weekday-0815-ist --state DISABLED  # (needs all params; easier in console)
```

**STOP — `/opt/projectr/autostop.sh`** (root cron at `5,15,25,35,45,55`, offset from auto-deploy)
Powers off only when ALL hold:
1. `AUTO_SHUTDOWN` toggle is ON (read from the app DB via `checkshutdown.js`; **fail-safe
   "0"** on any error/missing row → never stops unexpectedly),
2. no auto-trade `open`/`placing`/`pending_approval` (reuses `checkopen.js`),
3. in-window: weekday **≥ 16:30 IST**, or any time at the weekend.

**Why 16:30:** after the 15:12 square-off AND after the 16:00 EOD scorecard (which grades
*today's* picks, so it can't move to the morning). Don't move the stop earlier.

**Why overnight jobs still work:** the 01:00 bhavcopy sync is skipped while asleep, but
its "ran today" marker is in-memory and the sync backfills a weekday window — so the
08:15 startup re-runs it (~08:16), well before the 09:15 open. Token warm-up
(08:40–09:15) is inside the on-window.

Debug the stop half (safe — the guards prevent an unwanted power-off):
```bash
ssh ... 'TZ=Asia/Kolkata date "+%u %H%M"; \
  sudo docker exec projectr node /tmp/checkshutdown.js;  # 1=toggle on
  sudo docker exec projectr node /tmp/checkopen.js;      # 0=flat
  sudo /opt/projectr/autostop.sh; tail -5 /opt/projectr/autostop.log'
```
Source of truth for both scripts: `deploy/box/` in the repo (installed to `/opt/projectr/`).
They are CommonJS/bash run by the container's node + cron — `eslint.config.mjs` ignores
`deploy/box/**` on purpose; don't "fix" them into ESM.

## Deploy a change

CI/CD builds only on a push to the **`prod`** branch; `main` never deploys.
```bash
git push origin main:prod      # → GitHub Actions builds ghcr :latest → box cron pulls within ~10 min
```
The box cron (`/opt/projectr/auto-deploy.sh`) **skips the restart while a trade is
open** (position guard), so a fix can sit "pending" for a few minutes — that's normal.

Verify the deploy landed (no SSH needed):
```bash
# brand/version signal on the public login page:
curl -s https://charan-projectr.duckdns.org/login | grep -o "AI OI Trade Finder"
# a specific new endpoint responding (example): dump endpoint POST → 200 not 405
```

## Pull prod DB to local (over HTTPS — no SSH)

```bash
pnpm db:pull-prod        # curated subset (~20 MB)
pnpm db:pull-prod:full   # full clone
```
Hits `POST /api/db-explorer/dump` on the box (admin via HTTP Basic with `APP_PASSWORD`
from `.env.local`); the box builds the copy from its live DB ATTACHed **read-only** and
streams it. Never writes prod. Works whenever the box is up, regardless of laptop IP.

## Logs

- Live console: the `/logs` page (raw server output, survives redeploys).
- On the box: `sudo docker logs -f projectr`; deploy history in `/opt/projectr/deploy.log`.

## SSH access + the IP-allowlist fix

Port 22 is locked to a source IP. When SSH **times out** (not "refused"), the laptop's
public IP changed — this recurs on ISP IP changes. `cli-user` HAS
`ec2:AuthorizeSecurityGroupIngress`, so fix it directly (SG is `$BOX_SG_ID`):
```
curl -s https://checkip.amazonaws.com          # current public IP
aws ec2 authorize-security-group-ingress --region ap-south-1 \
  --group-id $BOX_SG_ID --protocol tcp --port 22 --cidr <MY_IP>/32
```
`"Return": true` = added. "Duplicate" error = already allowed (look elsewhere). Old
stale rules accumulate; list them with
`aws ec2 describe-security-group-rules --region ap-south-1 --filters Name=group-id,Values=$BOX_SG_ID`.
Note the auto on/off does NOT depend on SSH — only hands-on box work does.
`ssh -i "$USERPROFILE/.ssh/projectr-throwaway.pem" -o StrictHostKeyChecking=accept-new ubuntu@3.108.33.64 "<cmd>"`

## Safety rules (do not violate)

- **Never release/disassociate the Elastic IP** `3.108.33.64` — it's the Fyers-whitelisted algo IP.
- **Never `prisma db push --accept-data-loss`** against prod — six raw-SQL runtime
  tables (`bhavcopy_*_expiry`, `market_holidays`, `trade_commentary`, `auto_trades`, …)
  aren't in `schema.prisma` and would be dropped.
- Deploys restart the container (~30s) — the cron already guards against restarting
  mid-trade; when deploying manually mid-market-hours, expect a brief poller gap.
- Live orders need the two-key rule (env `AUTO_TRADE_LIVE_ENABLED=true` + `live` mode).

## Pointers

- `docs/aws-deployment/` — full runbook (10 files): why AWS, the box, HTTPS, CI/CD,
  headless jobs, power-off design, ops, brokers.
- `scripts/box.mjs` — the `box:*` power scripts.
- `scripts/db-pull-prod.mjs` + `app/api/db-explorer/dump/route.ts` — the HTTPS DB pull.
- `.github/workflows/build-image.yml` — the prod-only CI build.
