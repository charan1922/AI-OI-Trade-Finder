---
name: open-pr
description: >
  How to open a pull request in the Project-R simulator repo, and exactly what
  to check before you do. Use when the user asks to "raise/open/create a PR",
  "put this up for review", "what do I check before a PR", or when you have
  finished a change and are about to commit/push it. Covers the pre-PR gate (the
  full CI job, run locally first), staging discipline, commit/PR conventions,
  responding to review rounds, and this repo's money-touching guardrails. This
  is a money-touching trading codebase — the checks are not optional.
compatibility: >
  Assumes pnpm 10 + Node installed, the repo cloned, and a GitHub credential
  available via Git Credential Manager (there is NO `gh` CLI here). Some benches
  need a populated local DB (`pnpm db:pull-prod:full`); the CI benches do not.
---

# Opening a PR in Project-R simulator

This repo drives **real-money options trading**. A broken merge can place or
mis-size live orders. So the bar is: **prove it green locally before you push,
prove it green in CI before you call it done, and never bundle unrelated work.**

Everything here is specific to THIS repo. Where it conflicts with the parent
`../CLAUDE.md`, this repo wins: **ESLint + Prettier, port 5001, `pnpm lint`** (not
Biome/5000).

## Golden rules (do not break these)

1. **Never `git add`/commit/push without the user's explicit OK.** Passing
   checks is not permission. "Fix it" is not "commit it." Ask.
2. **Stage only the files your change touched.** If `git status` shows files you
   did not edit, do NOT `git add -A`. Someone else's uncommitted work (often the
   owner's) can be sitting in the tree — commit your files by name and leave the
   rest. When in doubt, `git diff <file>` and surface it.
3. **Run the FULL CI `validate` job locally before every push** — not just the
   test you touched. A green partial run is how a fixture break reaches CI.
4. **Validate review points against the MERGED code**, i.e. `git show main:<file>`,
   not your ahead branch — a claim can be true on `main` and already fixed on
   your branch, or vice-versa.
5. **No new third-party dependencies** without asking. Prefer Node built-ins
   (`process.loadEnvFile`, `node:*`). `adm-zip`, `dotenv`, `protobufjs` have all
   been rejected here.
6. **Money-path code fails CLOSED.** A gate that can't compute risk must REFUSE,
   never allow. "AI proposes, code disposes" — every mutating tool re-runs
   `risk/gates.ts`.
7. **Never `prisma db push --accept-data-loss`.** Six runtime tables are not in
   `schema.prisma` (`bhavcopy_*_expiry`, `trade_commentary`, `market_holidays`,
   `fno_expiry_calendar`) and a forced push DROPS them. Add columns via
   `CREATE TABLE IF NOT EXISTS` + a guarded `ALTER TABLE ADD COLUMN` in the
   store, mirrored (not enforced) in `schema.prisma`.

## 1. Branch

Work happens on `main` for small changes, or a topic branch for anything
reviewable. Never commit straight to `main` if the user wants review.

```bash
git switch -c fix/<short-kebab-summary>     # or feat/…, docs/…, chore/…
```

## 2. Pre-PR gate — run the whole CI `validate` job locally

CI (`.github/workflows/build-image.yml`, job `validate`) runs exactly this, in
order. Run all of it locally and get it green before pushing:

```bash
pnpm db:generate            # regenerate the Prisma client (schema may have changed)
pnpm typecheck              # tsc --noEmit  (the app)
pnpm typecheck:scripts      # tsc --noEmit -p tsconfig.scripts.json  (scripts/ + lib/ — easy to forget)
pnpm lint                   # eslint
pnpm exec tsx scripts/verify-quant-shadow.ts   # DB-FREE money-math + gate + drift checks
```

**One-liner** (stops at the first failure):

```bash
pnpm db:generate && pnpm typecheck && pnpm typecheck:scripts && pnpm lint \
  && pnpm exec tsx scripts/verify-quant-shadow.ts && echo "VALIDATE OK"
```

Then, **for any change under `lib/auto-trade/`, `lib/trade-suggest/`, or the
store**, also run the box-only bench (needs a populated DB —
`pnpm db:pull-prod:full` once):

```bash
pnpm exec tsx scripts/verify-auto-trade.ts     # gates, symbology, store math, one quiet engine pass
```

Why both: `verify-quant-shadow.ts` is the DB-free CI runner (pure money math,
gate refusals, config-drift, profit-protect, premium-stop). `verify-auto-trade.ts`
is box-only (it needs SQLite), so anything asserted ONLY there is claimed, not
CI-verified. Put pure money-touching assertions in the CI runner; keep
DB-dependent flow tests in the box bench.

- `tsc` is the type gate, but validation for correctness is `pnpm lint` +
  the benches — do not "verify" with `tsc` alone.
- If you add/require a field on a shared type or gate input, the fixtures in
  `scripts/*-checks.ts` and `scripts/verify-*.ts` must be updated too, or
  `typecheck:scripts` (and then CI) fails. This is why step 3 above is
  load-bearing and easy to forget.

## 3. Stage, then commit

```bash
git status --short                 # LOOK. Are all these files yours?
git add path/to/only/your/files    # by name — not `-A` unless you own everything shown
git diff --cached --stat           # confirm exactly what's staged
```

Commit message: a `type(scope): summary` subject, then a body that says WHAT and
WHY (reviewers read the body). End every commit with:

```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

Use a heredoc so multi-line bodies survive PowerShell/Bash quoting:

```bash
git commit -F - <<'EOF'
fix(auto-trade): one-line summary

What changed and why. Reference the review point or incident. Note anything
deliberately deferred and why.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

## 4. Push and open the PR (no `gh` CLI here)

```bash
git push origin <branch>
```

There is **no `gh` CLI**. Use the GitHub REST API with the token from Git
Credential Manager:

```bash
TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill 2>/dev/null \
  | grep '^password=' | cut -d= -f2-)
# repo: charan1922/AI-OI-Trade-Finder
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/charan1922/AI-OI-Trade-Finder/pulls \
  -d '{"title":"…","head":"<branch>","base":"main","body":"…"}'
```

The token is a credential: never print it, never write it to a tracked file,
never send it anywhere but github.com. For long bodies, write the markdown to a
scratchpad file and `--data-binary @file.json` (JSON-encode with Node), rather
than fighting shell quoting.

**PR body**: lead with the one-sentence "why". State which commits change trading
behaviour vs which are enforcement/docs/CI. If a reviewer raised points, add a
table: finding → verdict (valid / partly / invalid, with evidence) → fix. Name
what you deliberately did NOT do and why. End with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## 5. Responding to a review round

1. **Validate every point against the real code** (`git show main:<file>` for
   merged state; read the actual function). Some review claims are stale or
   already handled — say so with evidence; don't fix a non-bug.
2. Fix the valid ones. Blocker/High first. Don't gold-plate beyond what's
   required (note larger follow-ups as operator decisions).
3. **Add a test that would have caught the bug** — especially for money math.
   If a bug "passed CI", that means the path wasn't covered; cover it (pure
   check in `verify-quant-shadow.ts` when possible, box bench otherwise).
4. Re-run the **full** local gate (§2) — including the box bench for money-path.
5. Push, then **confirm CI green on the true head commit** via the API before
   claiming done:

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
     "https://api.github.com/repos/charan1922/AI-OI-Trade-Finder/commits/<sha>/check-runs" \
     # look for {"name":"validate","conclusion":"success"}
   ```

   Watch for the head moving under you: the owner may push a commit to the same
   branch. Re-fetch, re-check the count and the head SHA, and point "CI green"
   at the ACTUAL head, not the commit you pushed.
6. Update the PR body to match (commit count, CI head, a per-round summary).

## 6. Merge & deploy (context — usually the operator's call)

- CI: a PR to `main` builds the runtime image and smoke-tests it (never pushed);
  a push to `prod` builds and pushes `:latest`, which the **AWS box** (prod,
  self-hosted EC2) pulls. Flow after merge: `git push origin main:prod`.
- Prod env vars live on the box's env-file (needs a container recreate to take
  effect) — **never** in git. Autonomous jobs need `AUTONOMOUS_SERVER=true`.
- Do not merge money-path changes toward live without the box bench green and
  the operator watching the first real order — broker order APIs are not
  fully proven against a live account.

## 7. Repo-specific gotchas checklist

- [ ] `pnpm lint` + `pnpm typecheck` + `pnpm typecheck:scripts` all clean.
- [ ] `verify-quant-shadow.ts` green; `verify-auto-trade.ts` green if money-path.
- [ ] No new dependency added (or the user approved it).
- [ ] New DB column: `CREATE TABLE`/guarded `ALTER` in the store + `rowTo…`
      mapping + `schema.prisma` mirror + INSERT placeholder count matches.
- [ ] No `prisma db push --accept-data-loss` anywhere.
- [ ] Money-path change fails closed on missing/NaN inputs; prices risk off the
      executable **ask**, not the ltp/mid mark.
- [ ] Only your files staged; no unrelated work bundled.
- [ ] Prompts unchanged unless re-benched (`COMMENTARY_SYSTEM` is byte-frozen).
- [ ] Commit + PR body have the required trailers.
