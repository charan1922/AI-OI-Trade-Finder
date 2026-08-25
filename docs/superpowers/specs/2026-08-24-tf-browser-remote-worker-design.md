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
GET /api/tf/cookie  ──── X-TF-Worker-Secret ────▶  main app
        │  (Playwright-ready cookie JSON)
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

- **`GET /api/tf/cookie`** — returns the stored TF cookie, pre-formatted as
  Playwright-ready `{name, value, domain, path, secure, httpOnly, sameSite}[]` JSON
  (the worker needs zero TradeFinder-cookie-format knowledge). Auth: header
  `X-TF-Worker-Secret` must equal env `TF_WORKER_SECRET`. 404/empty if no cookie is
  configured yet (mirrors today's "nothing configured — nothing to do" no-op).
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
  (3× `WATCHDOG_INTERVAL_MS`, so one missed tick doesn't false-alarm but two does).
  The Chromium-launch code in this file is NOT deleted — it becomes the basis for the
  worker (see §4) and stays as documented history of what was tried and why.
- `/tf` page: no UI changes. The "running" badge now reflects remote-worker
  liveness instead of in-process state; everything else (session status, capture
  log, Clear history, Start/Stop) is unchanged in shape.

## 4. The worker (separate deploy target, not part of the Next.js app)

A small standalone Node process — no Next.js, no Prisma, no DB access at all. Adapts
the existing `launch()` / reload / `handleResponse()` skeleton from `browser.ts`
almost as-is (proven code, not a rewrite), with two substitutions:

- Cookie: fetched from `GET {MAIN_APP_URL}/api/tf/cookie` instead of
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
- `/api/tf/cookie` is the more sensitive surface (leaks the live session cookie) —
  HTTPS-only (already enforced site-wide via Caddy), never logged.

## 6. What's buildable/testable now vs. needs the worker host

**Now, no host needed:** `/api/tf/cookie`, `/api/tf/ingest`, the `proxy.ts`
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

## 8. Out of scope

- No change to TF capture cadence, endpoint allowlist, or row-parsing logic anywhere.
- No change to the TF Running Race selector, trade-suggest, or auto-trade — they
  keep reading the same tables, unaware anything moved.
- The three prior in-place fixes (Chromium flags, staggered reload, `nice`) are not
  reverted — they stay as shipped history; they simply stop mattering once Chromium
  no longer runs on this box.
