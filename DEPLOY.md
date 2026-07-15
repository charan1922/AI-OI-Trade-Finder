# Deploying to Railway

The whole app — Next.js UI, API routes, SQLite, the Fyers poller — runs as a
**single always-on Railway service** with a persistent volume. No Vercel, no
code changes. This is the right shape for a single-user, always-on recorder.

## One-time setup

### 1. Deploy the code

From this directory (`Project-R-simulator`):

```bash
railway up
```

First run signs you in (opens your browser) and creates the project + service,
then builds the `Dockerfile` and deploys. The first build takes a few minutes
(native modules compile).

### 2. Add the persistent volume ← do this before trusting any data

Railway dashboard → the service → **Settings → Add Volume** → mount path:

```
/app/data
```

This holds `project-r.db`, the parquet store, and the `.fyers-token` /
`.dhan-token` caches, so they survive restarts and redeploys. Without it, every
redeploy starts with an empty database.

> Volumes mount at **runtime**, not build. The start command runs
> `prisma db push` against the mounted volume to create/upgrade the schema, so a
> fresh volume self-initialises on first boot.

### 3. Set environment variables

Dashboard → the service → **Variables → Raw Editor** → paste the vars below.

**Do NOT add the OpenAI / Azure keys to Railway** (user directive). That means
the Trade Assistant chatbot is disabled on Railway; everything else runs. So
**omit** all of: `AZURE_OPENAI_*`, `AZURE_PROJECT_ENDPOINT`, `AI_GATEWAY_API_KEY`
(and `API_KEY` / `API_SECRET` if those are AI keys).

Add these (copy the values from your local `.env.local`):

- The six **`FYERS_*`** vars — the poller needs all six.
  `FYERS_ID`, `FYERS_APP_ID`, `FYERS_SECRET_KEY`, `FYERS_TOTP_SECRET`,
  `FYERS_PIN`, `FYERS_REDIRECT_URI`.
  ⚠️ **`FYERS_REDIRECT_URI` must stay exactly as registered in your Fyers app** —
  it is validated against the Fyers app registration, not the Railway URL.
- **`DHAN_*`** — for live equity/futures quotes + option chain (heatmap live
  path, live/quote). TOTP auto-generation needs **all three** of
  `DHAN_CLIENT_ID` + `DHAN_PIN` + `DHAN_TOTP_SECRET` (⚠️ `DHAN_CLIENT_ID` is
  required — without it the app reports "No Dhan credentials configured" and
  falls back to the static, soon-expired `DHAN_ACCESS_TOKEN`). Add
  `DHAN_ACCESS_TOKEN` too as a static fallback.
- **`APP_PASSWORD`** — the password gate (and the auth the in-process
  capture uses for its internal API calls). Required for the deployed app.
  Grants the **admin** role (full access).
- **`APP_READONLY_PASSWORD`** _(optional)_ — a second password granting the
  **viewer** role: every page and read API works, but any state-changing /
  paid / download action returns 403 and its UI control is disabled. Policy
  lives in `lib/auth/rbac.ts`; only meaningful alongside `APP_PASSWORD`.
- **Google sign-in** _(optional)_ — `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`,
  `AUTH_SECRET`, and the public `AUTH_URL`. `GOOGLE_VIEWER_EMAILS` is an
  explicit comma-separated viewer allowlist; an otherwise valid Google account
  is denied. The operator allowlist lives in `lib/auth/rbac.ts`. Register
  `<AUTH_URL>/api/auth/callback/google` in the Google OAuth client.
- **`PORT=5001`** — see the port note below.
- **`DATABASE_URL`** set to the absolute volume path (not your local value):

  ```
  DATABASE_URL=file:/app/data/project-r.db
  ```

  The runtime always uses `/app/data/project-r.db`; this makes the Prisma CLI's
  `db push` target the same file — no ambiguity.

> Tip: if your `.env.local` starts with a UTF-8 BOM, the first var's name gets a
> hidden `﻿` prefix — paste values carefully or the first key won't match.

### 4. Redeploy so the volume + vars take effect

```bash
railway up
```

### 5. Verify

```bash
railway logs --lines 100
```

Look for `[FyersPoller] started …`. During market hours a cycle logs
`cycle #N … N symbols`. Outside market hours it logs a skip — that's correct.

### 6. Seed the data (first boot only)

A fresh volume starts empty. Open the app and run the sync pages
(master contracts, bhavcopy) exactly as you would locally, then let the poller
accumulate candles during market hours.

### 7. Expose it — **only after setting the password**

The auth gate (`proxy.ts`) protects every page and API route, but it is **only
active when `APP_PASSWORD` is set**. Browsers sign in at the `/login` page (a
signed session cookie, with a Sign-out button in the header); the internal
server-to-self calls still use HTTP Basic Auth. Before you click **Generate
Domain**:

1. Add a service variable `APP_PASSWORD=<a strong password>`.
2. Optionally add `APP_READONLY_PASSWORD=<a different password>` for read-only
   guests (see the variable list above).
3. Redeploy (saving the variables does this).
4. Generate the public domain, and set the **target port to `5001`** (see the
   port note below). Visiting the URL redirects to `/login`; the password
   entered there decides the role (admin or viewer). The username field is
   cosmetic — it only sets the header greeting.

Leave `APP_PASSWORD` unset for local dev — the gate is a no-op without it, so
`pnpm dev` stays password-free.

### Port: pin `PORT=5001`

Railway injects `PORT=8080` by default, but this app's start command and the
generated domain both expect **5001**. So set a service variable `PORT=5001` and
enter `5001` as the domain's target port. If they disagree you get a **502 Bad
Gateway** (Railway routing to a port nothing listens on). The start command
honours `$PORT` either way — the only requirement is that the variable, the
domain target port, and each other agree.

## Auto-deploy from GitHub (the `prod` branch)

Instead of `railway up` from your machine, connect the repo so a push deploys:

1. Railway service → **Settings → Source** → **Connect Repo** →
   `charan1922/Project-R-simulator`.
2. Set the **deploy branch to `prod`** (not `main`).
3. Now: develop on `main`, and when you want to ship, merge/push to `prod` —
   Railway builds and deploys automatically. A push to `main` does nothing, so
   day-to-day commits don't trigger a deploy.

Tags do NOT trigger Railway deploys — the `prod` branch push is the trigger;
tags are just human-readable release markers. See the release workflow below.

### Release workflow

```bash
# 1. Work on main (commits here do NOT deploy)
git add -A && git commit -m "…" && git push origin main

# 2. Ship: fast-forward prod to main and push → Railway auto-deploys prod
git checkout prod && git merge --ff-only main && git push origin prod
git checkout main

# 3. Mark the release (bump the version each time)
git tag -a v1.1.0 -m "v1.1.0 — <what changed>"
git push origin v1.1.0
```

Current release: **v1.0.0** — initial Railway deployment (Next.js + SQLite +
Fyers poller, password gate).

**Rollback:** Railway → the service → **Deployments** → pick a prior successful
deploy → **Redeploy**. The tag on each release commit tells you exactly what that
version contained.

## Market-hours autoscale (cost saver)

The service only needs to run during Indian market hours (~09:15–15:30 IST,
weekdays). `.github/workflows/market-hours.yml` scales it **up (1 replica) at
08:15 IST and down (0 replicas) at 16:10 IST, Mon–Fri** via `railway scale`, so
it runs continuously through the session and is **fully off** (no compute
billing) nights + all weekend (Fri evening → Mon morning). Deterministic, so —
unlike traffic-based sleeping — there is no cold-start churn mid-session and the
Fyers poller records reliably.

While the service is up the poller records **on its own** — no browser or local
machine needed (it boots from `instrumentation.ts`). See "What records
automatically vs. on-request" below for the exact scope.

### One-time setup: the API token

The workflow needs a Railway token to scale from CI:

1. Railway → **Account → Tokens** (<https://railway.com/account/tokens>) → create
   a token → copy it.
2. GitHub repo → **Settings → Secrets and variables → Actions → New repository
   secret** → name **`RAILWAY_API_TOKEN`**, value = the token.

The workflow lives on the **default branch (`main`)** — that's where GitHub runs
scheduled workflows from.

### Make the server up (or down) whenever you want

GitHub repo → **Actions → market-hours → Run workflow** → pick **up** or **down**.
Manual scale-up/down anytime, e.g. to use the app on a weekend or sync data in
the evening.

> GitHub cron is UTC and best-effort (can lag or, rarely, skip). The workflow
> has a backup fire for each direction; scaling up-when-up / down-when-down is a
> harmless no-op. The public URL returns 502 while scaled to 0 — that's the
> service being off, expected.

### To DISABLE autoscale (run 24/7 again)

GitHub repo → **Actions → market-hours → ⋯ → Disable workflow**, then run it once
manually as **up** so the service is on. (Or delete the workflow file and push.)

## What records automatically vs. on-request

While the service is **up**:

- **Autonomous (server-side, no browser/machine):** the Fyers poller records
  5-min **equity + futures candles + futures OI** for the full non-avoid
  universe. Each cycle also freezes the NSE candidate snapshot, refreshes the
  priority EQ candles, runs `/trade-suggest`, runs the deterministic guard and
  AI decision pass, records rank/OI snapshots, and then finishes the remaining
  Fyers recorder work. `instrumentation.ts` boots both this poller and the fast
  guard loop.
- **On-request:** pages read the resulting stores/caches and may refresh their
  own NSE presentation feeds. Opening `/live` is not required for scanning,
  trading, candle retention, or the display-only NIFTY gamma cache.

### Live-trading latency and safety invariants

- Candles are downloaded from **Fyers**. Priority EQ history is dispatched with
  bounded concurrency while one shared gate preserves at least 350 ms between
  request dispatches and applies a process-wide 429 cooldown. Do not increase
  this concurrency or spacing from anecdotal timing alone.
- The scan/AI starts after bounded refresh attempts for the frozen priority set;
  successful/attempted freshness is recorded explicitly and failed names use
  their last stored candle context. The rest of the universe continues afterward
  for replay coverage. Poller status records tick→capture, tick→scan,
  scan→decision, and tick→decision. Treat the first live-market session as the
  performance proof—do not quote an estimate as a measured SLA.
- The fast guard targets a 60-second cadence when risk-bearing orders exist.
  Scheduling, broker response time, and deploys can add drift, so the heartbeat
  reports actual duration. It is exits/reconciliation only and never creates an
  entry.
- Runtime DB leases prevent duplicate poller, engine, and fast-guard leaders
  during rolling deploy overlap. Order placement persists a broker correlation
  ID before the POST; ambiguous and partial fills remain unresolved for broker
  reconciliation and are never blindly retried.
- The NIFTY public-OI gamma balance remains visible on `/live` as an
  **experimental display-only** cache. Public OI cannot establish dealer
  positioning. It is refreshed only after this process owned the decision path,
  skipped while any order/position bears risk, and is absent from scan, AI,
  entries, exits, and replay.
- Fyers candles and rank snapshots retain the newest 20 recorded sessions. A
  local 166-symbol measurement was about 4.8 MB of candles plus 1.0 MB of ranks
  per session (roughly 117 MB for 20 sessions). Monitor production volume free
  space; local sizing is not a production measurement.

## EOD data sync (bhavcopy)

`POST /api/bhavcopy` syncs NSE EOD bhavcopy (the R-Factor 20-day baselines). It
only fetches dates it doesn't already have, so it's cheap. EOD data for a day is
published in the evening — so the natural time to sync is the **next morning**,
which falls inside the autoscale up-window: a cron that `POST`s `/api/bhavcopy`
(with the `APP_PASSWORD` header) shortly after the 08:15 IST scale-up would keep
baselines fresh at **no extra cost** (the service is already up then). Not wired
by default — ask to add it (needs `APP_PASSWORD` as a second GitHub secret).

## Telegram Bot Webhook (auto-trade alerts + commands)

The auto-trade engine can send real-time alerts (trade placed, exited, kill
switch, etc.) to a Telegram bot, and the bot can receive commands
(`/status`, `/positions`, `/kill`, `/pnl`, etc.) via a webhook.

### Environment variables

Add these to Railway → Variables (or `.env.local` for local dev):

| Variable                   | Required | Description                                                                                                                                                                                                                                                                |
| -------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`       | Yes      | Bot token from @BotFather                                                                                                                                                                                                                                                  |
| `TELEGRAM_CHAT_ID`         | Yes      | Your numeric chat id (send `/start` to @userinfobot)                                                                                                                                                                                                                       |
| `TELEGRAM_VIEWER_CHAT_IDS` | No       | Extra read-only recipients for the trade-commentary broadcasts, comma-separated numeric chat ids (each person must `/start` the bot once so Telegram allows it to message them). They receive commentary only — commands and approval prompts stay with `TELEGRAM_CHAT_ID` |
| `TELEGRAM_WEBHOOK_SECRET`  | Yes      | Arbitrary secret string — Telegram sends it back in the `X-Telegram-Bot-Api-Secret-Token` header for webhook verification                                                                                                                                                  |

> **`AUTO_TRADE_ALERT_WEBHOOK`** (the legacy one-way webhook) is still
> supported as a fallback. If the three `TELEGRAM_*` vars are set, alerts
> route through the native Telegram Bot API instead — which also enables
> the inbound command handler.

### Register the webhook

After setting the env vars and redeploying:

```bash
# Via the setup script (from the repo root):
npx tsx scripts/setup-telegram-webhook.ts
```

Or via the API endpoint (after deploy):

**Linux / macOS (bash):**

```bash
curl -X POST https://<your-railway-url>/api/telegram/setup \
  -H "Authorization: Basic $(echo -n ':YOUR_APP_PASSWORD' | base64)" \
  -H "Content-Type: application/json" \
  -d '{"action":"register"}'
```

**Windows cmd:**

```cmd
curl.exe -X POST https://<your-railway-url>/api/telegram/setup -H "Authorization: Basic <base64_of_:YOUR_APP_PASSWORD>" -H "Content-Type: application/json" -d "{\"action\":\"register\"}"
```

**Windows PowerShell (curl — use single quotes around JSON body):**

```powershell
curl.exe -X POST "https://<your-railway-url>/api/telegram/setup" `
  -H "Authorization: Basic <base64_of_:YOUR_APP_PASSWORD>" `
  -H "Content-Type: application/json" `
  -d '{"action":"register"}'
```

> ⚠️ **PowerShell + curl gotcha:** PowerShell single-quoted strings are _literal_ — `\"` does **not** escape, it sends a literal backslash. Always put JSON in single quotes `'...'` so double quotes inside pass through unchanged. Do **not** use `\"` inside single quotes.

**Windows PowerShell (recommended — Invoke-RestMethod):**

```powershell
$body = @{ action = "register" } | ConvertTo-Json
Invoke-RestMethod `
  -Uri "https://<your-railway-url>/api/telegram/setup" `
  -Method Post `
  -ContentType "application/json" `
  -Headers @{ Authorization = "Basic <base64_of_:YOUR_APP_PASSWORD>" } `
  -Body $body
```

> **Tip:** On Windows, use `certutil -encode` or an online base64 encoder to generate the `Authorization: Basic` value. The value is `base64(":YOUR_APP_PASSWORD")`.

### Testing the Telegram bot on Windows

To send a test message via curl on Windows, avoid `\"` escaping inside double-quoted strings. Use this approach:

**Windows cmd:**

```cmd
curl.exe -s "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/sendMessage" -H "Content-Type: application/json" -d "{""chat_id"":""<YOUR_CHAT_ID>"",""text"":""Test message""}"
```

**Windows PowerShell (curl — single quotes around JSON):**

```powershell
curl.exe -s "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/sendMessage" `
  -H "Content-Type: application/json" `
  -d '{"chat_id":"<YOUR_CHAT_ID>","text":"Test message"}'
```

**Windows PowerShell (recommended — Invoke-RestMethod):**

```powershell
$body = @{
    chat_id = "<YOUR_CHAT_ID>"
    text    = "Test message"
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/sendMessage" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

> **Note:** In Windows cmd, use `""` to escape double quotes inside a double-quoted string. In PowerShell, use single quotes for the outer JSON string so internal double quotes pass through as-is — or use `Invoke-RestMethod` which handles escaping automatically.

### Available bot commands

| Command      | Description                                            |
| ------------ | ------------------------------------------------------ |
| `/status`    | Engine mode, broker, kill switch, caps, open positions |
| `/positions` | Open positions with entry/SL/target                    |
| `/trades`    | Today's trade history                                  |
| `/pnl`       | Daily P&L summary                                      |
| `/decisions` | Recent AI decisions                                    |
| `/kill`      | Activate kill switch (halt new orders)                 |
| `/unkill`    | Deactivate kill switch                                 |
| `/mode`      | Check or change mode (`/mode paper`, `/mode off`)      |
| `/help`      | List all commands                                      |

### What Telegram receives

**Automatic alerts** (from the auto-trade engine):

- 🟢 Trade placed · 🔴 Trade exited · 🚨 Kill switch · 🛑 Daily loss halt
- ⚠️ Exit failures requiring manual intervention · 🚨 partial/unresolved
  broker orders · ⏰ EOD square-off

**Automatic trade commentary** (from the AI commentary engine):

- Every time `/trade-suggest` runs and generates a new commentary, it is pushed to Telegram in real-time — the same narration you see on `/trade-commentary`.

**Bot commands** (send any of these to @live_ait_bot):
`/status` `/positions` `/trades` `/pnl` `/decisions` `/kill` `/unkill` `/mode` `/help`

### Architecture

- **`lib/telegram/bot.ts`** — Telegram Bot API client (send, webhook management, secret verification)
- **`lib/telegram/handlers.ts`** — Command dispatcher (queries auto_trade DB, writes settings)
- **`app/api/telegram/webhook/route.ts`** — Unauthenticated POST endpoint (Telegram → app). Auth is via the secret token header, not the app password.
- **`app/api/telegram/setup/route.ts`** — Authenticated endpoint to register/delete the webhook
- **`scripts/setup-telegram-webhook.ts`** — CLI script for one-time webhook registration

The webhook endpoint (`/api/telegram/webhook`) is allowlisted in `proxy.ts`
as a public route (like `/api/health`), so Telegram's servers can reach it
without the app password. In production, the route fails closed when
`TELEGRAM_WEBHOOK_SECRET` is missing or the header does not match.

## Cost levers (later)

- **Trim resident memory** — slim the poller universe.

## Notes

- **Database changes / schema evolution / backups** → see **[DB.md](DB.md)**.
  Local and server DBs are independent files; after go-live the server DB is the
  source of truth — never blind-overwrite it. Back up before any schema change.
- `PORT=5001` is pinned as a service variable; the start command binds to it
  (`next start -p $PORT`) and the domain target port matches it.
- `next.config.ts` externalises the native modules — do not change that.
- The build needs no secrets; every env var is optional at build time.
