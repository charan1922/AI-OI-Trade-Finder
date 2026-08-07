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

# The whole built working tree from the builder: node_modules (compiled .node
# binaries + the generated Prisma client), .next, source, and the package files.
# Same base OS/arch as the builder, so those native binaries load unchanged.
COPY --from=builder /app ./

# The TradeFinder browser relay's ONLY extra runtime requirement: a real
# Chromium binary plus the OS shared libraries it needs (nss, atk, gbm, fonts,
# ...). `--with-deps` installs both via apt in one step. `playwright` itself is
# already in node_modules (copied above); this is the large platform-specific
# binary that deliberately does NOT live in git or the lockfile. This is the
# real, accepted cost of that feature (2026-08-08) — the multi-stage split
# above still keeps the C/C++ COMPILER toolchain out of this image, so this is
# additive, not a reversion of that saving.
RUN npx playwright install --with-deps chromium

# Guarantee the mount point exists even if the volume is ever detached; the real
# persistent volume is mounted over this at start time.
RUN mkdir -p /app/data

EXPOSE 5001
# Start sequence (the volume is mounted at runtime, so all of this sees it):
#   1. One-time DB import hook — if project-r.db.import exists on the volume
#      (uploaded via `railway volume files upload`), swap it into place BEFORE
#      anything opens the DB. Corruption-safe (nothing holds the file yet), and
#      harmless when the import file is absent. Clears stale WAL/SHM so the new
#      DB opens clean. Left in permanently so future migrations are just:
#      upload a fresh project-r.db.import, then redeploy.
#   2. `prisma db push` — ONLY when the DB file doesn't exist yet (fresh-volume
#      bootstrap). On an existing/migrated DB we skip it: the Prisma-modeled
#      tables are already there, and db push would try to DROP the app's
#      runtime-created raw-SQL tables (backtest_*, bhavcopy_*_expiry,
#      market_holidays, feature_toggles, …) to match the schema — destroying
#      real data. The app creates those raw tables itself at runtime
#      (CREATE TABLE IF NOT EXISTS).
#   3. Boot Next on Railway's injected $PORT.
CMD ["sh", "-c", "if [ -f /app/data/project-r.db.import ]; then echo '[import] swapping migrated DB into place'; rm -f /app/data/project-r.db /app/data/project-r.db-wal /app/data/project-r.db-shm; mv /app/data/project-r.db.import /app/data/project-r.db; fi; if [ ! -f /app/data/project-r.db ]; then echo '[schema] fresh DB - running prisma db push'; pnpm prisma db push --config prisma/prisma.config.ts; else echo '[schema] existing DB - skipping db push'; fi; pnpm exec next start -p ${PORT:-5001} -H 0.0.0.0"]
