# Database & schema-change playbook

How the databases relate, how to evolve the schema without losing data, and how
to move data between local and the deployed server. Read this before any DB
change that touches the deployed app.

## Mental model — two independent databases

There are **two separate SQLite files**, and they do NOT sync automatically:

| | Local dev DB | Deployed (server) DB |
|---|---|---|
| Path | `data/project-r.db` (your machine) | `/app/data/project-r.db` (Railway volume) |
| Written by | `pnpm dev` on your machine | the live Railway service (poller, scans, bhavcopy) |
| Role after go-live | scratch / development | **source of truth** — holds accumulated live data |

They are files, not branches — there is **no merge / no git conflict**. The DB
is gitignored and never in a commit. What you commit is the **schema**
(`prisma/schema.prisma`) and raw-SQL `CREATE TABLE` statements in code — not data.

> ⚠️ After the server has run, it holds data your local DB does NOT (recorded
> candles, `trade_suggestions` picks + scorecards, freshly synced bhavcopy). So
> **never blind-overwrite the server DB with your local one** — you'd lose all
> of that. Migration (upload) is a one-way seed you do once, not a sync.

## Always back up the server DB before any risky change

Download the live volume DB to your machine (service must be up):

```bash
railway volume files -v <volume-id> download /project-r.db ./backup-$(date +%F).db
```

Keep that file. If anything goes wrong, you can re-upload it (see "Push local →
server" below). This is your undo button.

## Schema changes (adding a column / table to a Prisma model)

The deployed start command runs `prisma db push` **only when the DB doesn't
exist yet** (fresh volume). On an existing DB it is skipped — because `db push`
would try to DROP the app's raw-SQL tables (`backtest_*`, `bhavcopy_*_expiry`,
`market_holidays`, `feature_toggles`, `oi_intraday`, …) to match the Prisma
schema, destroying data. So a schema change does **not** auto-apply to the
server. You have three options, cheapest first:

### A. Raw-SQL table or additive change → nothing to do on the server

Tables created with `CREATE TABLE IF NOT EXISTS` in code (the `lib/**` raw-SQL
tables) are created by the app at runtime. Adding one of those needs **no**
server step — deploy the code and it self-creates.

### B. New column / new Prisma model → apply the additive SQL once

1. Change `prisma/schema.prisma`, and locally run `pnpm db:push` (updates your
   dev DB).
2. Generate the exact SQL the change implies:
   ```bash
   pnpm prisma migrate diff \
     --from-url "file:./data/project-r.db.PREV" \
     --to-schema-datamodel prisma/schema.prisma \
     --script > change.sql
   ```
   (or hand-write the `ALTER TABLE … ADD COLUMN …` / `CREATE TABLE …` — additive
   only.)
3. **Back up the server DB** (above), then apply the SQL to it via `prisma db
   execute` inside the container (it runs raw SQL, does NOT drop anything):
   ```bash
   railway ssh --project <p> --environment <e> --service <s> \
     "cd /app && printf '%s' '<your ALTER/CREATE SQL>' | pnpm prisma db execute --stdin --url file:/app/data/project-r.db"
   ```
4. Deploy the code (push to `prod`). The app now matches.

### C. Destructive change (rename / drop column, type change) → plan it

`db push`/`migrate` will want data loss. Back up first, then apply a hand-written
migration SQL via step B's `prisma db execute` (e.g. add new column, copy data,
drop old) so nothing is lost. Test on a copy of the backup locally first.

### Recommended long-term: adopt Prisma migrations

The clean, no-data-loss way to evolve the schema is `prisma migrate` instead of
`db push`:

1. Baseline the current schema once: `pnpm prisma migrate dev --name init`
   locally, then mark it already-applied on each existing DB with
   `prisma migrate resolve --applied <init-name>` (so it isn't re-run on DBs
   that already have the tables).
2. Change the deployed start command from the conditional `db push` to
   `prisma migrate deploy` — it applies only *pending* migration files and
   **never touches** the raw-SQL tables. Future schema changes become: commit a
   migration, push to `prod`, done — no manual SQL, no data loss.

This is the recommended upgrade when schema changes get frequent. Not set up yet
(the app currently uses `db push`); ask when you want to switch.

## Moving data between local and server

### Push local → server (one-time seed / restore a backup) — OVERWRITES server

Uses the boot-time import hook in the `Dockerfile`:

```bash
railway volume files -v <volume-id> upload ./data/project-r.db /project-r.db.import --overwrite
railway redeploy -y --service <s> --environment <e>
```

At boot the app swaps `project-r.db.import` into place (clearing stale WAL) and
skips `db push`. ⚠️ This **replaces** the server DB — only do it to seed a fresh
deploy or restore a known-good backup, never to "sync" everyday.

### Pull server → local (get the live data onto your machine)

```bash
railway volume files -v <volume-id> download /project-r.db ./data/project-r.db
```

Do this when you want to develop against the real accumulated data, or to keep a
backup.

## Current IDs (this deployment)

- Volume: `9186963c-b7ae-4018-a851-55197b883ad7`
- Project / Env / Service: see `DEPLOY.md`.

## Golden rules

1. **Back up the server DB before any schema change or re-upload.**
2. **Schema is code (committed); data is not (lives in the DB files).**
3. **Server DB is the source of truth after go-live — don't overwrite it with
   local unless you mean to.**
4. **Additive changes are safe; destructive ones need a hand-written, tested
   migration.**
