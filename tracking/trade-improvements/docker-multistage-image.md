# Multi-stage Docker image + CI hardening

Done 2026-07-21. **Infra/deploy change — no trading logic touched.** Shrinks the
image the AWS box pulls on every deploy, and hardens the CI pipeline. Shipped as
one PR off `chore/build-ci-docs-hardening`.

## 1. Why — the deploy image carried a compiler it never uses

The image was **single-stage**: it installed the C/C++ build toolchain
(`python3 make g++` + deps) so the native modules (`better-sqlite3`) can COMPILE
during `pnpm install`. But that toolchain is **only needed at build time** — once
the `.node` binary exists, running it needs no compiler. The single-stage image
baked that toolchain (**~296 MB**, measured from the apt step) into the image the
box pulls on **every** deploy.

## 2. What changed — `Dockerfile` is now two stages

- **`builder`** — has the toolchain; runs `pnpm install` (compiles native
  modules) + `next build`. Byte-for-byte the same steps as the old single-stage.
- **`runtime`** — a clean `node:24-bookworm-slim` with **no compiler** (only
  `openssl` for Prisma + `pnpm`). It `COPY --from=builder /app ./` — the whole
  built tree: `node_modules` (with the compiled `.node` binaries + generated
  Prisma client), `.next`, source, package files.

The one rule that makes copying `node_modules` safe: **both stages share the same
base** (`node:24-bookworm-slim`), so the compiled native binaries are ABI/arch
compatible. Still the FULL `node_modules` (not `output: standalone`) on purpose —
standalone's file tracing drops the externalised native modules and the runtime
`lib/data/*.json` reads.

## 3. How it was verified (before trusting it near prod)

The full app image couldn't be built locally (podman-on-Windows copies the build
context across the WSL filesystem boundary painfully slowly — an environment
quirk, not a Dockerfile fault). So the **one real risk** — "does the native
module load without the compiler?" — was proven with a tiny, targeted 2-stage
build (`scripts`-free, no `next build`):

```
build log:  OK: no g++ in runtime stage
run output: better-sqlite3 loads + runs without toolchain: {"c":1}
            prisma better-sqlite3 adapter resolves: true
```

i.e. in a compiler-free runtime on the same base OS, `better-sqlite3` loaded,
created an in-memory DB, inserted and counted a row, and the Prisma adapter
resolved.

**CI now builds + boots the full image on every PR** (PR#7 review). The build job
runs on PRs and manual dispatch too — it builds the `runtime` target, then
smoke-tests the exact image: asserts no `g++`, that `better-sqlite3` + the Prisma
adapter load, and that the container **boots on a fresh DB (`prisma db push` →
`next start`) and answers HTTP**. So the real container is proven to come up
before any change can reach prod — no Windows-mount slowness on GitHub's runners.
Only a real push to `prod` publishes; PRs/dispatch never push.

`better-sqlite3` is the **only** trading-critical native module (the simulator
does **not** use duckdb — backtest storage is SQLite via Prisma).

## 4. Smaller build context — `.dockerignore`

`COPY . .` was pulling ~19 MB of **docs/notes/vaults** into the build context and
image (`R-Obsidian` alone is ~18 MB of markdown). None are imported at runtime
(verified: only referenced in code *comments*). Added to `.dockerignore`:
`R-Obsidian`, `derive-r`, `openspec`, `tracking`, `okf`, `autotrade-aicommentary`.
Smaller image + faster context upload, zero runtime effect.

## 5. CI hardening (shipped in the same PR)

All CI-only, no app/runtime change:

- **Least privilege** — a workflow-level `permissions: contents: read` default;
  the build job re-grants only `packages: write` (to push to ghcr). Previously
  the validate job inherited the repo-wide default token scope.
- **SHA-pinned actions** — all five actions pinned to a full commit SHA with a
  `# vX.Y.Z` comment (a moved/compromised tag can't inject code). Paired with
  **`.github/dependabot.yml`** (github-actions, weekly, grouped) which reads the
  version comment and opens bump PRs — so pinning stays current automatically.
  (Dependabot would have caught the Node-20 `setup-buildx` deprecation itself.)
- **Pinned `tsx`** — CI ran `npx --yes tsx …`, which downloads an *unpinned* tsx
  each run. `tsx` is now a pinned devDependency run via `pnpm exec tsx`
  (reproducible, no runtime fetch). Its transpiler `esbuild` is approved in
  `pnpm-workspace.yaml` (`esbuild: true`) so pnpm 10 builds it.
- **Publish gating** — publishing (`login` + `push`) is gated on
  `event == push && ref == refs/heads/prod`. Previously any `workflow_dispatch`
  built with `push: true`, so a manual run on a non-prod branch could overwrite
  production `latest`. Now only a real prod push publishes (PR#7 review).

## 6. Safety / rollback

- Toggle-free change; behaviour identical at runtime.
- The `sha-<commit>` image tag is the **commit-addressed** rollback target — if a
  multi-stage image ever misbehaved, redeploy the prior `sha-*` tag. (It's a
  rollback *identifier*, not registry-immutable unless the ghcr package enforces
  no-overwrite — treat immutability as operational, not automatic.) The box only
  ever pulls a **successfully built** image, and the image now has to pass the PR
  boot smoke-test before it can be merged toward prod.

## 7. Deferred (non-blocking, noted follow-ups)

- **Pin the exact pnpm version** (via `packageManager` + Corepack) so a future
  pnpm 10.x can't silently change the build — deferred to keep this PR focused and
  because an exact pin needs npm-ecosystem Dependabot to avoid going stale.
- **Pin the `node:24-bookworm-slim` base by digest** for full reproducibility.
- **A `triggered` count** in the profit-protection aggregation (see
  `profit-protection-shadow.md` §3) to state exactly how many losers reached +1R.
