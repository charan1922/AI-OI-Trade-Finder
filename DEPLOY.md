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

### 2. Add the persistent volume  ← do this before trusting any data

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
- **`APP_PASSWORD`** — the one-password gate (and the auth the in-process
  capture uses for its internal API calls). Required for the deployed app.
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

The one-password gate (`proxy.ts`) protects every page and API route with HTTP
Basic Auth, but it is **only active when `APP_PASSWORD` is set**. Before you
click **Generate Domain**:

1. Add a service variable `APP_PASSWORD=<a strong password>`.
2. Redeploy (saving the variable does this).
3. Generate the public domain, and set the **target port to `5001`** (see the
   port note below). Visiting the URL prompts for the password (any username;
   only the password is checked).

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
  5-min **equity + futures candles + futures OI** for the whole tracked universe,
  every 5 min during market hours (`instrumentation.ts` → `lib/fyers/poller.ts`).
  This is the persistent candle history `/trade-suggest` and `/fyers` rely on.
- **On-request (needs the page open, OR a scheduled poll, OR a `/trade-suggest`
  run):** the live NSE movers feeds (`/live`, `/nse/movers`), the intraday **OI
  urgency** series (`oi_intraday`, written by `/api/live/quote`), and
  `/trade-suggest` picks. These are fetched live and only *persisted* when
  something calls the endpoint — nobody watching means the movers feeds aren't
  archived and the urgency series isn't filled (beyond the poller's futures OI).

So: candles record hands-off; the urgency/movers/picks capture needs a trigger.
The `/loop 5m /trade-suggest` (run from Claude Code on your machine) is one such
trigger. For fully machine-independent capture, a Railway-side cron hitting
`/api/trade-suggest` every 5 min during the up-window would do it (not set up by
default — ask if you want it).

## EOD data sync (bhavcopy)

`POST /api/bhavcopy` syncs NSE EOD bhavcopy (the R-Factor 20-day baselines). It
only fetches dates it doesn't already have, so it's cheap. EOD data for a day is
published in the evening — so the natural time to sync is the **next morning**,
which falls inside the autoscale up-window: a cron that `POST`s `/api/bhavcopy`
(with the `APP_PASSWORD` header) shortly after the 08:15 IST scale-up would keep
baselines fresh at **no extra cost** (the service is already up then). Not wired
by default — ask to add it (needs `APP_PASSWORD` as a second GitHub secret).

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
