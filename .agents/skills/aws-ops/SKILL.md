---
name: aws-ops
description: Operate the AI OI Trade Finder production AWS box — power start/stop/status, deploy, pull prod DB, view logs, and fix SSH/security-group access. Includes the key facts (instance id, Elastic IP, container, image) and the Windows AWS-CLI PATH gotcha. Use for any routine production/AWS operation on this project.
allowed-tools: Bash, PowerShell, Read, Edit, Write
---

Operate the self-hosted AWS EC2 box that runs AI OI Trade Finder in production.
Full background/runbook lives in `docs/aws-deployment/`; this skill is the fast
operational reference for things done frequently.

## Key facts (confirmed 2026-07-17)

| Thing | Value |
|---|---|
| EC2 instance id | `i-02e0d28ea7590b26d` |
| Type / region | `t3.small` / `ap-south-1` (Mumbai) |
| Elastic IP | `3.108.33.64` — permanent, whitelisted at Fyers. **Never release it.** |
| Public URL | `https://charan-projectr.duckdns.org` (Caddy → app :5001; TLS via DuckDNS + Let's Encrypt) |
| Docker container | `projectr` |
| Image (hardcoded) | `ghcr.io/charan1922/project-r-simulator:latest` — name is fixed in CI, **independent of the GitHub repo name** (repo was renamed to `AI-OI-Trade-Finder`; image name unchanged so deploys keep working) |
| On-box dir | `/opt/projectr/` — `auto-deploy.sh` (cron every ~10 min), `checkopen.js` (open-position guard), `deploy.log` |
| SSH | `ubuntu@3.108.33.64`, key `~/.ssh/projectr-throwaway.pem` (port 22 is IP-allowlisted) |

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

Configured identity: IAM user `cli-user` (account `328646895866`), region `ap-south-1`.
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
aws ec2 describe-instances --region ap-south-1 --instance-ids i-02e0d28ea7590b26d \
  --query "Reservations[].Instances[].State.Name" --output text
aws ec2 start-instances --region ap-south-1 --instance-ids i-02e0d28ea7590b26d
aws ec2 stop-instances  --region ap-south-1 --instance-ids i-02e0d28ea7590b26d
```
Check a permission without acting: append `--dry-run` (success shows
`DryRunOperation ... Request would have succeeded`; `--dry-run` always exits non-zero).

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

Port 22 is locked to a source IP. When SSH times out, the laptop's public IP changed.
Find the current IP and add it to the security group (needs `ec2:AuthorizeSecurityGroupIngress`):
```
# current public IP:
curl -s https://checkip.amazonaws.com
# find the instance's security group id:
aws ec2 describe-instances --region ap-south-1 --instance-ids i-02e0d28ea7590b26d \
  --query "Reservations[].Instances[].SecurityGroups[].GroupId" --output text
# authorize SSH from the current IP (replace sg-xxxx and the IP):
aws ec2 authorize-security-group-ingress --region ap-south-1 --group-id sg-xxxx \
  --protocol tcp --port 22 --cidr <MY_IP>/32
```
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
