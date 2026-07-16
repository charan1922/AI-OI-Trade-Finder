# Deploying Project-R to AWS — a clear, beginner-friendly plan

This is a **do-this-then-that runbook** for moving the simulator from Railway to
your own AWS server, so you get a **fixed IP address** that Fyers will accept for
real order placement (the SEBI "one app, one IP" rule).

Written for someone new to AWS. Every step says **what you do** and **why**.
Follow it top to bottom, at your own pace. I (Claude) can walk each phase with
you live and debug when something looks off.

---

## The end goal (one picture)

```
  Your code on GitHub
        │  (git push)
        ▼
  GitHub Actions  ──builds the Docker image (free)──►  ghcr.io (image store)
                                                            │  (docker pull)
                                                            ▼
                    ┌──────────────  AWS EC2 box (Ubuntu, fixed "Elastic IP")  ─────────────┐
   You / phone ──►  │  Caddy (HTTPS, your domain)  ──►  the app container (port 5001)        │
   Fyers/NSE   ◄──  │  outbound trades leave from the Elastic IP  ◄── whitelisted at Fyers   │
                    └───────────────────────────────────────────────────────────────────────┘
```

**Key idea:** GitHub builds the app; the tiny AWS box only *runs* it. So a 1 GB
server is enough, and you never build anything by hand.

---

## Before you start — read this

- **Do it on a weekend afternoon, after market close.** A half-finished
  migration must never sit between you and live trading. Railway keeps running
  untouched until the very last step, so there's always a safety net.
- **Free-plan warning (important):** the AWS *Free plan* you created **closes
  the whole account automatically at ~6 months or when the $200 credit runs
  out** — and that would delete this server *and* its fixed IP. For a real-money
  system, switch the account to the **Paid plan** (same $200 credit, no
  self-destruct, ~$11/month only after the credit is gone). Do this first.
- **You will need:** the AWS account, a **domain name** (~₹800/year from
  GoDaddy/Namecheap/Cloudflare — needed for HTTPS), your GitHub login, and the
  production secrets currently stored in Railway (Variables tab).

---

## Cost, honestly

| Item | During $200 credit | After credit runs out |
|------|--------------------|-----------------------|
| t3.micro VM (1 vCPU, 1 GB) | covered by credit | ~$7.5/mo |
| Elastic IP (the fixed IP) | covered by credit | ~$3.6/mo |
| 30 GB disk | covered by credit | ~$3/mo |
| GitHub image build + storage | free | free |
| Domain | ~₹800/year | ~₹800/year |
| **Total** | **≈ ₹0** for months | **≈ $11–14/mo (~₹1,100)** |

Railway Pro for comparison: flat $20/mo, zero server maintenance. AWS is cheaper
+ a real career skill, in exchange for you maintaining the box.

---

## Phase 0 — Lock the foundation (5 min)

1. In the AWS console, switch this account from **Free plan → Paid plan**
   (Billing → Free tier / account settings). Same credits, no 6-month
   auto-close. *Why: a trading server that self-deletes is not acceptable.*
2. Set a **billing alarm** so you're never surprised:
   Billing → **Budgets** → Create budget → Cost budget → amount **$5/month** →
   email alert at 80%. *Why: a safety net against any accidental charge.*

---

## Phase 1 — Make GitHub build the image (10 min)

The build workflow is already written: `.github/workflows/build-image.yml`.

1. Commit and push it to `main` (ask me and I'll do it, or do it yourself).
2. On GitHub → **Actions** tab → watch the **build-image** run go green.
   It publishes `ghcr.io/charan1922/project-r-simulator:latest`.
   *Why: GitHub's big machines build it for free; your small box just pulls it.*
3. Make a **Personal Access Token (PAT)** so the server can pull the private
   image: GitHub → Settings → Developer settings → **Personal access tokens
   (classic)** → Generate → tick **`read:packages`** → copy the token, save it.
   *Why: the image is private (it contains your source code); the server needs
   this token to download it. It holds no trading secrets.*

---

## Phase 2 — Create the AWS server (15 min)

AWS console → **EC2** → **Launch instance**:

- **Region** (top-right): **Asia Pacific (Mumbai) ap-south-1** — closest to the
  exchange = fastest orders.
- **Name:** `projectr`
- **OS image (AMI):** **Ubuntu Server 24.04 LTS** (64-bit x86)
- **Instance type:** **t3.micro** (1 GB) — the small/cheap one
- **Key pair:** *Create new* → name `projectr-key`, type RSA, format `.pem` →
  **Download it** and keep it safe (this is your SSH password file).
- **Network settings** → Edit → allow inbound:
  - **SSH (22)** — source *My IP* (only you can log in)
  - **HTTP (80)** — source *Anywhere* (needed for the HTTPS certificate)
  - **HTTPS (443)** — source *Anywhere* (the dashboard)
- **Storage:** change 8 GB → **30 GB gp3** (room for the DB + 20 sessions of
  candles).
- **Launch instance.**

*Why each firewall rule: 22 lets you in, 80+443 let Caddy get a free HTTPS
certificate and serve the dashboard. Everything else stays closed.*

---

## Phase 3 — Give it a permanent IP (5 min)

EC2 → **Elastic IPs** (left menu, under Network & Security):

1. **Allocate Elastic IP address** → Allocate.
2. Select it → **Actions → Associate** → choose your `projectr` instance → Associate.
3. **Copy this IP** — call it `<ELASTIC_IP>`. This is the fixed address Fyers
   will whitelist. *Why: without this, AWS gives a new IP on every restart and
   Fyers would reject you.*

---

## Phase 4 — Point your domain at it (10 min + wait)

At your domain registrar, add a **DNS "A" record**:

- Name: `@` (or `trade`, if you want `trade.yourdomain.com`)
- Value: `<ELASTIC_IP>`
- Save. DNS takes a few minutes to a couple of hours to spread.

*Why: HTTPS certificates are issued to a domain name, not a bare IP.*

---

## Phase 5 — Log into the server (10 min)

Open **Git Bash** (or PowerShell) on your PC:

```bash
# one-time: lock down the key file so SSH accepts it
chmod 400 /path/to/projectr-key.pem            # Git Bash
# (PowerShell: icacls projectr-key.pem /inheritance:r /grant:r "$env:USERNAME:R")

ssh -i /path/to/projectr-key.pem ubuntu@<ELASTIC_IP>
```

You're now inside the Linux server. *Why: everything below runs here.*

---

## Phase 6 — Install Docker (5 min)

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
newgrp docker            # apply the group now (or log out and back in)
docker --version         # confirm it works
```

*Why: Docker is what runs your app image.*

---

## Phase 7 — Put the secrets + data on the box

**7a. Make the folders:**
```bash
sudo mkdir -p /opt/projectr/data
sudo chown -R ubuntu:ubuntu /opt/projectr
```

**7b. Create the secrets file** (`nano /opt/projectr/.env`, paste the template
at the bottom of this doc, fill every value from Railway → Variables), then:
```bash
chmod 600 /opt/projectr/.env      # only you can read it
```

**7c. Copy the database from your PC** (run on your PC, not the server):
```bash
# get the freshest data first
pnpm db:pull-prod:full
# flatten the write-ahead log so a single file is consistent
sqlite3 data/project-r.db "PRAGMA wal_checkpoint(TRUNCATE);"
# upload just the .db file
scp -i /path/to/projectr-key.pem data/project-r.db ubuntu@<ELASTIC_IP>:/opt/projectr/data/project-r.db
```

*Why: this carries over your trade history + 20 sessions of candles. Tokens
regenerate themselves via TOTP, so you don't copy those.*

---

## Phase 8 — Run the app (5 min, on the server)

```bash
# log in to the image store with your PAT from Phase 1
echo <YOUR_PAT> | docker login ghcr.io -u charan1922 --password-stdin

docker pull ghcr.io/charan1922/project-r-simulator:latest

docker run -d --name projectr --restart unless-stopped \
  --env-file /opt/projectr/.env \
  -v /opt/projectr/data:/app/data \
  -p 127.0.0.1:5001:5001 \
  ghcr.io/charan1922/project-r-simulator:latest

docker logs -f projectr        # watch it boot; Ctrl-C to stop watching
```

You should see the Fyers poller + fast-guard start lines. *Why `127.0.0.1`:
the app is only reachable locally; the public reaches it through Caddy (next),
so the login page is always behind HTTPS.* `--restart unless-stopped` means it
comes back automatically after a crash or reboot.

---

## Phase 9 — HTTPS with Caddy (10 min, on the server)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Edit `/etc/caddy/Caddyfile` (`sudo nano /etc/caddy/Caddyfile`) to just:
```
yourdomain.com {
    reverse_proxy 127.0.0.1:5001
}
```
Then:
```bash
sudo systemctl restart caddy
```

Caddy automatically fetches a free HTTPS certificate. Open
`https://yourdomain.com` — the dashboard should load, secure. *Why: real HTTPS
means Google login works and your password isn't sent in the clear.*

---

## Phase 10 — Point the app + Google at the new address

In `/opt/projectr/.env` set:
- `AUTH_URL=https://yourdomain.com`
- `AUTO_TRADE_LIVE_ENABLED=true` (only when you're ready for live; leave unset for approval mode)
- **Do NOT set** `FYERS_POLLER_DISABLED` here — this box SHOULD poll.

In **Google Cloud Console** → your OAuth client → Authorized redirect URIs, add:
`https://yourdomain.com/api/auth/callback/google`

Restart the container after editing `.env`:
```bash
docker rm -f projectr && docker run -d --name projectr --restart unless-stopped \
  --env-file /opt/projectr/.env -v /opt/projectr/data:/app/data \
  -p 127.0.0.1:5001:5001 ghcr.io/charan1922/project-r-simulator:latest
```

---

## Phase 11 — Whitelist the IP at Fyers + activate (after market close)

Fyers API dashboard → your Algo Trading App:
- **Static IP → Primary:** `<ELASTIC_IP>`
- **Permissions:** tick **All** (Order Placement + Transaction + Profile + Quotes
  + Historical — the data feed needs the last two).
- Accept terms → **Activate.**

*Why: this is the whole reason for the move — Fyers only accepts orders from
this one fixed IP.*

---

## Phase 12 — Stop Railway from fighting (cutover)

Two servers polling the same Fyers account collide (we learned this the hard
way). So when AWS goes live, silence Railway's poller:

- Railway → Variables → set **`FYERS_POLLER_DISABLED=true`** → redeploy.
  (Keep Railway alive as a warm standby for a few days.)
- Once AWS has run clean for a few days: `pnpm server:down` to stop paying for
  Railway.

---

## Phase 13 — Prove it works (the safe tests)

On `https://yourdomain.com/auto-trade`:

1. **"Test broker order (₹0)"** button — places one unfillable ₹1 limit and
   cancels it. If it says PASS, Fyers is accepting your orders from this IP. ✅
2. Then the **real round-trip** (buy 1 lot + sell immediately, ~₹100–300 spread
   cost) — proves fills work end to end. I'll run this with you watching the
   Fyers app.
3. If both pass → **live mode works with no approval clicks.**

---

## Everyday maintenance (the part Railway used to hide)

- **Update to a new app version:** after you push code (GitHub rebuilds the
  image), on the server:
  ```bash
  docker pull ghcr.io/charan1922/project-r-simulator:latest
  docker rm -f projectr && docker run -d --name projectr --restart unless-stopped \
    --env-file /opt/projectr/.env -v /opt/projectr/data:/app/data \
    -p 127.0.0.1:5001:5001 ghcr.io/charan1922/project-r-simulator:latest
  ```
  (I can turn this into a one-line `update.sh` script for you.)
- **OS security updates (monthly):** `sudo apt update && sudo apt upgrade -y`
- **Check it's alive:** `docker ps` and `docker logs --tail 50 projectr`
- **Reboots:** the container auto-starts (`--restart unless-stopped`).

## If anything breaks — instant rollback

Railway still has everything. Re-enable its poller (unset
`FYERS_POLLER_DISABLED`, `pnpm server:up`) and you're back on the old setup in
minutes. Do the AWS cutover only once the ₹0 + round-trip tests pass.

---

## The `.env` template (fill from Railway → Variables)

```dotenv
# ── App gate ──
APP_PASSWORD=            # copy from Railway
APP_READONLY_PASSWORD=   # copy from Railway
AUTH_SECRET=             # copy from Railway
AUTH_GOOGLE_ID=          # copy from Railway
AUTH_GOOGLE_SECRET=      # copy from Railway
AUTH_URL=https://yourdomain.com          # CHANGE to your domain
GOOGLE_VIEWER_EMAILS=    # copy from Railway (or blank)

# ── Fyers (broker + data) ──
FYERS_ID=
FYERS_APP_ID=
FYERS_SECRET_KEY=
FYERS_TOTP_SECRET=
FYERS_PIN=
FYERS_REDIRECT_URI=http://127.0.0.1:5001   # keep as-is (never actually visited)
# FYERS_POLLER_DISABLED  ← leave UNSET here (this box should poll)

# ── Dhan (second broker / quotes) ──
DHAN_CLIENT_ID=
DHAN_ACCESS_TOKEN=
DHAN_PIN=
DHAN_TOTP_SECRET=

# ── Auto-trade live switch ──
AUTO_TRADE_LIVE_ENABLED=false    # set true only when you want autonomous live
AUTO_TRADE_ALERT_WEBHOOK=        # optional

# ── AI ──
MIMO_API_KEY=
MIMO_BASE_URL=
MIMO_MODEL=
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_INSTANCE_NAME=
AZURE_OPENAI_CHAT_DEPLOYMENT=
AZURE_OPENAI_API_VERSION=
AI_GATEWAY_API_KEY=              # optional

# ── Telegram ──
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_VIEWER_CHAT_IDS=        # optional
TELEGRAM_WEBHOOK_SECRET=

# ── Misc ──
NEXT_PUBLIC_SENTRY_DSN=          # optional
NODE_ENV=production
```

> Copy the **exact values** from Railway → your service → **Variables**. The only
> lines you change for AWS are `AUTH_URL` (your domain) and, when ready,
> `AUTO_TRADE_LIVE_ENABLED=true`. Leave `FYERS_POLLER_DISABLED` unset here.

---

## Quick checklist

- [ ] Phase 0: account on **Paid plan** + $5 billing alarm
- [ ] Phase 1: GitHub Action green + PAT saved
- [ ] Phase 2: t3.micro launched (Mumbai), 30 GB, ports 22/80/443
- [ ] Phase 3: Elastic IP allocated + associated → `<ELASTIC_IP>`
- [ ] Phase 4: domain A-record → `<ELASTIC_IP>`
- [ ] Phase 5–6: SSH in, Docker installed
- [ ] Phase 7: `.env` filled, DB uploaded
- [ ] Phase 8: container running (`docker ps`)
- [ ] Phase 9: `https://yourdomain.com` loads secure
- [ ] Phase 10: AUTH_URL + Google redirect updated
- [ ] Phase 11: Elastic IP whitelisted + Fyers app activated
- [ ] Phase 12: Railway poller disabled
- [ ] Phase 13: ₹0 test PASS → round-trip PASS → live
