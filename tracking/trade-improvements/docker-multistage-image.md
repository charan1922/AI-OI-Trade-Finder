# Smaller deploy image + safer build pipeline

Done 2026-07-21. **This is an infrastructure / deploy change — no trading logic
changed at all.** It makes the packaged app that the live server downloads on
every deploy smaller, and makes the automated build pipeline safer.

**A few words used below, in plain terms:**
- **Image / container** — the packaged-up app the live AWS server downloads and runs.
- **Build pipeline (CI)** — the automation on GitHub that packages the app and, on a real release, publishes it.
- **`better-sqlite3`** — the small database library the app uses. Part of it is *compiled* (machine code), so building it needs compiler tools; running it does not.

## 1. Why — the packaged app was carrying a compiler it never uses

To build `better-sqlite3`, the packaging step installs compiler tools
(`python3`, `make`, `g++`). Those tools are only needed **while building** — once
the compiled file exists, actually running the app doesn't need them. The old
build left the compiler tools **inside** the shipped image anyway: about
**296 MB** of dead weight the live server downloaded on **every** deploy.

## 2. What changed — the build now happens in two stages

The `Dockerfile` (the build recipe) is split in two:

- **Stage 1 — `builder`:** has the compiler tools; installs dependencies
  (`pnpm install`, which compiles `better-sqlite3`) and builds the app
  (`next build`). Exactly the same steps as before.
- **Stage 2 — `runtime`:** a clean base with **no compiler** — only what's needed
  to *run* (`openssl` for the database engine, plus `pnpm`). It copies the
  already-built files over from stage 1 (`COPY --from=builder`): the whole
  dependency folder (`node_modules`, including the compiled database file), the
  built app (`.next`), and the source.

The shipped image is stage 2, so the ~296 MB of compiler tools is gone.

**Why copying the built files across is safe:** both stages use the **exact same
base system** (`node:24-bookworm-slim`). A compiled file only works on the system
it was built for — same base means the compiled database file still works in the
runtime stage.

**One deliberate choice:** we copy the **whole** dependency folder, not Next.js's
"standalone" slimming mode. Standalone tries to auto-detect what to include and
would drop our database library and some data files the app reads while running
(`lib/data/*.json`) — so we don't use it.

## 3. How we made sure it works before trusting it near the live server

We couldn't build the full app locally — building on this Windows machine is
painfully slow because of how Windows shares files with the Linux builder (an
environment quirk, not a problem with the recipe). So we proved the **one real
risk** — "does the database library still load without the compiler?" — with a
tiny throwaway build:

```
build log:  OK: no g++ in runtime stage
run output: better-sqlite3 loads + runs without toolchain: {"c":1}
            prisma better-sqlite3 adapter resolves: true
```

In plain terms: on a clean system with **no compiler**, the database library
loaded, created a test database in memory, wrote and counted a row, and the
Prisma piece loaded too.

And now the automation does the **full** check on **every proposed change** (every
PR): it builds the real image and actually **starts the container from scratch** —
creates a fresh database (`prisma db push`) and boots the web server
(`next start`) — then sends it a web request and confirms it answers. So a
container that can't start is caught **before** it can reach the live server. Only
a real release to `prod` publishes the live image; PRs and manual runs never do.

(`better-sqlite3` is the **only** compiled library that matters here — the
simulator does **not** use duckdb; its backtest data is plain SQLite via Prisma.)

## 4. Smaller download — leaving docs out of the package

The build was also copying ~19 MB of notes / docs / design vaults into the image
(the `R-Obsidian` folder alone is ~18 MB of text). The app never reads these —
they only appear in code *comments*. We told the build to skip them
(`R-Obsidian`, `derive-r`, `openspec`, `tracking`, `okf`,
`autotrade-aicommentary`) via `.dockerignore`. Smaller package, faster builds, no
effect on the running app.

## 5. Safer build pipeline (same PR, nothing changes in the running app)

- **Minimum access** — the automation now gets only *read* access by default;
  only the publish step gets the *write* access it needs to publish the image.
  Before, the check step inherited more access than it used.
- **Locked-down helper tools** — the reusable build steps ("actions") are pinned
  to an exact code version (a specific commit), so if one were ever hijacked, a
  bad update couldn't sneak into our build. A bot (**Dependabot**) watches for
  genuine new versions and opens an update for review, so the pins stay current on
  their own. (This bot would have caught the earlier Node-20 warning by itself.)
- **Locked-down `tsx`** — the tool that runs our check scripts used to be
  downloaded fresh (unpinned) on every run. It's now a fixed dependency, so every
  run uses the same known version.
- **Publish only on a real release** — publishing the live image is now allowed
  **only** on a real release to the `prod` branch. Before, a manual test run on
  any branch could have accidentally overwritten the live image. It can't now.

## 6. Safety / rollback

- Nothing about the running app changes.
- Every build is tagged with its exact code version (`sha-<commit>`), so if a
  build ever misbehaved we can re-deploy the previous one. (That tag is a rollback
  *label*; it isn't guaranteed unchangeable unless the registry is set to forbid
  overwrites — treat rollback as an operational step, not automatic.) The live
  server only ever downloads a build that **succeeded**, and a build now also has
  to pass the "does it actually start?" check before it can be merged toward the
  live server.

## 7. Deferred (optional follow-ups, noted for later)

- **Pin the exact `pnpm` version** (via `packageManager` + Corepack) so a future
  pnpm 10.x release can't quietly change the build. Deferred to keep the PR
  focused, and because an exact pin needs a matching update-bot to avoid going stale.
- **Pin the base system by exact fingerprint** (`node:24-bookworm-slim` by digest)
  for full build-to-build reproducibility.
- **A "how many trades reached +1R" count** in the profit-protection numbers (see
  `profit-protection-shadow.md` §3) so that claim is exact rather than inferred.

## 8. Shipped — `v1.25.0` (2026-07-21)

Released to the live server using the repo's normal flow (merge the change → tag a
version → push to the `prod` branch):

- **PR #7** was reviewed (two must-fix items handled: build-and-start-test the
  image on every PR; publish only on a real prod release) and merged to `main` as
  `96425a8`.
- Tagged **`v1.25.0`** and pushed.
- Pushed `main` to `prod` (`16200ca` → `96425a8`) — this is what triggers a release.
- The release build ran, **built and published the new two-stage image** (as
  `:latest` and `:sha-96425a8`) — **succeeded**
  ([run](https://github.com/charan1922/AI-OI-Trade-Finder/actions/runs/29784192081)).
  This was the **first live release of the two-stage image**; it had already
  passed the PR "does it start?" check (fresh database → web server → answered a
  request), so we knew the container comes up before publishing it.
- No settings/secrets changed, so nothing extra was needed on the server beyond
  its normal download of the new `:latest`.

If a rollback is ever needed: re-deploy the previous image, tagged `:sha-16200ca`.
