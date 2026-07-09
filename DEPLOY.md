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
- **`DHAN_*`** (optional, legacy): `DHAN_ACCESS_TOKEN`, `DHAN_PIN`,
  `DHAN_TOTP_SECRET`.
- **`DATABASE_URL`** set to the absolute volume path (not your local value):

  ```
  DATABASE_URL=file:/app/data/project-r.db
  ```

  The runtime always uses `/app/data/project-r.db`; this makes the Prisma CLI's
  `db push` target the same file — no ambiguity.

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

## Market-hours sleep (cost saver)

The service only needs to run during Indian market hours (~09:15–15:30 IST,
weekdays). Sleeping it nights/weekends cuts runtime ~70%. Two pieces:

1. **Railway Serverless (app sleeping)** — service Settings → filter for
   `serverless` / `sleep` → enable. The service now sleeps when idle (no billing
   while asleep) and wakes on the next request (~seconds cold start).
2. **Keep-alive ping** (`.github/workflows/keep-awake.yml`) — a GitHub Actions
   cron pings `/api/health` every 5 min, 08:30–16:25 IST Mon–Fri, keeping the
   service awake during market hours so the poller records. Outside those hours
   nothing pings it → it sleeps.

`/api/health` is the one route the password gate leaves public (so the pinger
can wake the app without the password); it leaks nothing sensitive.

A brief nap is harmless: the poller refetches the full day each cycle, so a
missed tick self-heals on the next wake.

### To DISABLE market-hours sleep (run 24/7 again)

Do **either** (either one alone is enough; do both to fully revert):

- **Turn OFF Railway Serverless** — service Settings → the Serverless/App
  Sleeping toggle → off. The service stays up 24/7 regardless of the pinger.
- **Disable the keep-alive workflow** — GitHub repo → **Actions** tab →
  *keep-awake* → **⋯ → Disable workflow**. (Or delete
  `.github/workflows/keep-awake.yml` and push.)

If you leave Serverless ON but disable the pinger, the app will sleep during
market hours too whenever no one has the dashboard open — so the poller would
stop recording. So: **Serverless ON requires the pinger ON.**

## Cost levers (later)

- **Trim resident memory** — slim the poller universe.

## Notes

- `PORT=5001` is pinned as a service variable; the start command binds to it
  (`next start -p $PORT`) and the domain target port matches it.
- `next.config.ts` externalises the native modules — do not change that.
- The build needs no secrets; every env var is optional at build time.
