# CLAUDE.md — Project-R Simulator

This file extends the parent repo's `../CLAUDE.md` with simulator-specific guidance. Where they conflict, this file wins (the simulator uses **ESLint + Prettier on port 5001**, not Biome/5000; validate with `pnpm lint` and `pnpm typecheck`).

## Before you push: run the CI job, not a subset

`pnpm lint` + `pnpm typecheck` is NOT the gate — `.github/workflows/build-image.yml` also runs **`pnpm typecheck:scripts`** (the root tsconfig excludes `scripts/`), **`scripts/verify-dependency-hygiene.ts`**, and ~14 `verify-*.ts` benches. Run all of them locally.

**Env loading in `scripts/`: `process.loadEnvFile('.env.local')`, never `dotenv`.** `dotenv` is not a dependency of this repo. It resolves on a dev machine because pnpm hoists transitive packages into `node_modules` — which is exactly what `tsc` reads — so an undeclared import typechecks clean locally and then fails CI's `--frozen-lockfile` install with TS2307 (shipped in `measure-option-evidence.ts`, 2026-08-11; the parent repo's dotenv guidance does not apply here). `verify-dependency-hygiene.ts` now compares every bare import against `package.json` itself so this class of bug reproduces locally instead of only in CI. Do not "fix" a hygiene failure by running `pnpm add` — prefer a Node builtin, and ask the operator before introducing any new third-party package.

## Authentication (Google via Auth.js + RBAC)

- **Google sign-in is THE browser login** (Auth.js / next-auth v5 — the beta tag is the App Router standard, per `authjs.dev`). Official layout: `auth.ts` (root config), `app/api/auth/[...nextauth]/route.ts` (handlers), `proxy.ts` wraps the existing gate with `auth()` so `req.auth` joins the role resolution.
- **Role policy** (single source: `roleForGoogleEmail()` in `lib/auth/rbac.ts`), resolved in this order: `OWNER_GOOGLE_EMAILS` → admin; `ADMIN_GOOGLE_EMAILS` → admin; an explicit revoke → denied; the `/users` registry → admin/viewer; `GOOGLE_VIEWER_EMAILS` → viewer; anything else → denied before a session is issued. While the OAuth app is in Google's "Testing" status, only test users added in Google Cloud Console can sign in at all.
- **OWNER tier** (user rule 2026-08-10): only `OWNER_GOOGLE_EMAILS` reaches `/users` + `/api/users` — a plain admin trades but cannot change who gets in. Keep it hardcoded: the grant that hands out every other grant must not be editable by whoever holds it, and it means no DB state can lock the operator out. Break-glass password login counts as owner; Basic Auth (internal self-calls) does not.
- **`/users` grants** (`app/users`, `app/api/users`) apply on the user's next request, no redeploy. Two invariants, both CI-guarded by `scripts/verify-user-access{,-store}.ts`: (1) **a row is not a grant** — `recordUserSeen()` records every sign-in, so access requires the explicit `grantedAt` stamp; keying off `status='active'` silently re-admits old accounts. Never backfill `grantedAt`. (2) **revoke is a tombstone** (`status='revoked'`) checked BEFORE `ADMIN_GOOGLE_EMAILS`, or a code-listed admin falls through and the Remove button lies. `recordUserSeen`'s bootstrap force stays scoped to the OWNER, or a later sign-in undoes a downgrade.
- **Break-glass**: the password form is hidden but alive at `/login?password=1` (posts to `/api/auth/login`) — never remove it; it's the operator's way in if Google is down/misconfigured. Internal server-to-self calls (poller/engine) keep using HTTP Basic with `APP_PASSWORD` — untouched by Auth.js.
- **Basic-auth browser detection** (`roleFromBasicAuth` in proxy.ts): must check `sec-fetch-dest`/`sec-fetch-site`, NEVER `sec-fetch-mode` — Node's fetch (undici, ≥18.5) sends `sec-fetch-mode: cors` on every server-side call, so a sec-fetch-mode check silently 401s ALL internal engine/poller self-fetches (scanner, quotes, commentary — caught 2026-07-12 before the first live session on that code).
- **Sessions**: Auth.js uses stateless JWTs (`AUTH_SECRET`) — no DB tables. One sign-out (`/api/auth/logout`) clears both the password cookie and the Auth.js cookies.
- **Users registry** (`lib/auth/users.ts`, table `app_users`, mirrored as `AppUser`): every Google account that signs in is recorded from the root layout (throttled, fire-and-forget) — code-listed operators seed as `admin`/`owner`, everyone else `viewer`/`trial`. Also holds the grant fields role resolution reads (`grantedAt`, `status`) plus `subscriptionEndsAt` for future billing. **Next 16 always runs `proxy.ts` on the Node runtime** (bundled Next docs; its `runtime` option doesn't exist), so DB reads there are legal — the old "proxy may be Edge, never touch the DB" rule was about `middleware.ts` and is dead. Still keep `rbac.ts` import-free and load the registry via **dynamic import in try/catch**, so a DB failure degrades to the hardcoded lists instead of 500-ing every request. 15s TTL — a revoke can take that long to bite.
- **Viewer UX rule**: viewers don't see operator action buttons at all (hidden via `useRole().readOnly`, not just disabled) — commentary Generate, bhavcopy Sync, trade-viewer Download, fyers poller/token controls. Enforcement is still the proxy's 403 (default-deny on unclassified mutating APIs); the hiding is UX.
- **Env**: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET` (all required on Railway too), plus `AUTH_URL=<public origin>` **required in production** — behind Railway's proxy the app sees itself as `0.0.0.0:5001`, and without AUTH_URL, Auth.js sends Google an insecure redirect_uri (Google blocks with `invalid_request`). Google Cloud Console must list `<origin>/api/auth/callback/google` as an authorized redirect URI for `http://localhost:5001` AND the production domain. Redirects in our own routes must be RELATIVE (`Location: /login`), never built from `req.url`.

## TradeFinder capture (`/tf`) and the pages that read it

- **The relay dies quietly by design of the site, not of the code.** TradeFinder signs this account out roughly daily, INCLUDING mid-session: on 2026-08-10 captures ran cleanly until 12:10 IST, then every request returned `TOKEN_ERROR: UNAUTHORISED` for 3h20m (263 of them). Treat mid-session death as the NORMAL failure. `handleResponse()` in `lib/tf-live/browser.ts` must therefore raise `recordTfBrowserOutcome(false, …)` after `CONSECUTIVE_FAILURE_LIMIT` **regardless of `sawFirstSuccess`** — the old `&& !s.sawFirstSuccess` meant one morning success disabled the alarm for the rest of the day, so `/tf` showed a green "browser running" badge through all 263 failures and the operator could not tell why anything had stopped.
- **"Running" is not "working."** The `/tf` badge reads *running, not capturing* whenever `session.lastError` is set, and the page surfaces its OWN fetch failures (401/500/network) instead of `if (j.success) setData(j)` inside an empty catch — that pattern rendered an expired login as a blank page with no reason.
- **`/sector-scope` is 100% TradeFinder.** Every number (LTP, prev close, %, R-Factor) comes from `all_sector` `param_0..param_3`; the payload carries **nothing else** (verified against real captures — each leaf is exactly `Symbol` + `param_0..3`). It has no turnover, so `/api/heatmap` is used ONLY for treemap tile SIZE, fetched out of band after paint and at most once per `HEATMAP_MIN_INTERVAL_MS` (10 min). Never put a broker call back in that page's blocking path: `/api/heatmap` measured **1.0–8.6s** against the real server versus **36–45ms** for the two SQLite capture reads, and it takes the same process-wide Dhan quote gate `/live`'s polling needs — `app/live/_lib/quote-scheduler.ts` aborts any quote over `FETCH_TIMEOUT_MS` (8s), which the browser reports as `(canceled)`.
- **The page is exactly as fresh as the last capture, and says so.** A frozen board must never pass for a live one: the capture time is shown, turns amber past 10 minutes, and there is no fallback to live Dhan prices (that fallback is what made the two pages disagree in the first place).
- **TF Running Race baseline is 09:35** (`WINDOW_START_MIN` in `lib/tf-live/race.ts`), moved back from 09:45 so accumulation right after the open is visible — on 2026-08-10 this turned RECLTD from +33 to **+192** (#206→#14) and NMDC from +5 to **+157**. 09:30 was tested and rejected: only 13 of 210 symbols were above R=1 at 09:30 vs 22 by 09:45, so ranks there swing on hundredths. `MIN_SPREAD_SYMBOLS` guards the BASELINE specifically — a capture may only anchor the race if enough symbols separated above R=1. Not hypothetical: the 09:16 capture that day had all 210 R-Factors at exactly 0 (TF resetting for the day), which would have ranked in arbitrary order and reported the whole board as climbing.

## Option-chain evidence — MEASURED, NARRATED, DELIBERATELY NOT A GATE

The Dhan option-chain read (`lib/r-factor-v2/option-evidence.ts`, collected by `option-shadow.ts`, shown on `/live` as **R V2 Shadow**) already classifies exactly what an operator reads by hand — *call buying / put writing are bullish; put buying / call writing bearish* — and Dhan returns `previous_oi`/`previous_volume` per strike, so buildup vs unwinding needs one call and no self-snapshotting.

**It does not gate, size, or veto anything, and that is a result, not an oversight.** `scripts/measure-option-evidence.ts` paired it against every graded suggestion with a snapshot taken *at or before* the suggestion (strict no-lookahead — pairing with a later snapshot manufactures an edge that cannot be traded):

- 91 usable pairs, 13 sessions. Chain **agrees with the scanner 81 of 91 times (89%)** — it largely echoes the same OI/flow the scanner already reads, so it is not an independent opinion.
- Agree +0.316R vs contradict +0.073R, but contradictions are **n=6, ±0.612** — the gap is a fraction of its own error bar.
- Vetoing contradicted trades would have earned **+0.017R per trade** while dropping 7% of them. The confidence buckets are incoherent (conf ≥ 0.5 contradictions *won*, +0.997R; conf ≥ 0.7 is n=1).

Re-run that script before anyone promotes this to a filter. The blocker is coverage, not the idea: `MAX_TRACKED` was raised 12 → 20 to gather contradictions faster, and **the history cannot be backfilled** — Dhan's `/v2/optionchain` is live-only, so the sample only grows forward at roughly one session per day.

**Narration rule (learned the hard way).** `describeOptionChain()` in `lib/ai-commentary/generate.ts` hands the model FINISHED ENGLISH and no numbers. The first cut passed the raw fields, and `scripts/dry-run-commentary.ts` caught the model turning `callOiChangePct: 74.3` into *"74% of today's move happened in the last 30 minutes"* — an open-interest figure fabricated into a price statistic a trader would act on. Never put a bare OI number in that payload; every other number in it is about price.

## /live Multi-Viewer Scaling

`POST /api/live/quote` responses are shared through `app/api/live/_lib/quote-response-cache.ts` (globalThis TTL cache + in-flight coalescing, keyed by the exact symbol list): N open windows/users cost the same Dhan traffic as 1. The 6.5s TTL sits deliberately under the client's 7s poll (`QUOTE_POLL_MS`) so a single window always recomputes — change either constant only in step with the other. `fresh: true` bypasses the cache: the page's "Refresh all" button sends it, and `lib/trade-suggest/engine.ts` ALWAYS sends it (the scanner feeds real trade decisions — never let it read a stale cache). Errors are never cached; side effects (oi_intraday recording, universe enrollment, context warming) run once per compute.

## Headless automation & token warm-up

Everything trading-critical runs on the server with NO page open. `instrumentation.ts` starts the Fyers poller at boot (`startFyersPoller`); it ticks every 5 min 24/7 (`lib/fyers/poller.ts`, `scheduleNextTick`), and during market hours records candles/OI and runs the autonomous capture (scanner → auto-trade). Broker tokens (Fyers/Dhan) are created LAZILY on first use — never at import. `getFyersAccessToken`/`getDhanAccessToken` are idempotent (return the cached token instantly while valid; promise-locked; disk-cached in `data/.{fyers,dhan}-token.json`).

**Pre-open token warm-up** (`warmPreOpenTokens` in poller.ts): on the off-hours ticks in **08:40–09:15 IST on trading days**, the poller mints BOTH tokens so they exist before 09:00 with no page opened. Deliberately NOT Railway-gated (calls are idempotent; dev needs the same tokens) and NO per-day marker — the token cache IS the success marker, so every in-window tick is a free retry (~7 attempts, 5 min apart, over Dhan's ~2-min gen limit). One provider failing never blocks the other. Outcome surfaces as `PollerStatus.lastWarmup` (on `/fyers`, `/dhan`, and the health widget). A PAUSED poller skips warm-up (the pause guard precedes the market-closed branch). Ops/test hook: `POST /api/fyers/poller {action:'warm-tokens'}` runs it immediately, window checks bypassed.

**`/dhan` page + `GET|POST /api/dhan/status`**: the Dhan sibling of `/fyers` (chips + New-token + Test-call). `GET /api/dhan/status` is STRICTLY PASSIVE (poll-safe) — NEVER poll `GET /api/dhan/token`, which GENERATES a token as a side effect. `POST /api/dhan/status {action:'test-call'}` fetches one RELIANCE quote to prove the token works end-to-end (admin-only via default-deny; works off-hours too).

## Auto-Trade Module (`lib/auto-trade/`)

AI-driven order execution over the deterministic `/trade-suggest` scanner. Design law: **the AI proposes, code disposes** — every mutating tool re-runs `risk/gates.ts` in code; no prompt failure can bypass a limit.

### Modes (runtime setting on `/auto-trade`, default `off`)

- `paper` — simulated fills at real live quotes (never fabricated; no quote → order fails)
- `approval` — AI proposes real orders; each waits for a human Approve on `/auto-trade` (approval re-runs all gates against a fresh quote)
- `live` — autonomous real orders. **Two-key rule:** also requires env `AUTO_TRADE_LIVE_ENABLED=true`; the approval mode does NOT need the env key (the human click is the second key)

### Hard limits (user's risk rules — enforced in code, not prompts)

- Entries only **09:45–11:00 IST**; exits any time; forced square-off at **15:12** (`SQUARE_OFF_MIN`)
- Max **2 trades/day**, max **2 open lots**, max **₹60k** deployed premium, **₹5k** daily-loss halt (settings-tunable ranges in `lib/auto-trade/settings.ts`)
- Always 1 lot; scanner picks only (the AI cannot choose symbol/strike/size); no re-entry of a symbol the same day; stop moves may only tighten
- Position guard (premium SL/target + spot plan + square-off) runs BEFORE the AI every pass and under the kill switch — deterministic, works with the LLM down

### Premium stop: size it to the OPTION, cap the risk by REFUSING (not by tightening)

Changed 2026-07-23 after reviewing all 9 completed live trades. **Never restore the old rule.**

- The stop is `OPTION_STOP_PCT` (**25%**) of the option's own entry price — `stopPremiumForFill()` in `lib/auto-trade/backstops.ts`. It is **not a function of lot size**.
- The per-lot rupee budget (`MAX_RISK_PER_LOT_RUPEES`, **₹2,500**) is enforced by **refusing an over-sized contract** in `risk/gates.ts` — never by moving the stop until the arithmetic fits.
- **The risk gate FAILS CLOSED.** Missing lot size, no live ask, a corrupt stop %, or too little displayed size at the ask all REFUSE the entry. A risk gate must never read "cannot calculate" as "allow" — that exact bug shipped in the first cut of this change: `approveTrade()` never passed `lotSize`, so the ceiling silently skipped itself on every human-approved order (PR#18 review).
- **Risk is priced off the ASK, not the ltp/mid.** Entry is a market BUY, so the ask is what we pay; sizing off a mark understates the rupees behind the stop. The gate also requires `askQty ≥ lotSize × lots`, because a lot bigger than the resting offer sweeps up the book.
- **The ceiling is a PLANNED figure, not a guaranteed maximum loss.** A market order can still fill above the ask, so `applyEntryFill` re-measures actual fill-to-stop risk and fires `alerts.riskCeilingBreachedOnFill` when it exceeds the budget the gate approved. Never describe it in the UI as a guaranteed loss cap.
- **The approval path gates on the PROPOSAL's stop width** (`stopPctOverride` = `slPremium ÷ entryPremium`), not the current setting — the fill re-anchors to the proposal, so gating on a since-changed `optionStopPct` would evaluate one policy and ship another.
- **The scanner's displayed stop uses the same runtime policy** — `attachPremiums(options, policy)` takes the effective `optionStopPct`/`maxRiskPerLotRupees` from settings. Do not reintroduce compile-time constants there or the page will drift from what fires.
- Why: the old rule was `max(−40%, −₹1,500 ÷ lotSize)`. Because lot sizes run 75–700, the *effective* stop landed anywhere from **7.7% to 23.8%** across nine live trades and nobody chose those numbers. Every stop under ~12% lost (INDUSINDBK 7.7%, AXISBANK 8.1%, NESTLEIND 9.2%, POLYCAB 9.4%, COLPAL 11.7%); both above 20% won.
- The proof case: **SRF 2026-07-23**. Stopped at a 17% stop while the stock sat 1 point from entry — the option had already burned 78% of its stop budget on time decay, the post-open volatility cool-off and a 2.16% bid-ask spread. The call was RIGHT: the stock fell 175 points and the same contract bid **₹178 by 14:50** (₹26,880/lot instead of −₹1,610). A 25% stop (₹33.04) was never touched all session.
- An option re-prices on things the spot knows nothing about. SRF's own bid ranged ₹36.10–₹45.05 (**20.3% of entry**) inside a 6.5-minute hold with the stock nearly flat — a stop inside that band measures the contract breathing, not the idea failing.
- `backstopsFromProposalFill()` recovers the stop WIDTH from the proposal (`slPremium ÷ entryPremium`) exactly as it recovers the cash target, so changing `optionStopPct` while an approval is pending cannot move levels a human already approved.
- Evidence is reproducible: `npx tsx scripts/replay-premium-stop.ts` replays every recorded live trade against the new rule and prints its own caveats (n=9 IN-SAMPLE; full-day option prices exist only for 2026-07-23; bid figures are the lowest RETAINED SNAPSHOT, not a continuous tape; lot cost and old stop width are the same underlying variable).
- The pure stop/risk assertions live in `scripts/premium-stop-checks.ts` and run in **CI** via `verify-quant-shadow.ts`. Do not move money-touching pure checks back into `verify-auto-trade.ts` — that bench needs a populated DB and is box-only, so anything living only there is claimed, not verified.
- **Keep `dailyLossHaltRupees` above `maxRiskPerLotRupees`** or one full-stop loss ends the day.

### Brokers (adapter pattern in `brokers/`)

One active at a time (`broker` setting: `fyers` | `dhan`). Fyers uses the installed `fyers-api-v3` SDK trading methods (ambient types extended in `lib/fyers/fyers-api-v3.d.ts`); Dhan is raw `/v2/orders` REST. Exits always route to the venue the trade opened on. Every order carries a unique idempotency key — retries can never double-fire. **The real broker order APIs are untested against live accounts — watch the first approval/live order manually.**

### One AI analysis per cycle

The auto-trade pass runs FIRST in the Fyers poller's autonomous capture. When its pass produces a read, it is stored into `trade_commentary` (`commentaryStored: true`) and the standalone MiMo commentary is **skipped**. MiMo commentary only runs as the fallback (mode off / kill switch / nothing to decide / AI failed). Never reintroduce a second parallel AI analysis of the same scan — explicit user rule.

### Prompts (battle-tested; versioned)

- `lib/ai-commentary/generate.ts` exports `COMMENTARY_SYSTEM` (the battle-tested narrator — keep byte-identical unless re-benched with `scripts/dry-run-commentary.ts`) plus the shared blocks `COMMENTARY_OUTPUT_FORMAT` / `COMMENTARY_HARD_RULES`
- The auto-trader prompt (`lib/auto-trade/decision/system-prompt.ts`) composes those shared blocks **verbatim** + an executor verdict mapping — one source of truth for the writing rules
- Prompt versioning (`lib/prompts/store.ts`, table `prompt_versions`, page `/prompts`): every distinct prompt text auto-records a new version at generation time; commentary rows carry `promptKey`/`promptVersion`. The table is read-only history — **code stays the source of truth; never make the DB a live prompt override**

### AI providers

`aiProvider` setting: `azure` (Responses API, proven tool-calling) | `mimo` (chat.completions tools; reasoning model — budget max_tokens generously and read `content`). Loop implementations in `lib/auto-trade/decision/providers.ts`.

### Storage & verification

- Tables `auto_trades` / `auto_orders` / `auto_decisions` / `auto_trade_settings` / `prompt_versions` are runtime-created (raw `CREATE TABLE IF NOT EXISTS`), mirrored in `schema.prisma`
- **Never run `prisma db push --accept-data-loss`** — the DB holds six runtime tables never declared in `schema.prisma` (`bhavcopy_fut_expiry`, `bhavcopy_option_expiry`, `bhavcopy_option_strike`, `fno_expiry_calendar`, `market_holidays`, `trade_commentary`); a forced push would drop them with real data
- Bench: `npx tsx scripts/verify-auto-trade.ts` (34 checks: gates, symbology, settings, store math, quiet engine pass) — run before trusting a config change or going toward live
