# syntax=docker/dockerfile:1
#
# Multi-stage image for Project-R-simulator (Next.js 16, App Router).
#
# WHY multi-stage: the native data layer (better-sqlite3, @duckdb/node-api) needs
# a C/C++ toolchain (python3/make/g++) to COMPILE at install time — but NOT to
# RUN, once the .node binaries exist. The previous single-stage image baked that
# ~250-300MB compiler into the image the box PULLS on every deploy. Here the
# toolchain lives ONLY in the `builder` stage; `runtime` copies the already-built
# node_modules + app onto a clean base, so the deploy image is that much smaller
# with byte-identical runtime behaviour.
#
# Still the FULL node_modules, NOT `output: standalone`, on purpose: standalone's
# file tracing drops the native modules (kept external via serverExternalPackages)
# and the runtime fs reads of lib/data/*.json. Both stages share the SAME base
# (node:24-bookworm-slim), so the compiled native binaries copied across are
# ABI/arch-compatible — the one rule that makes copying node_modules safe.

# ---- Stage 1: builder — has the compiler; produces node_modules + .next -------
FROM node:24-bookworm-slim AS builder

# Build toolchain for native modules, in case a prebuilt binary isn't published
# for this platform. openssl is Prisma's dependency.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/* \
  && npm i -g pnpm@10

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# Deps first for layer caching. pnpm-workspace.yaml carries the `allowBuilds`
# allowlist that lets better-sqlite3 / @duckdb/node-api / prisma run their
# native build scripts (pnpm 10 blocks them otherwise).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Chromium for the TradeFinder relay, fetched HERE — after the lockfile install,
# BEFORE any source is copied — so this ~150MB download is a layer keyed on the
# lockfile alone and is reused by every build that doesn't change dependencies.
#
# It used to run in the runtime stage AFTER `COPY --from=builder /app ./`. That
# copy changes on every commit, so the layer behind it was invalidated on every
# commit and Chromium was re-downloaded on EVERY build (operator, 2026-08-11).
# GHA layer caching was already configured in the workflow and could do nothing
# about it: cache lookups stop at the first changed layer.
#
# PLAYWRIGHT_BROWSERS_PATH pins the download to a fixed, stage-independent
# location so the runtime stage can copy exactly this directory. Without it the
# browsers land in a per-user cache (~/.cache/ms-playwright) that differs
# between stages. `/ms-playwright` is Playwright's own convention — their
# official image sets exactly this. The SAME env var must be set at runtime or
# Playwright looks in the default location and reports the browser as missing.
#
# WHY `pnpm exec` (the lockfile's version) and not a pinned npx here: Playwright
# locates its browser by an exact revision-stamped directory name
# (chromium-<revision>), so the binary MUST come from the same Playwright version
# that ends up in runtime's node_modules. A mismatch is not caught at build time —
# it surfaces as "Executable doesn't exist at …" when the relay first launches, on
# the box, mid-session. Using the lockfile's own binary, in a layer keyed on that
# lockfile, makes a version bump invalidate this layer automatically.
#
# `install chromium` also lays down chromium_headless_shell-* and ffmpeg-* plus
# the .links bookkeeping dir, which is why the runtime stage copies the WHOLE
# directory rather than a single browser folder.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm exec playwright install chromium

# Source + build. No secrets are needed at build time — lib/env.ts treats every
# var as optional, and the pages are client-rendered.
COPY . .
RUN pnpm prisma generate --config prisma/prisma.config.ts \
  && pnpm build

# ---- Stage 2: runtime — no compiler; just runs the built app ------------------
FROM node:24-bookworm-slim AS runtime

# Runtime needs ONLY openssl (Prisma query engine) + ca-certificates + pnpm (the
# start command below uses `pnpm prisma db push` / `pnpm exec next start`). The
# C/C++ toolchain is deliberately ABSENT — that absence IS the size saving.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/* \
  && npm i -g pnpm@10

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
WORKDIR /app

# ── Chromium's OS shared libraries (nss, atk, gbm, fonts, …) ──────────────────
# BEFORE the app copy, so this apt layer caches too. `install-deps` installs ONLY
# the OS packages — it downloads no browser — and the version is pinned so the
# layer key is a literal string that changes only when we bump it deliberately.
# scripts/verify-dependency-hygiene.ts is not enough here (the Dockerfile is not
# TypeScript), so scripts/verify-playwright-pin.ts fails CI if this version drifts
# from the lockfile — a mismatch would install libs for one Chromium and copy a
# different one in below.
RUN npx --yes playwright@1.62.1 install-deps chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm

# The browser binary itself, lifted from the builder's cached layer rather than
# re-downloaded. Must land on the same PLAYWRIGHT_BROWSERS_PATH the builder used,
# and that env var must persist into the running container.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=builder /ms-playwright /ms-playwright

# The whole built working tree from the builder: node_modules (compiled .node
# binaries + the generated Prisma client), .next, source, and the package files.
# Same base OS/arch as the builder, so those native binaries load unchanged.
# LAST on purpose — it is the layer that changes every commit, so everything
# expensive above it stays cached.
COPY --from=builder /app ./

# CMD invokes this before every app boot. Fail the image build—not production
# startup—if a future .dockerignore change drops the required migration again.
RUN test -f /app/scripts/migrate-option-chain-table.ts

# Guarantee the mount point exists even if the volume is ever detached; the real
# persistent volume is mounted over this at start time.
RUN mkdir -p /app/data

EXPOSE 5001
# Start sequence (the volume is mounted at runtime, so all of this sees it):
#   1. One-time DB import hook — if project-r.db.import exists on the volume
#      swap it into place BEFORE anything opens the DB. Corruption-safe (nothing
#      holds the file yet), and harmless when the import file is absent. Clears
#      stale WAL/SHM so the new DB opens clean. Left in permanently so future
#      migrations can upload a fresh project-r.db.import and then redeploy.
#   2. `prisma db push` — ONLY when the DB file doesn't exist yet (fresh-volume
#      bootstrap). On an existing/migrated DB we skip it: the Prisma-modeled
#      tables are already there, and db push would try to DROP the app's
#      runtime-created raw-SQL tables (backtest_*, bhavcopy_*_expiry,
#      market_holidays, feature_toggles, …) to match the schema — destroying
#      real data. The app creates those raw tables itself at runtime
#      (CREATE TABLE IF NOT EXISTS).
#   3. Boot Next on the configured $PORT (5001 by default on AWS).
#   2b. One-time R-Factor V2 retirement (2026-08-11): copy the option-chain
#       evidence to its new table, drop the three rfactor_v2_* tables, and drop
#       the rFactorV2* columns off live_urgency_eod. Idempotent — a no-op on
#       every boot after the first, and on a fresh DB. Runs HERE because the
#       app's runtime CREATE TABLE only adds the new table; it cannot retire the
#       old ones, and `db push` must never be used for this (it would drop the
#       raw-SQL runtime tables not declared in schema.prisma).
#       Deliberately NON-FATAL: if it fails the app still serves correctly (the
#       new table is created at runtime; the old ones merely linger), and a
#       trading server must not refuse to boot over a cleanup step. It logs
#       loudly so a failure is visible rather than silent.
CMD ["sh", "-c", "if [ -f /app/data/project-r.db.import ]; then echo '[import] swapping migrated DB into place'; rm -f /app/data/project-r.db /app/data/project-r.db-wal /app/data/project-r.db-shm; mv /app/data/project-r.db.import /app/data/project-r.db; fi; if [ ! -f /app/data/project-r.db ]; then echo '[schema] fresh DB - running prisma db push'; pnpm prisma db push --config prisma/prisma.config.ts; else echo '[schema] existing DB - skipping db push'; fi; pnpm exec tsx scripts/migrate-option-chain-table.ts || echo '[migrate] option-chain migration FAILED - app continues, old rfactor_v2_* tables may remain'; pnpm exec next start -p ${PORT:-5001} -H 0.0.0.0"]
