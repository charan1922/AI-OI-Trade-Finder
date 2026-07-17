# 04 — Building and shipping the app

[← Getting a secure website](03-getting-a-secure-website.md) · Next: [Settings and secrets →](05-settings-and-secrets.md)

---

How a code change becomes the running app on the box, end to end. Four moving parts:
the **image**, the **registry**, **CI**, and the **auto-deploy cron**.

```
edit code → push origin :prod → Actions builds image → ghcr.io:latest
                                                              │
                    box cron (10m) sees new digest → no trade open? → pull + restart
```

## 1. The image (Dockerfile)

`Dockerfile` at the repo root, on `node:24-bookworm-slim`. Deliberately **single-stage**:

- The app needs the full dependency tree at runtime, not just prod deps — the native
  modules (`better-sqlite3`, `@duckdb/node-api`) and the Prisma CLI (used by the start
  command). We avoided `output: standalone` because it can fail to trace those native
  modules (kept external via `serverExternalPackages`) and the runtime `fs` reads of
  `lib/data/*.json`.
- Build steps: `pnpm install --frozen-lockfile` → `prisma generate` → `pnpm build`.
- `pnpm-workspace.yaml` holds the `allowBuilds` allowlist so the native packages may
  run their build scripts (pnpm 10 blocks them by default).
- **The image contains no secrets and no DB** (`.dockerignore`). Both are supplied at
  runtime — see [05](05-settings-and-secrets.md).

**Container start command**, in order:
1. **DB import hook** — if `/app/data/project-r.db.import` exists on the volume, swap it
   into place before anything opens the DB (this is how a migrated DB is shipped).
2. **`prisma db push` only on a fresh volume** (no `project-r.db` yet). On an existing
   DB it's skipped — the app owns six raw-SQL runtime tables not in `schema.prisma`
   (`bhavcopy_*_expiry`, `market_holidays`, `trade_commentary`, …), and a push would
   drop them. **Never run `db push --accept-data-loss` against prod.**
3. Start Next on port 5001.

## 2. The registry (ghcr.io)

The built image is pushed to GitHub's container registry as
`ghcr.io/charan1922/project-r-simulator:latest`. The box pulls from here. Auth uses the
built-in `GITHUB_TOKEN` in Actions — nothing to configure.

## 3. CI (`.github/workflows/build-image.yml`)

- **Trigger: push to `prod` only.** `prod` → build + push `:latest`. **`main` → nothing**
  (main is integration; it never deploys). There's also a manual `workflow_dispatch`.
- **Build cache:** buildx `type=gha`. Runners start clean, so without a cache every run
  redoes `pnpm install` + `next build` (~6 min) and re-pushes the ~1 GB node_modules
  layer. With it, unchanged layers restore and only changed blobs push — a source-only
  change is **~2 min**.
- Action majors pinned to Node-24 runtimes (`checkout@v6`, `setup-buildx@v3`,
  `login@v4`, `build-push@v7`) so there's no Node-20 deprecation warning.

## 4. Auto-deploy cron (on the box)

`/opt/projectr/auto-deploy.sh`, run by cron every ~10 minutes. Each run:

1. Compare the remote `:latest` digest to the running container's image digest. Same →
   no-op.
2. **Open-position guard:** check for an open/placing/pending trade via
   `/opt/projectr/checkopen.js` (queries `auto_trades` inside the container). **If a
   trade is open, skip** — it never restarts mid-trade. Retries on a later tick.
3. New digest + flat → `docker pull`, recreate `projectr`, health-check (login → 200),
   log to `/opt/projectr/deploy.log`.

> So a pushed fix can sit "pending" for a few minutes if a trade is open — that's the
> guard, not a failure. Confirm with `pnpm box:status` or `/logs`.

## Branch model

- `main` — integration/scratch. Push freely; nothing deploys.
- `prod` — the deploy branch. Push here (`git push origin main:prod` or a branch:prod)
  to ship.

## Why build off-box

Building is memory- and time-heavy; GitHub runners do it free. The box stays a cheap
2 GB instance because it only pulls and runs.

---

**Takeaway:** push to `prod` → Actions builds → ghcr `:latest` → box cron pulls within
10 min and restarts, but never mid-trade. `main` is safe to push without deploying.

Next: [runtime config + safety flags →](05-settings-and-secrets.md)
