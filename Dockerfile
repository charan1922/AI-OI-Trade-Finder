# syntax=docker/dockerfile:1
#
# Railway deployment image for Project-R-simulator (Next.js 16, App Router).
#
# Single stage on purpose: the app needs ALL dependencies at runtime, not just
# prod ones — the native data layer (better-sqlite3, @duckdb/node-api) and the
# Prisma CLI (used by the start command's `prisma db push`) are both required
# after the build. A standard `next start` over the full node_modules is more
# reliable here than `output: standalone`, which can fail to trace the native
# modules (kept external via serverExternalPackages) and the runtime fs reads
# of lib/data/*.json.
FROM node:24-bookworm-slim

# Build toolchain for native modules, in case a prebuilt binary isn't published
# for this platform. openssl is Prisma's runtime dependency.
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

ENV NODE_ENV=production
# Guarantee the mount point exists even if the volume is ever detached; Railway
# mounts the real persistent volume over this at start time.
RUN mkdir -p /app/data

EXPOSE 5001
# Start sequence (the volume is mounted at runtime, so all of this sees it):
#   1. One-time DB import hook — if project-r.db.import exists on the volume
#      (uploaded via `railway volume files upload`), swap it into place BEFORE
#      anything opens the DB. Corruption-safe (nothing holds the file yet), and
#      harmless when the import file is absent. Clears stale WAL/SHM so the new
#      DB opens clean. Left in permanently so future migrations are just:
#      upload a fresh project-r.db.import, then redeploy.
#   2. `prisma db push` — create/upgrade the schema (idempotent; a no-op on an
#      already-populated migrated DB).
#   3. Boot Next on Railway's injected $PORT.
CMD ["sh", "-c", "if [ -f /app/data/project-r.db.import ]; then echo '[import] swapping migrated DB into place'; rm -f /app/data/project-r.db /app/data/project-r.db-wal /app/data/project-r.db-shm; mv /app/data/project-r.db.import /app/data/project-r.db; fi; pnpm prisma db push --config prisma/prisma.config.ts && pnpm exec next start -p ${PORT:-5001} -H 0.0.0.0"]
