# TF headless-browser relay — move Chromium off the trading box

**Date:** 2026-08-24
**Status:** design approved, not yet implemented
**Operator decisions:** no auto-fallback to local Chromium if the remote worker goes
down (fail closed, matching the existing "no fresh TF board → no entries" behavior);
host is Oracle Cloud Always Free if the debit-card verification goes through,
otherwise an AWS `t3.micro` on the account already in use — either way the AWS-side
design below is identical.

---

## 1. Why

Real historical CPU data settled this, not guesswork: this box averaged ~2.5-4% CPU
on trading days before the TF headless-browser relay (`lib/tf-live/browser.ts`)
existed, and ~37-65% sustained on a clean day after it shipped, with Fyers/Dhan
polling unchanged across both. Three in-place fixes were tried and shipped
(resource-reduction Chromium flags, staggered tab reloads, OS `nice` deprioritization)
— none solved it; a live latency test after the `nice` fix still showed a 13.4s stall
on `GET /api/health` (a handler with zero async work). The browser's own resident
cost (two Chromium renderer processes alive for 6.5 hours) is the problem, and no
in-place scheduling trick removes it on a 2 vCPU / 2GB box that also runs the
trading-critical Next.js process and the Fyers poller.

The fix is architectural: run Chromium somewhere else entirely.

## 2. Shape of the fix

The worker only knows how to run Chromium, inject the TF session cookie, and forward
whatever it sees. It has **zero knowledge of TradeFinder's response schema** — that
stays exactly where it lives today (`lib/tf-live/parse.ts`, `lib/tf-live/endpoints.ts`),
just invoked over HTTP instead of in-process. This was chosen over a design where the
worker parses locally and pushes structured rows, because two copies of TF's schema
drifting apart is exactly the failure class this codebase's own history warns about
(e.g. the `all_sector` schema bug, the two-tabs-one-failure-kills-both bug — both
documented in `lib/tf-live/browser.ts`'s module comments).

```
operator pastes fresh "Copy as cURL" on /tf     (UNCHANGED — one paste point)
        │
        ▼
main app encrypts + stores cookie                (UNCHANGED — saveTfBrowserCookies)
        │
        ▼ (worker polls on its own watchdog loop)
GET /api/tf/worker-config ── X-TF-Worker-Secret ──▶  main app
        │  (cookies + pages + cadence)
        ▼
worker launches Chromium, injects cookie, opens both TF pages, listens for
every response whose URL contains /api_be/
        │
        ▼ (per response)
POST /api/tf/ingest { pathname, status, ok, body } ── X-TF-Worker-Secret ──▶ main app
        │
        ▼
main app: endpointTagFor(pathname) — not tracked → 200 + drop
                                    — tracked     → recordTfLiveCapture(),
                                                     extractRows() + recordTfLiveRows(),
                                                     recordTfBrowserOutcome()
        │
        ▼
EVERYTHING downstream (/tf page, race.ts, trade-suggest selector) reads the same
tables as today. No consumer of TF data changes.
```

## 3. New surface on the main app

- **`GET /api/tf/worker-config`** — returns everything the worker needs to do its job,
  so the worker itself holds no TradeFinder knowledge at all:
  - `cookies` — the stored TF session cookie, pre-formatted as Playwright-ready
    `{name, value, domain, path, secure, httpOnly, sameSite}[]` JSON.
  - `pages` — the list of TF URLs to open (today: `/market-pulse`, `/sector-scope`).
  - `reloadIntervalMs` — the capture cadence.
  - `shouldRun` — whether the worker should have a browser open at all, computed
    server-side as `withinCaptureWindow() || an active manual override`. This
    keeps `/tf`'s existing Start/Stop buttons working against a remote process
    (they move the override; the worker honours it on its next poll) and keeps
    all window logic on the main app rather than duplicating the IST calendar
    into the worker. Faithfully preserves the current quirk that Stop inside the
    capture window only pauses until the next poll — the in-process watchdog
    relaunched it after 60s for the same reason.

  Auth: header `X-TF-Worker-Secret` must equal env `TF_WORKER_SECRET`. Empty
  `cookies` if none configured yet (mirrors today's "nothing configured — nothing to
  do" no-op). The worker re-reads this each cycle, so config changes take effect
  without redeploying it.

  **Why `pages` is served rather than hardcoded in the worker (operator requirement,
  2026-08-24: "I may need more APIs to call"):** capturing an additional TF feed
  should never require touching the worker. Two cases, both main-app-only changes:
  a new endpoint fired by an *already-open* page needs only a `TF_ENDPOINTS` allowlist
  entry (+ a parser if rows are wanted); a feed that lives on a *different TF page*
  needs only that URL added to this `pages` list. Either way the worker is unchanged
  and un-redeployed — it just opens what it's told and forwards what it sees.
- **`POST /api/tf/ingest`** — body `{ pathname: string, status: number, ok: boolean,
  body: unknown }` for any `/api_be/` response the worker saw, OR `{ heartbeat: true
  }` on the worker's own watchdog cadence (reuses `recordTfBrowserOutcome(true)` as
  the liveness signal — no separate heartbeat endpoint). Same secret auth.
- Both routes allowlisted in `proxy.ts` as unauthenticated-at-the-proxy-layer
  (identical precedent to `/api/telegram/webhook` and `/api/health`), verified inside
  the handler, fail-closed if `TF_WORKER_SECRET` is unset in production — same shape
  as `verifyWebhookSecret()` in `lib/telegram/bot.ts`.
- `lib/tf-live/browser.ts`: `startTfBrowserWatchdog()` stops launching Chromium
  locally. `isTfBrowserRunning()` is redefined from "is there a local browser object"
  to "did the worker's heartbeat/ingest traffic arrive within the last 3 minutes"
  (3× the worker's 60s poll, so one missed tick doesn't false-alarm but two does).
- **The local Chromium-launch code is DELETED, not retained as documentation.**
  First draft of this design kept it "as history"; that was wrong on two counts.
  Mechanically, `launch()`/`handleResponse()` become unreachable and
  `@typescript-eslint/no-unused-vars` (via `eslint-config-next/typescript`) fails
  the build. More importantly, an unreachable second copy of the TF response
  handling is precisely the drift risk §2 exists to avoid — `deploy/tf-worker/`
  is the living copy, and git history plus this module's header comment carry the
  reasoning. Retaining dead code that could be silently re-enabled on a box we
  just proved cannot afford it is a hazard, not a record.
- **The consecutive-failure alarm must survive the move.** `handleResponse()`'s
  `CONSECUTIVE_FAILURE_LIMIT` logic (6 rejections in a row → raise
  `recordTfBrowserOutcome(false, …)`) is the fix for the 2026-08-10 incident where
  263 failures hid behind a green badge. It is stateful across requests, so it moves
  into shared state driven by the ingest route — NOT dropped, and not replaced with
  "alarm on every single failure", which would flap on one transient blip.
  Alongside it, `endpointTagFor()` and `extractRows()` move out of `browser.ts`
  into `lib/tf-live/ingest.ts`: they are TF schema/allowlist logic, they no longer
  belong in a module about a browser this app no longer runs, and relocating them
  finally puts the allowlist under CI test.
- `/tf` page: no UI changes. The "running" badge now reflects remote-worker
  liveness instead of in-process state; everything else (session status, capture
  log, Clear history, Start/Stop) is unchanged in shape.

## 4. The worker (separate deploy target, not part of the Next.js app)

A small standalone Node process — no Next.js, no Prisma, no DB access at all. Adapts
the existing `launch()` / reload / `handleResponse()` skeleton from `browser.ts`
almost as-is (proven code, not a rewrite), with two substitutions:

- Cookie + page list: fetched from `GET {MAIN_APP_URL}/api/tf/worker-config` instead of
  `getTfBrowserCookies()` (a local DB read).
- `handleResponse()`'s tail: instead of writing to Prisma, `POST` to
  `{MAIN_APP_URL}/api/tf/ingest`.

Drops the `--js-flags=--max-old-space-size=128` cap (the host has far more headroom
than the 2GB trading box) but keeps `--no-sandbox` / `--disable-dev-shm-usage` for
container stability. No OS-priority tricks needed — nothing else competes for CPU on
this box.

## 5. Failure handling

- Worker can't reach the main app (network blip): retries on its own watchdog cadence,
  same resilience shape `browser.ts`'s watchdog already has.
- Main app sees no ingest/heartbeat traffic for over 3 minutes: **no auto-fallback to
  local Chromium** (operator decision, 2026-08-24). Downstream is already safe — TF board
  staleness (`TF_BOARD_MAX_AGE_MIN`) already refuses stale-board entries; the only new
  thing needed is the `/tf` badge going unhealthy so a human notices.
- `/api/tf/worker-config` is the more sensitive surface (leaks the live session cookie) —
  HTTPS-only (already enforced site-wide via Caddy), never logged.

## 6. What's buildable/testable now vs. needs the worker host

**Now, no host needed:** `/api/tf/worker-config`, `/api/tf/ingest`, the `proxy.ts`
allowlist entries, `browser.ts`'s local-launch removal, `/tf`'s liveness-source
change. All curl/CI-testable against the already-deployed app, same as the three
prior fixes this session.

**Needs the host to exist:** the worker's actual deploy and end-to-end proof (real
Chromium, real cookie, real ingest traffic). Its code can be written and
typechecked/linted now; it cannot be proven working until Oracle or the AWS
`t3.micro` is provisioned.

## 7. Rejected: AWS Lambda (and why the host must have a STABLE IP)

Serverless looks like the natural fit — TF's page fires one burst of requests per load
and then goes silent (documented in `browser.ts`), so a browser that wakes, captures,
and dies matches the workload better than one held open for 6.5 hours. Lambda's free
tier is also genuinely permanent (400,000 GB-seconds/month, does not expire with the
12-month term, verified 2026-08-24). It was still rejected, for a reason that
generalizes to any future host choice:

- **Lambda's outbound IP changes every invocation.** A stable egress IP needs VPC +
  NAT Gateway at ~$33/month — *more* than the `t3.micro` it was meant to undercut, so
  the cost argument inverts.
- **Rotating IPs are a scraping signature aimed at the one feed everything depends
  on.** All TF traffic currently originates from the box's single Elastic IP
  (`3.108.33.64`). TradeFinder already signs this account out roughly daily; a few
  hundred daily requests from a rotating pool of AWS datacenter IPs is materially more
  likely to get the account flagged. TF selection is fail-closed — if TF blocks the
  account, the scanner returns **zero picks** and trading stops entirely. Risking the
  entire selector to save a few dollars a month is the wrong trade.
- Cost headroom was also thinner than first estimated: `@sparticuz/chromium` wants
  **2048MB**, putting a both-pages run at roughly **40-70%** of the monthly free
  allowance depending on cadence — free, but not the comfortable margin an initial
  guess suggested.

**Therefore a requirement, not a preference: the worker host must have a single stable
outbound IP.** Both candidate hosts (Oracle Always Free VM, AWS `t3.micro`) satisfy
this natively. Do not re-propose a rotating-IP host without addressing account-ban
risk first.

## 8. Rejected: shortening the capture window

A cheaper mitigation was offered and **declined** (operator, 2026-08-24): trimming
`CAPTURE_START_MIN`/`CAPTURE_END_MIN` in `lib/tf-live/collector.ts` from 09:22–15:30
to 09:22–13:22 (~35% less browser load) or 09:22–11:30 (~65%, since entries close at
11:00 anyway). It is a one-line change needing no new infrastructure.

Investigated cost, for the record — nothing money-critical depended on afternoon TF
data: entries (09:45–11:00), the 09:35 race baseline, exits/position management (which
never read TF), and the EOD closing snapshot (which derives R-Factor from Fyers
candles via `approximateTfRFactor`, not a late TF capture) are all unaffected. The
losses were `/sector-scope` and `/live`'s TF column going stale after the cutoff,
afternoon commentary losing fresh TF context, and afternoon R-Factor accumulation
history.

Declined because the operator wants the full-day board intact and prefers fixing the
cause rather than reducing the data. Keep the 6h window; do not trim it as a
performance measure.

## 9. Out of scope

- No change to TF capture cadence, endpoint allowlist, or row-parsing logic anywhere.
- No change to the TF Running Race selector, trade-suggest, or auto-trade — they
  keep reading the same tables, unaware anything moved.
- The three prior in-place fixes (Chromium flags, staggered reload, `nice`) are not
  reverted — they stay as shipped history; they simply stop mattering once Chromium
  no longer runs on this box.
