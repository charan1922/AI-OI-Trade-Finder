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

The one-password gate (`middleware.ts`) protects every page and API route with
HTTP Basic Auth, but it is **only active when `APP_PASSWORD` is set**. Before you
click **Generate Domain**:

1. Add a service variable `APP_PASSWORD=<a strong password>`.
2. Redeploy (saving the variable does this).
3. Generate the public domain. Visiting it prompts for the password (any
   username; only the password is checked).

Leave `APP_PASSWORD` unset for local dev — the gate is a no-op without it, so
`pnpm dev` stays password-free.

## Cost levers (later)

- **Sleep outside market hours** — the poller only needs to run ~09:00–15:45 IST
  on weekdays. Pausing the service nights/weekends cuts runtime ~70%.
- **Trim resident memory** — lazy-load DuckDB, slim the poller universe.

## Notes

- Railway injects `$PORT`; the start command honours it (`next start -p $PORT`).
- `next.config.ts` externalises the native modules — do not change that.
- The build needs no secrets; every env var is optional at build time.
