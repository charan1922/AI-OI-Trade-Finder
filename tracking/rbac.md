# RBAC — two-role access control (admin / viewer)

Added 2026-07-12. Requirement: a **read-only user** who can open every page but
can never change anything, and an **operator (admin)** who can do everything —
designed so real authentication/authorization can slot in later without
rewriting enforcement.

## How it works

**Identity (today):** two ways to authenticate, both mapping a password to a role:

- **Browsers** sign in at **`/login`** (a real page, not the native Basic-Auth
  prompt). `POST /api/auth/login` validates the password and sets a signed
  session cookie (`lib/auth/session.ts`, HMAC keyed on `APP_PASSWORD` — a viewer
  can't forge an admin cookie). A **Sign out** button in the header calls
  `POST /api/auth/logout` to clear it. The login page also has a cosmetic
  **username** field (display-only, stored in a `pr_user` cookie, shown in the
  header greeting — never used for auth).
- **Internal server-to-self calls** (engine.ts / poller.ts) keep sending
  `APP_PASSWORD` as HTTP **Basic Auth**; the proxy accepts that too.

| env var | role | access |
| --- | --- | --- |
| `APP_PASSWORD` | `admin` | everything |
| `APP_READONLY_PASSWORD` | `viewer` | every page + every read API; all actions 403 |
| *(neither set)* | `admin` | gate off — local dev, no `/login`, unchanged |

Password comparison is constant-time (`constantTimeEqual`) so timing can't leak
which password matched.

**Enforcement (three layers, server-authoritative):**

1. **`proxy.ts`** — the choke point every request passes. Resolves the role,
   asks `requiredPermission(method, path, query)` (policy in
   `lib/auth/rbac.ts`), 403s a viewer before the route ever runs, then stamps
   the trusted `x-app-role` header on the forwarded request — **after
   stripping any client-supplied value**, so it can't be spoofed.
2. **Mixed routes** — `POST /api/backtest/tf-validate` serves reads AND writes
   decided by the JSON body, which the proxy can't see. The route itself
   rejects `TF_VALIDATE_WRITE_ACTIONS` ('download', 'download-symbols',
   'download-all-tf') for viewers via `lib/auth/server.ts`.
3. **UI** — `useRole()` (`lib/auth/use-role.ts`, one cached `/api/auth/me`
   fetch per app load) disables action controls with an explanatory tooltip;
   `<ReadOnlyBanner>` on /config. Pure UX — the server never trusts it.

**Future-real-auth seam:** only the role-RESOLUTION step in `proxy.ts` changes
(session/JWT → `Role`); the permission catalog (`Permission`,
`ROLE_PERMISSIONS`), the policy table, and every check site stay as they are.

## The policy (lib/auth/rbac.ts)

Default rules: every page is viewable by every role; every API GET is a read;
every unclassified mutating API falls through to `app:write` — **default-deny**,
so a future POST route is automatically admin-only unless someone consciously
classifies it as a read.

| endpoint | permission | note |
| --- | --- | --- |
| `POST /api/config/toggles` | `config:write` | feature toggles + numeric settings |
| `POST /api/bhavcopy` | `data:sync` | NSE EOD download |
| `POST /api/backtest/download-stream` | `data:sync` | Dhan candle downloads |
| tf-validate download actions | `data:sync` | enforced in-route (body-dependent) |
| `POST /api/fyers/poller` | `poller:control` | pause / resume / run-once |
| `POST /api/fyers/token`, `POST /api/dhan/token` | `token:manage` | force token regeneration |
| `POST /api/trade-commentary` | `ai:generate` | paid MiMo call + persisted row |
| `POST /api/ai-assistant/chat` | `ai:chat` | paid Azure OpenAI call |
| `POST /api/trade-suggest` | `scan:actions` | review/stats operator actions |
| `GET /api/trade-suggest?force=1` | `scan:actions` | window-bypass override |
| any other non-GET `/api/*` | `app:write` | default-deny catch-all |

Deliberate read classifications (viewer-allowed):

- `POST /api/live/quote` — POST-for-payload only; a pure read.
- `GET /api/trade-suggest` (plain) — runs a scan that persists suggestions,
  but the identical scan already runs autonomously in the server poller; a
  viewer's page load adds nothing an admin session wouldn't. Kept a read so
  /trade-suggest works for viewers.
- `GET /api/fyers/poller` — defensively (re)starts the singleton loop;
  idempotent instrumentation behavior, not a user action.
- tf-validate `'backtest'`, `'simulate'`, `'trade-detail'`, … — compute over
  already-stored rows (verified: backtest-evaluator only SELECTs).

## UI touched

- `/config` — switches + steppers disabled, read-only banner.
- `/fyers` — Pause/Resume, Run once, New token disabled (status/refresh live).
- `/data-downloader` — "Sync NSE data" disabled.
- `/trade-viewer` — per-trade "Download SYMBOL" disabled.
- `/trade-commentary` — "Generate now" disabled (stored reads still poll).
- `/trade-assistant` — composer disabled with an explanatory placeholder.

## Files

- `lib/auth/rbac.ts` — roles, permissions, policy, role resolution (runtime-
  agnostic; proxy may run on Edge)
- `lib/auth/server.ts` — trusted-header helpers for mixed routes
- `lib/auth/use-role.ts` — client hook (module-cached, fails open to admin;
  server still enforces)
- `app/api/auth/me/route.ts` — role echo for the UI
- `proxy.ts` — role resolution + policy enforcement + header stamping
- `components/read-only-banner.tsx`
- `lib/env.ts`, `DEPLOY.md` — `APP_READONLY_PASSWORD`

Unaffected by design: the engine/poller's internal self-fetches send
`APP_PASSWORD` (`internalAuthHeaders()` in engine.ts / poller.ts) → admin role;
`/api/health` stays public (keep-alive pinger) with the role header stripped.

## Multi-user / multi-window concurrency (the rate-limit question)

Investigated 2026-07-12 — N parallel browser windows do NOT multiply external
API calls; the server already funnels every external source through singletons:

- **Fyers**: downloads run in the server-side poller singleton
  (`globalThis.__fyersPoller`, started by instrumentation.ts) on a 5-min grid —
  /fyers windows only poll its STATUS (DB/state reads). Overlapping cycles are
  skipped (`cycleRunning` → 'overlap'), so even simultaneous "Run once" clicks
  can't stack Fyers calls.
- **Dhan**: every quote/option-chain call goes through the global serial gate
  in `lib/dhan/market-feed.ts` (globalThis queue, min-interval spacing,
  escalating 429 cooldown) + `lib/dhan/rate-limiter.ts` for data APIs. More
  windows → deeper queue → slower responses, never limit violations.
- **NSE**: pulse feeds share a 30s in-process cache (`lib/nse/pulse-cache.ts`);
  the session cookie is cached 3 min with in-flight dedupe (`lib/nse/client.ts`).
- Residual cost of extra windows is INTERNAL: more scan/quote requests queued
  (latency), not more external calls. The viewer role further reduces this —
  read-only sessions can't trigger run-once/sync/generate at all.
