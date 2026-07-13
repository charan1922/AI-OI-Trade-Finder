# CLAUDE.md — Project-R Simulator

This file extends the parent repo's `../CLAUDE.md` with simulator-specific guidance. Where they conflict, this file wins (the simulator uses **ESLint + Prettier on port 5001**, not Biome/5000; validate with `pnpm lint` and `pnpm typecheck`).

## Authentication (Google via Auth.js + RBAC)

- **Google sign-in is THE browser login** (Auth.js / next-auth v5 — the beta tag is the App Router standard, per `authjs.dev`). Official layout: `auth.ts` (root config), `app/api/auth/[...nextauth]/route.ts` (handlers), `proxy.ts` wraps the existing gate with `auth()` so `req.auth` joins the role resolution.
- **Role policy** (single source: `roleForGoogleEmail()` in `lib/auth/rbac.ts`): `ADMIN_GOOGLE_EMAILS` (charan192219@gmail.com) → admin; ANY other verified Google account → read-only viewer (all mutating actions 403). While the OAuth app is in Google's "Testing" status, only test users added in Google Cloud Console can sign in at all.
- **Break-glass**: the password form is hidden but alive at `/login?password=1` (posts to `/api/auth/login`) — never remove it; it's the operator's way in if Google is down/misconfigured. Internal server-to-self calls (poller/engine) keep using HTTP Basic with `APP_PASSWORD` — untouched by Auth.js.
- **Basic-auth browser detection** (`roleFromBasicAuth` in proxy.ts): must check `sec-fetch-dest`/`sec-fetch-site`, NEVER `sec-fetch-mode` — Node's fetch (undici, ≥18.5) sends `sec-fetch-mode: cors` on every server-side call, so a sec-fetch-mode check silently 401s ALL internal engine/poller self-fetches (scanner, quotes, commentary — caught 2026-07-12 before the first live session on that code).
- **Sessions**: Auth.js uses stateless JWTs (`AUTH_SECRET`) — no DB tables. One sign-out (`/api/auth/logout`) clears both the password cookie and the Auth.js cookies.
- **Users registry** (`lib/auth/users.ts`, table `app_users`, mirrored as `AppUser`): every Google account that signs in is recorded from the root layout (throttled, fire-and-forget) — owner email → role `admin`/plan `owner`; everyone else → `viewer`/`trial` with `subscriptionEndsAt` ready for the future billing step. It's a REGISTRY today: enforcement stays in proxy.ts's email policy; the subscription phase flips role resolution to read this table. Do NOT put DB reads in `auth.ts`/`proxy.ts` — proxy may run on the Edge runtime where better-sqlite3 can't load.
- **Viewer UX rule**: viewers don't see operator action buttons at all (hidden via `useRole().readOnly`, not just disabled) — commentary Generate, bhavcopy Sync, trade-viewer Download, fyers poller/token controls. Enforcement is still the proxy's 403 (default-deny on unclassified mutating APIs); the hiding is UX.
- **Env**: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_SECRET` (all required on Railway too), plus `AUTH_URL=<public origin>` **required in production** — behind Railway's proxy the app sees itself as `0.0.0.0:5001`, and without AUTH_URL, Auth.js sends Google an insecure redirect_uri (Google blocks with `invalid_request`). Google Cloud Console must list `<origin>/api/auth/callback/google` as an authorized redirect URI for `http://localhost:5001` AND the production domain. Redirects in our own routes must be RELATIVE (`Location: /login`), never built from `req.url`.

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
- Max **2 trades/day**, max **2 open lots**, max **₹60k** deployed premium, **₹3k** daily-loss halt (settings-tunable ranges in `lib/auto-trade/settings.ts`)
- Always 1 lot; scanner picks only (the AI cannot choose symbol/strike/size); no re-entry of a symbol the same day; stop moves may only tighten
- Position guard (premium SL/target + spot plan + square-off) runs BEFORE the AI every pass and under the kill switch — deterministic, works with the LLM down

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
