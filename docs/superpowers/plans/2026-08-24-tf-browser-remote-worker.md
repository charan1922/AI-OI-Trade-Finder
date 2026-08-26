# TF Browser Remote Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the TradeFinder headless-Chromium relay off the main AWS trading box to a remote worker, so Chromium stops competing for CPU with the trading app.

**Architecture:** The main app gains two machine-to-machine endpoints — `GET /api/tf/worker-config` (hands the worker its cookie, page list, cadence and a run/stop flag) and `POST /api/tf/ingest` (accepts raw TradeFinder responses + heartbeats). All TradeFinder schema knowledge stays on the main app in `lib/tf-live/`, so capturing a new feed never requires touching the worker. The worker is a dumb Playwright runner: it opens what it is told and forwards what it sees.

**Tech Stack:** Next.js 16 App Router, TypeScript, Prisma + SQLite, Playwright/Chromium, plain-Node `.mjs` for the worker.

**Design spec:** `docs/superpowers/specs/2026-08-24-tf-browser-remote-worker-design.md`

## Global Constraints

- Validate with `pnpm lint` and `pnpm typecheck` — **never** `tsc --noEmit` directly.
- Full CI gate must pass locally before any push: `pnpm lint`, `pnpm typecheck`, `pnpm typecheck:scripts`, `pnpm exec tsx scripts/verify-dependency-hygiene.ts`, `pnpm exec tsx scripts/verify-playwright-pin.ts`, and every `scripts/verify-*.ts` bench.
- **No new third-party dependencies.** `verify-dependency-hygiene.ts` compares every bare import against `package.json`. Ask the operator before adding any package.
- In `scripts/`, load env with `process.loadEnvFile('.env.local')` — **never** `dotenv`.
- Money-touching repo: never `git add`/`commit` without the operator explicitly asking. Passing checks is not permission.
- No auto-fallback to local Chromium. Worker down = capture stops (fail closed).
- Do not change the capture cadence, the endpoint allowlist's *contents*, row-parsing logic, or the 09:22–15:30 capture window.
- Port is **5001**. Repo uses ESLint + Prettier (not Biome).
- Preserve the 2026-08-10 lesson: the failure alarm fires after `CONSECUTIVE_FAILURE_LIMIT` (6) rejections **regardless of whether an earlier request succeeded**, and never on a single transient blip.

---

### Task 1: Pure worker wire-contract module + CI bench

Auth, liveness and body validation are pure and DB-free, so they are verified in CI rather than only claimed. Deliberately **import-free**: `lib/env.ts` parses at import and throws without credentials, which would make a DB-free bench unrunnable. Precedent: `lib/tf-live/store.ts` reads `TF_LIVE_SESSION_KEY` straight from `process.env` and is likewise absent from `env.ts`.

**Files:**
- Create: `lib/tf-live/worker-protocol.ts`
- Create: `scripts/verify-tf-worker-protocol.ts`
- Modify: `.github/workflows/build-image.yml`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `WORKER_SECRET_HEADER: 'x-tf-worker-secret'`
  - `WORKER_LIVENESS_MS: number` (180000)
  - `verifyWorkerSecret(supplied: string | null, expected: string | undefined, isProduction: boolean): boolean`
  - `isWorkerAlive(lastSeenAtMs: number | null, nowMs: number): boolean`
  - `type TfIngestPayload = { kind: 'heartbeat' } | { kind: 'response'; pathname: string; status: number; ok: boolean; body: unknown }`
  - `parseIngestPayload(raw: unknown): { payload: TfIngestPayload } | { error: string }`

- [ ] **Step 1: Write the failing bench**

Create `scripts/verify-tf-worker-protocol.ts`:

```ts
import {
  WORKER_LIVENESS_MS,
  WORKER_SECRET_HEADER,
  isWorkerAlive,
  parseIngestPayload,
  verifyWorkerSecret,
} from '@/lib/tf-live/worker-protocol';

let failures = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function main(): void {
  // ── Secret verification must FAIL CLOSED: this guards the endpoint that
  //    serves the live TradeFinder session cookie. ──
  check('header name is lowercase (Next normalizes incoming headers)', WORKER_SECRET_HEADER === 'x-tf-worker-secret');
  check('matching secret is accepted', verifyWorkerSecret('s3cret', 's3cret', true));
  check('wrong secret is rejected', !verifyWorkerSecret('nope', 's3cret', true));
  check('null supplied secret is rejected', !verifyWorkerSecret(null, 's3cret', true));
  check('empty supplied secret is rejected', !verifyWorkerSecret('', 's3cret', true));
  check('unset secret in PRODUCTION rejects everything', !verifyWorkerSecret('anything', undefined, true));
  check('unset secret in production rejects null too', !verifyWorkerSecret(null, undefined, true));
  check('empty-string secret is treated as unset, not a valid password', !verifyWorkerSecret('', '', true));
  // Local dev with no secret stays usable — the same concession
  // verifyWebhookSecret() makes in lib/telegram/bot.ts.
  check('unset secret in DEV allows the local worker', verifyWorkerSecret('anything', undefined, false));

  // ── Liveness replaces "is there a local browser object". ──
  const now = 1_700_000_000_000;
  check('never-seen worker is not alive', !isWorkerAlive(null, now));
  check('just-seen worker is alive', isWorkerAlive(now - 1_000, now));
  check('one missed 60s poll does not false-alarm', isWorkerAlive(now - 90_000, now));
  check('liveness window is 3 minutes', WORKER_LIVENESS_MS === 180_000);
  check('stale beyond the window is not alive', !isWorkerAlive(now - WORKER_LIVENESS_MS - 1, now));
  check('exactly at the boundary is still alive', isWorkerAlive(now - WORKER_LIVENESS_MS, now));
  check('a future timestamp is not trusted', !isWorkerAlive(now + 60_000, now));
  check('non-finite last-seen fails closed', !isWorkerAlive(Number.NaN, now));

  // ── Ingest body validation: garbage must not reach the store layer. ──
  const heartbeat = parseIngestPayload({ heartbeat: true });
  check('heartbeat parses', 'payload' in heartbeat && heartbeat.payload.kind === 'heartbeat');

  const response = parseIngestPayload({
    pathname: '/api_be/data/order/all_sector',
    status: 200,
    ok: true,
    body: { status: 'SUCCESS' },
  });
  check(
    'well-formed response keeps its fields',
    'payload' in response &&
      response.payload.kind === 'response' &&
      response.payload.pathname === '/api_be/data/order/all_sector' &&
      response.payload.status === 200 &&
      response.payload.ok === true,
  );

  check('null body is rejected', 'error' in parseIngestPayload(null));
  check('a bare string is rejected', 'error' in parseIngestPayload('all_sector'));
  check('an array is rejected', 'error' in parseIngestPayload([{ pathname: '/api_be/x' }]));
  check('missing pathname is rejected', 'error' in parseIngestPayload({ status: 200, ok: true, body: {} }));
  check(
    'non-string pathname is rejected',
    'error' in parseIngestPayload({ pathname: 42, status: 200, ok: true, body: {} }),
  );
  check(
    'non-numeric status is rejected',
    'error' in parseIngestPayload({ pathname: '/api_be/x', status: 'ok', ok: true, body: {} }),
  );
  check(
    'an over-long pathname is rejected',
    'error' in parseIngestPayload({ pathname: `/api_be/${'x'.repeat(4_000)}`, status: 200, ok: true, body: {} }),
  );
  check(
    'ok is derived from status when omitted',
    (() => {
      const parsed = parseIngestPayload({ pathname: '/api_be/x', status: 503, body: {} });
      return 'payload' in parsed && parsed.payload.kind === 'response' && parsed.payload.ok === false;
    })(),
  );
}

main();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
```

- [ ] **Step 2: Run the bench to verify it fails**

Run: `pnpm exec tsx scripts/verify-tf-worker-protocol.ts`
Expected: FAIL — cannot resolve `@/lib/tf-live/worker-protocol`.

- [ ] **Step 3: Write the implementation**

Create `lib/tf-live/worker-protocol.ts`:

```ts
/**
 * Wire contract between the main app and the REMOTE TradeFinder browser worker.
 *
 * WHY THE WORKER IS REMOTE — real historical CPU data (2026-08-24): this box
 * averaged ~2.5-4% CPU on trading days before the in-process browser relay
 * existed and ~37-65% sustained afterwards, with Fyers/Dhan polling unchanged.
 * Three in-place mitigations shipped (Chromium resource flags v1.55.5,
 * staggered tab reloads v1.55.6, OS `nice` v1.55.7) and none fixed it — a
 * latency probe after the last still caught a 13.4s stall on GET /api/health,
 * a handler that does no async work at all.
 *
 * LEAF MODULE ON PURPOSE: no imports whatsoever. `lib/env.ts` parses at import
 * and throws without credentials, so importing it here would make the DB-free
 * CI bench unrunnable. The secret is read from `process.env` by the route
 * handlers and passed IN, which also keeps every rule below a pure function —
 * same precedent as lib/tf-live/store.ts reading TF_LIVE_SESSION_KEY directly.
 */

/** Lowercase: Next.js normalizes incoming header names. */
export const WORKER_SECRET_HEADER = 'x-tf-worker-secret';

/** Longest gap in worker traffic still reported as healthy on /tf. Three times
 *  the worker's own 60s poll, so ONE missed poll does not raise a false alarm
 *  but two consecutive ones do. */
export const WORKER_LIVENESS_MS = 3 * 60_000;

/** TradeFinder's real paths are ~40 characters; anything near this ceiling is a
 *  bug or an attack, not data. */
const MAX_PATHNAME_LENGTH = 512;

/**
 * A constant-time compare is deliberately not used: the realistic threat here is
 * not a timing side channel on a long random secret, it is an UNSET secret
 * silently admitting everyone. So `expected` unset in PRODUCTION rejects every
 * request rather than opening `/api/tf/worker-config` — which serves the live
 * TradeFinder session cookie — to the internet. Non-production keeps working
 * unconfigured, exactly the concession `verifyWebhookSecret()` makes in
 * lib/telegram/bot.ts.
 */
export function verifyWorkerSecret(
  supplied: string | null,
  expected: string | undefined,
  isProduction: boolean,
): boolean {
  if (!expected) return !isProduction;
  if (!supplied) return false;
  return supplied === expected;
}

/**
 * True while the remote worker counts as alive — the replacement for the old
 * "is there a local Playwright Browser object" check behind
 * `isTfBrowserRunning()`.
 *
 * A FUTURE timestamp fails closed rather than reading as alive forever: a
 * clock-skewed or spoofed value must not be able to pin the /tf badge green.
 */
export function isWorkerAlive(lastSeenAtMs: number | null, nowMs: number): boolean {
  if (lastSeenAtMs == null || !Number.isFinite(lastSeenAtMs)) return false;
  const age = nowMs - lastSeenAtMs;
  return age >= 0 && age <= WORKER_LIVENESS_MS;
}

/** One thing the worker sends: either a TradeFinder response it observed, or a
 *  liveness ping when it saw nothing worth forwarding. */
export type TfIngestPayload =
  | { kind: 'heartbeat' }
  | { kind: 'response'; pathname: string; status: number; ok: boolean; body: unknown };

/**
 * Validate an ingest body before any of it reaches the store layer. Returns a
 * discriminated result rather than throwing, so the route answers 400 with a
 * reason instead of 500-ing on malformed input.
 *
 * `body` stays `unknown` on purpose — this app, not the worker, owns
 * TradeFinder's schema, so the payload passes through to the existing parsers
 * untouched.
 */
export function parseIngestPayload(raw: unknown): { payload: TfIngestPayload } | { error: string } {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'body must be a JSON object' };
  }
  const input = raw as Record<string, unknown>;

  if (input.heartbeat === true) return { payload: { kind: 'heartbeat' } };

  const { pathname, status } = input;
  if (typeof pathname !== 'string' || pathname.length === 0) {
    return { error: 'pathname must be a non-empty string' };
  }
  if (pathname.length > MAX_PATHNAME_LENGTH) {
    return { error: `pathname exceeds ${MAX_PATHNAME_LENGTH} characters` };
  }
  if (typeof status !== 'number' || !Number.isFinite(status)) {
    return { error: 'status must be a finite number' };
  }
  // The worker already knows whether its fetch succeeded, but deriving it from
  // the status code when absent keeps a partial payload usable.
  const ok = typeof input.ok === 'boolean' ? input.ok : status >= 200 && status < 300;
  return { payload: { kind: 'response', pathname, status, ok, body: input.body } };
}
```

- [ ] **Step 4: Run the bench to verify it passes**

Run: `pnpm exec tsx scripts/verify-tf-worker-protocol.ts`
Expected: every line `PASS`, then `ALL CHECKS PASSED`, exit 0.

- [ ] **Step 5: Wire the bench into CI**

In `.github/workflows/build-image.yml`, in the `validate` job immediately after the `verify-playwright-pin.ts` step, add:

```yaml
      # DB-free checks for the remote TF worker's wire contract: the shared
      # secret fails CLOSED when unset in production (that endpoint serves the
      # live TradeFinder session cookie), worker liveness distrusts future
      # timestamps, and malformed ingest bodies are rejected before reaching the
      # store layer.
      - run: pnpm exec tsx scripts/verify-tf-worker-protocol.ts
```

- [ ] **Step 6: Run the local CI gate**

```bash
pnpm typecheck && pnpm typecheck:scripts && pnpm lint
pnpm exec tsx scripts/verify-dependency-hygiene.ts
pnpm exec tsx scripts/verify-tf-worker-protocol.ts
```
Expected: clean; hygiene confirms no new dependencies.

- [ ] **Step 7: Stop and report — do not commit**

---

### Task 2: Move the TF schema/allowlist logic into its own module + bench it

`endpointTagFor()` and `extractRows()` are TradeFinder schema logic that currently live in `browser.ts`. They no longer belong in a module about a browser this app does not run, and relocating them finally puts the **allowlist** and the **2026-08-10 consecutive-failure rule** under CI test — neither has ever had coverage.

**Files:**
- Create: `lib/tf-live/ingest.ts`
- Create: `scripts/verify-tf-ingest.ts`
- Modify: `lib/tf-live/browser.ts` (remove the two moved functions and the now-unused `ALLOWED_TAGS`/`TF_ENDPOINTS` import)
- Modify: `.github/workflows/build-image.yml`

**Interfaces:**
- Consumes: existing `TF_ENDPOINTS` (`lib/tf-live/endpoints.ts`), `parseAllSector`/`parseDailyIndex` (`lib/tf-live/parse.ts`).
- Produces:
  - `endpointTagFor(pathname: string): string | null`
  - `extractRows(tag: string, payload: unknown): unknown[] | undefined`
  - `type TfResponseVerdict = { outcome: 'success' } | { outcome: 'rejected'; detail: string }`
  - `classifyTfResponse(ok: boolean, status: number, body: unknown): TfResponseVerdict`
  - `CONSECUTIVE_FAILURE_LIMIT: number` (6)
  - `failureAlarmMessage(consecutiveFailures: number, sawFirstSuccess: boolean, detail: string): string | null`

- [ ] **Step 1: Write the failing bench**

Create `scripts/verify-tf-ingest.ts`:

```ts
import {
  CONSECUTIVE_FAILURE_LIMIT,
  classifyTfResponse,
  endpointTagFor,
  extractRows,
  failureAlarmMessage,
} from '@/lib/tf-live/ingest';

let failures = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function main(): void {
  // ── The allowlist IS the security boundary for what gets stored. ──
  check('all_sector maps from its real path', endpointTagFor('/api_be/data/order/all_sector') === 'all_sector');
  check('daily-index maps from its real path', endpointTagFor('/api_be/data/order/daily-index') === 'daily-index');
  // market_pulse sits directly under /api_be/, not /api_be/data/order/ — that
  // inconsistency is TradeFinder's layout, so it must be handled, not assumed away.
  check('market_pulse maps from its shallower path', endpointTagFor('/api_be/data/market_pulse') === 'market_pulse');
  // Real traffic the page fires that nobody in this app reads.
  check('servertime is not tracked', endpointTagFor('/api_be/servertime') === null);
  check('feature_flag is not tracked', endpointTagFor('/api_be/feature_flag/feature_read') === null);
  check('rfactor_data is not tracked', endpointTagFor('/api_be/rfactor_filter/rfactor_data') === null);
  // TF's OWN sector_scope endpoint is unrelated to this app's /sector-scope page.
  check("TF's own sector_scope is not tracked", endpointTagFor('/api_be/data/order/sector_scope') === null);
  check('a non-api_be path is not tracked', endpointTagFor('/market-pulse') === null);
  check('an empty pathname is not tracked', endpointTagFor('') === null);

  // ── Response classification: TF answers HTTP 200 with a failure BODY. ──
  check(
    'a real success is a success',
    classifyTfResponse(true, 200, { status: 'SUCCESS' }).outcome === 'success',
  );
  const tokenError = classifyTfResponse(true, 200, {
    status: 'TOKEN_ERROR',
    code: 'TOKEN_ERROR',
    message: 'UNAUTHORISED',
  });
  check(
    'HTTP 200 with a TOKEN_ERROR body is a REJECTION, not a success',
    tokenError.outcome === 'rejected',
  );
  check(
    'the rejection names TF’s own code and message',
    tokenError.outcome === 'rejected' && tokenError.detail.includes('TOKEN_ERROR') && tokenError.detail.includes('UNAUTHORISED'),
  );
  const http500 = classifyTfResponse(false, 500, null);
  check('a transport failure is a rejection', http500.outcome === 'rejected');
  check(
    'a rejection with no code falls back to the status',
    http500.outcome === 'rejected' && http500.detail.includes('500'),
  );
  check('a null body is never read as success', classifyTfResponse(true, 200, null).outcome === 'rejected');
  check(
    'a missing status field is never read as success',
    classifyTfResponse(true, 200, { data: [] }).outcome === 'rejected',
  );
  check(
    'lowercase "success" is not accepted (TF sends uppercase)',
    classifyTfResponse(true, 200, { status: 'success' }).outcome === 'rejected',
  );

  // ── The 2026-08-10 lesson, now actually tested. ──
  check('limit is 6', CONSECUTIVE_FAILURE_LIMIT === 6);
  check('one transient failure raises no alarm', failureAlarmMessage(1, true, 'HTTP 500') === null);
  check(
    'below the limit raises no alarm',
    failureAlarmMessage(CONSECUTIVE_FAILURE_LIMIT - 1, true, 'HTTP 500') === null,
  );
  // THE BUG: this used to be suppressed once any request had ever succeeded, so
  // 263 consecutive failures over 3h20m hid behind a green badge.
  const midSession = failureAlarmMessage(CONSECUTIVE_FAILURE_LIMIT, true, 'TOKEN_ERROR: UNAUTHORISED');
  check('at the limit AFTER an earlier success, the alarm STILL fires', midSession !== null);
  check(
    'the mid-session message says it was working earlier',
    midSession != null && /earlier/i.test(midSession),
  );
  const neverWorked = failureAlarmMessage(CONSECUTIVE_FAILURE_LIMIT, false, 'TOKEN_ERROR: UNAUTHORISED');
  check('at the limit with no success ever, the alarm fires', neverWorked !== null);
  check(
    'the never-worked message says it looks logged out',
    neverWorked != null && /logged out/i.test(neverWorked),
  );
  check(
    'both messages tell the operator the fix (paste a fresh cURL)',
    midSession != null && neverWorked != null && /cURL/i.test(midSession) && /cURL/i.test(neverWorked),
  );
  check('past the limit keeps alarming', failureAlarmMessage(CONSECUTIVE_FAILURE_LIMIT + 20, true, 'x') !== null);

  // ── Row extraction stays delegated to the confirmed parsers. ──
  check('an unparsed feed yields no rows', extractRows('market_pulse', { status: 'SUCCESS' }) === undefined);
  check('a garbage all_sector payload yields no rows', extractRows('all_sector', { nope: true }) === undefined);
  check('an unknown tag yields no rows', extractRows('not_a_feed', {}) === undefined);
}

main();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
```

- [ ] **Step 2: Run the bench to verify it fails**

Run: `pnpm exec tsx scripts/verify-tf-ingest.ts`
Expected: FAIL — cannot resolve `@/lib/tf-live/ingest`.

- [ ] **Step 3: Write the implementation**

Create `lib/tf-live/ingest.ts`. The bodies of `endpointTagFor` and `extractRows` are **moved verbatim** from `lib/tf-live/browser.ts` — they encode a schema confirmed against real payloads and must not be rewritten:

```ts
/**
 * What a captured TradeFinder response MEANS. Everything here used to live in
 * lib/tf-live/browser.ts, driven by an in-process Playwright listener; it now
 * serves POST /api/tf/ingest, driven by the remote worker.
 *
 * THIS IS THE ONLY COPY, ON PURPOSE. The worker forwards raw responses and
 * makes no judgement about them, so TradeFinder's schema, the endpoint
 * allowlist and the success/rejection rule exist here and nowhere else — two
 * drifting copies of a schema is the failure this whole design avoids (and the
 * one that already swapped param_2/param_3 once).
 */
import { TF_ENDPOINTS } from '@/lib/tf-live/endpoints';
import { parseAllSector, parseDailyIndex } from '@/lib/tf-live/parse';

/** ONLY these get stored — see lib/tf-live/endpoints.ts's module note for why
 *  the list is exactly these three. Everything else the page fires
 *  (admin/users/check_signal, feature_flag/feature_read,
 *  rfactor_filter/rfactor_data, servertime, TradeFinder's OWN sector_scope) is
 *  real traffic nobody in this app reads, and is dropped before it can reach
 *  the database. */
const ALLOWED_TAGS = new Set<string>(TF_ENDPOINTS);

/**
 * Map a TradeFinder request path to the endpoint tag the rest of the app reads
 * from tf_live_captures. Keeps the SAME tags the original fetch-based collector
 * used ('all_sector', 'daily-index', 'market_pulse') so race.ts / snapshot.ts /
 * the EOD page need no changes. Returns null for anything not in ALLOWED_TAGS.
 */
export function endpointTagFor(pathname: string): string | null {
  let tag: string;
  if (pathname.endsWith('/data/order/all_sector')) tag = 'all_sector';
  else if (pathname.endsWith('/data/order/daily-index')) tag = 'daily-index';
  else {
    const marker = '/api_be/';
    const at = pathname.indexOf(marker);
    tag = at >= 0 ? pathname.slice(at + marker.length) : pathname;
  }
  return ALLOWED_TAGS.has(tag) ? tag : null;
}

/** Best-effort parse into tf_live_rows for the two feeds with a confirmed
 *  schema. `market_pulse` is still fully captured via payloadJson — see
 *  endpoints.ts's module note on why it has no parser yet. */
export function extractRows(tag: string, payload: unknown): unknown[] | undefined {
  if (tag === 'all_sector') {
    const rows = parseAllSector(payload);
    return rows.length > 0 ? rows : undefined;
  }
  if (tag === 'daily-index') {
    const rows = parseDailyIndex(payload);
    return rows.length > 0 ? rows.map((r) => ({ symbol: r.name, value: r.value })) : undefined;
  }
  return undefined;
}

export type TfResponseVerdict = { outcome: 'success' } | { outcome: 'rejected'; detail: string };

/**
 * Whether TradeFinder actually served data.
 *
 * CRITICAL: TF answers **HTTP 200 with a failure body** when the session lapses
 * (`{ status: 'TOKEN_ERROR', message: 'UNAUTHORISED' }`), so the HTTP status
 * alone cannot be trusted and `status === 'SUCCESS'` in the body is the real
 * test. This is why the worker cannot make this call itself — it would have to
 * know TF's schema.
 */
export function classifyTfResponse(ok: boolean, status: number, body: unknown): TfResponseVerdict {
  const shape = body as { status?: string; code?: string; message?: string } | null;
  if (ok && shape?.status === 'SUCCESS') return { outcome: 'success' };
  const detail = shape?.code ? `${shape.code}: ${shape.message ?? 'rejected'}` : `HTTP ${status}`;
  return { outcome: 'rejected', detail };
}

/** After this many consecutive rejections the session is treated as broken
 *  rather than "still warming up". One transient blip must not raise it. */
export const CONSECUTIVE_FAILURE_LIMIT = 6;

/**
 * The operator-facing alarm text, or null while still under the limit.
 *
 * NOTE WHAT IS DELIBERATELY ABSENT: this does NOT stop firing once a request
 * has previously succeeded. That suppression is exactly the 2026-08-10 bug —
 * captures ran cleanly until 12:10 IST, TradeFinder then rejected every request
 * for 3h20m (263 of them), and because the morning had succeeded the alarm
 * stayed silent and /tf showed a green "browser running" badge the whole time.
 * The operator's report was "it failed, I could not know the reason".
 * TradeFinder signs this account out roughly daily INCLUDING mid-session, so
 * mid-session death is the NORMAL failure, not the exotic one. `sawFirstSuccess`
 * only chooses the wording.
 */
export function failureAlarmMessage(
  consecutiveFailures: number,
  sawFirstSuccess: boolean,
  detail: string,
): string | null {
  if (consecutiveFailures < CONSECUTIVE_FAILURE_LIMIT) return null;
  return sawFirstSuccess
    ? `TradeFinder signed this session out mid-session — it was capturing fine earlier today, then rejected ${consecutiveFailures} requests in a row (${detail}). Paste a fresh "Copy as cURL" below to resume.`
    : `the injected session looks logged out (repeated rejections with zero successes, ${detail}) — paste a fresh "Copy as cURL" on /tf`;
}
```

- [ ] **Step 4: Delete the moved functions from `lib/tf-live/browser.ts`**

Remove from `browser.ts`: the `endpointTagFor` function, the `extractRows` function, the `ALLOWED_TAGS` const, the `CONSECUTIVE_FAILURE_LIMIT` const, and the now-unused imports (`TF_ENDPOINTS` from endpoints.ts, and `parseAllSector`/`parseDailyIndex` from parse.ts).

Leave `handleResponse` otherwise untouched — Task 5 deletes it. It still references all three moved names, so import exactly these (a transient state that lasts one task):

```ts
import { CONSECUTIVE_FAILURE_LIMIT, endpointTagFor, extractRows } from '@/lib/tf-live/ingest';
```

Do **not** import `classifyTfResponse`/`failureAlarmMessage` here: `handleResponse` carries its own inline copies of that logic and is about to be deleted, so wiring it to the new helpers is churn. Nothing else in `browser.ts` uses them — importing them now would fail `no-unused-vars`.

- [ ] **Step 5: Run the bench and the gate**

```bash
pnpm exec tsx scripts/verify-tf-ingest.ts
pnpm typecheck && pnpm typecheck:scripts && pnpm lint
```
Expected: bench all `PASS`; typecheck/lint clean (no unused imports left in `browser.ts`).

- [ ] **Step 6: Wire the bench into CI**

In `.github/workflows/build-image.yml`, directly after the `verify-tf-worker-protocol.ts` step:

```yaml
      # DB-free checks for what a captured TradeFinder response MEANS: the
      # endpoint allowlist (untracked feeds never reach the DB), the fact that
      # TF answers HTTP 200 with a TOKEN_ERROR body, and the consecutive-failure
      # alarm that must fire even after an earlier success (the 2026-08-10
      # incident: 263 failures behind a green badge).
      - run: pnpm exec tsx scripts/verify-tf-ingest.ts
```

- [ ] **Step 7: Stop and report — do not commit**

---

### Task 3: `GET /api/tf/worker-config`

**Files:**
- Create: `app/api/tf/worker-config/route.ts`
- Modify: `proxy.ts` (allowlist, beside the `/api/telegram/webhook` entry ~line 125)
- Modify: `lib/tf-live/browser.ts` (add worker state + two helpers)

**Interfaces:**
- Consumes: `verifyWorkerSecret`, `WORKER_SECRET_HEADER` (Task 1); existing `getTfBrowserCookies()`, `cookieHeaderToPlaywrightCookies()`, `withinCaptureWindow()`.
- Produces:
  - `noteWorkerSeen(): void` and `shouldWorkerRun(): boolean` from `lib/tf-live/browser.ts`
  - Response `{ shouldRun: boolean; cookies: PlaywrightCookie[]; pages: string[]; reloadIntervalMs: number }`

- [ ] **Step 1: Add worker state to `lib/tf-live/browser.ts`**

Add `lastWorkerSeenAtMs: number | null;` to the `BrowserState` interface, add `lastWorkerSeenAtMs: null,` to the `store.__tfBrowserState ??= { ... }` initializer, and add `store.__tfBrowserState.lastWorkerSeenAtMs ??= null;` beside the existing `??=` back-compat lines.

Then add, directly above `isTfBrowserRunning`:

```ts
/** Every worker request — config poll, ingest, heartbeat — refreshes this. It
 *  is the ONLY liveness signal now that no local browser object exists.
 *  In-memory on purpose: a restart clears it and the worker re-checks in within
 *  one poll, so persisting it would only preserve a stale claim. */
export function noteWorkerSeen(): void {
  state().lastWorkerSeenAtMs = Date.now();
}

/**
 * Whether the REMOTE worker should have a browser open right now — the same
 * rule the in-process watchdog applied to itself: inside the capture window, or
 * an active manual override from /tf's "Start now".
 *
 * Computed here rather than in the worker so the IST trading calendar is not
 * duplicated onto another host. Note the faithfully-preserved quirk: pressing
 * Stop inside the capture window only pauses until the next poll, because
 * `withinCaptureWindow()` is true again by then — exactly how the in-process
 * version behaved (its 60s watchdog relaunched it). Stop remains an off-hours
 * testing control, not a market-hours kill switch. Not changed here.
 */
export function shouldWorkerRun(): boolean {
  const s = state();
  const manualActive = s.manualUntilMs != null && Date.now() < s.manualUntilMs;
  return manualActive || withinCaptureWindow();
}
```

- [ ] **Step 2: Write the route**

Create `app/api/tf/worker-config/route.ts`:

```ts
/**
 * Everything the REMOTE TradeFinder browser worker needs, in one poll.
 *
 * UNAUTHENTICATED AT THE PROXY (allowlisted in proxy.ts) because the caller is a
 * machine with no browser session — same precedent as /api/telegram/webhook.
 * Auth is the X-TF-Worker-Secret header, verified here and FAILING CLOSED when
 * TF_WORKER_SECRET is unset in production: this response contains the live
 * TradeFinder session cookie.
 *
 * `pages` is served rather than compiled into the worker so that capturing an
 * additional TradeFinder feed stays a main-app-only change (operator
 * requirement, 2026-08-24) — the worker opens what it is told and forwards what
 * it sees, and never needs redeploying for a new feed.
 */
import { NextResponse } from 'next/server';

import { noteWorkerSeen, shouldWorkerRun } from '@/lib/tf-live/browser';
import { cookieHeaderToPlaywrightCookies } from '@/lib/tf-live/parse-curl';
import { getTfBrowserCookies } from '@/lib/tf-live/store';
import { verifyWorkerSecret, WORKER_SECRET_HEADER } from '@/lib/tf-live/worker-protocol';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The TradeFinder pages the worker opens. Each fires a different subset of the
 *  feeds endpoints.ts allowlists: /market-pulse fires `market_pulse`;
 *  /sector-scope fires `all_sector` AND `daily-index`. */
const TF_PAGES = ['https://tradefinder.in/market-pulse', 'https://tradefinder.in/sector-scope'];
/** Passed to addCookies as `url` — see parse-curl.ts on why `__Secure-`/
 *  `__Host-` prefixed cookies reject an explicit Domain. */
const SITE_URL = 'https://tradefinder.in/';
/** How often the worker reloads each page. Matches the in-process relay's
 *  cadence: TradeFinder's page fires one round of requests per load and then
 *  goes silent, so the reload IS the capture tick. */
const RELOAD_INTERVAL_MS = 90_000;

export async function GET(req: Request): Promise<Response> {
  const supplied = req.headers.get(WORKER_SECRET_HEADER);
  if (!verifyWorkerSecret(supplied, process.env.TF_WORKER_SECRET, process.env.NODE_ENV === 'production')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  noteWorkerSeen();

  try {
    const cookieHeader = await getTfBrowserCookies();
    return NextResponse.json({
      shouldRun: shouldWorkerRun(),
      // Empty rather than an error when nothing is pasted yet — mirrors the old
      // in-process "nothing configured — nothing to do" no-op.
      cookies: cookieHeader ? cookieHeaderToPlaywrightCookies(cookieHeader, SITE_URL) : [],
      pages: TF_PAGES,
      reloadIntervalMs: RELOAD_INTERVAL_MS,
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 3: Allowlist both worker routes in `proxy.ts`**

Directly below the existing `/api/telegram/webhook` allowlist line (~line 125):

```ts
  // Remote TF browser worker — a machine with no browser session calls these;
  // auth is the X-TF-Worker-Secret header (verified in the route handlers, and
  // fails closed when TF_WORKER_SECRET is unset in production).
  if (pathname === '/api/tf/worker-config' || pathname === '/api/tf/ingest') {
    return forwardUnauthenticated(req);
  }
```

- [ ] **Step 4: Prove the secret gate refuses**

Add `TF_WORKER_SECRET=testsecret` to `.env.local`, run `pnpm dev`, then:

```bash
curl -s -o /dev/null -w "no-header=%{http_code}\n" http://localhost:5001/api/tf/worker-config
curl -s -o /dev/null -w "wrong=%{http_code}\n" -H "X-TF-Worker-Secret: nope" http://localhost:5001/api/tf/worker-config
curl -s -H "X-TF-Worker-Secret: testsecret" http://localhost:5001/api/tf/worker-config
```
Expected: `no-header=403`, `wrong=403`, then 200 JSON with `shouldRun`, `cookies`, `pages`, `reloadIntervalMs`.

- [ ] **Step 5: Run the local CI gate**

```bash
pnpm typecheck && pnpm typecheck:scripts && pnpm lint
pnpm exec tsx scripts/verify-dependency-hygiene.ts
pnpm exec tsx scripts/verify-tf-worker-protocol.ts && pnpm exec tsx scripts/verify-tf-ingest.ts
```

- [ ] **Step 6: Stop and report — do not commit**

---

### Task 4: `POST /api/tf/ingest`

Thin route: validate, classify with Task 2's pure logic, store via the existing functions.

**Files:**
- Create: `app/api/tf/ingest/route.ts`
- Modify: `lib/tf-live/browser.ts` (export failure-counter helpers)

**Interfaces:**
- Consumes: `parseIngestPayload`, `verifyWorkerSecret`, `WORKER_SECRET_HEADER` (Task 1); `endpointTagFor`, `extractRows`, `classifyTfResponse`, `failureAlarmMessage` (Task 2); `noteWorkerSeen` (Task 3); existing `recordTfLiveCapture`, `recordTfLiveRows`, `recordTfBrowserOutcome`.
- Produces: `noteCaptureFailure(): { consecutiveFailures: number; sawFirstSuccess: boolean }` and `noteCaptureSuccess(): void` from `lib/tf-live/browser.ts`.

- [ ] **Step 1: Add the failure-counter helpers to `lib/tf-live/browser.ts`**

The counter must persist across requests, so it lives in the existing `consecutiveFailures` / `sawFirstSuccess` state fields. Add:

```ts
/** One rejection observed. Returns the running counters so the caller can ask
 *  failureAlarmMessage() whether this crosses into an alarm. Stateful across
 *  requests on purpose — a single transient blip must not raise it. */
export function noteCaptureFailure(): { consecutiveFailures: number; sawFirstSuccess: boolean } {
  const s = state();
  s.consecutiveFailures += 1;
  return { consecutiveFailures: s.consecutiveFailures, sawFirstSuccess: s.sawFirstSuccess };
}

/** One good capture — clears the streak. */
export function noteCaptureSuccess(): void {
  const s = state();
  s.consecutiveFailures = 0;
  s.sawFirstSuccess = true;
}
```

- [ ] **Step 2: Write the route**

Create `app/api/tf/ingest/route.ts`:

```ts
/**
 * Ingest point for the REMOTE TradeFinder browser worker.
 *
 * The worker forwards EVERY response whose URL contains /api_be/ and judges
 * none of them — this handler applies the same allowlist, the same
 * success/rejection rule and the same parsers the in-process relay used, so
 * TradeFinder's schema lives in exactly one place (lib/tf-live/ingest.ts). A
 * payload for a feed nobody reads is answered 200 and dropped, matching the old
 * behaviour where such traffic never reached the database.
 *
 * UNAUTHENTICATED AT THE PROXY (allowlisted in proxy.ts); auth is the
 * X-TF-Worker-Secret header, failing closed when unset in production.
 */
import { NextResponse } from 'next/server';

import {
  noteCaptureFailure,
  noteCaptureSuccess,
  noteWorkerSeen,
} from '@/lib/tf-live/browser';
import {
  classifyTfResponse,
  endpointTagFor,
  extractRows,
  failureAlarmMessage,
} from '@/lib/tf-live/ingest';
import { recordTfBrowserOutcome, recordTfLiveCapture, recordTfLiveRows } from '@/lib/tf-live/store';
import { parseIngestPayload, verifyWorkerSecret, WORKER_SECRET_HEADER } from '@/lib/tf-live/worker-protocol';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const supplied = req.headers.get(WORKER_SECRET_HEADER);
  if (!verifyWorkerSecret(supplied, process.env.TF_WORKER_SECRET, process.env.NODE_ENV === 'production')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // Recorded before validation: even a malformed body proves the worker is
  // alive and reaching us, which is what the /tf badge reports.
  noteWorkerSeen();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const parsed = parseIngestPayload(raw);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if (parsed.payload.kind === 'heartbeat') {
    return NextResponse.json({ success: true, stored: false, reason: 'heartbeat' });
  }

  const { pathname, status, ok, body } = parsed.payload;
  const tag = endpointTagFor(pathname);
  // Not one of the feeds we keep — real TradeFinder traffic nobody reads.
  if (!tag) return NextResponse.json({ success: true, stored: false, reason: 'not-tracked' });

  try {
    const verdict = classifyTfResponse(ok, status, body);
    if (verdict.outcome === 'rejected') {
      await recordTfLiveCapture({
        endpoint: tag,
        status: 'error',
        error: `TradeFinder rejected it (${verdict.detail})`,
      });
      // Only a SUSTAINED run of rejections raises the operator alarm — see
      // failureAlarmMessage()'s note on the 2026-08-10 incident.
      const { consecutiveFailures, sawFirstSuccess } = noteCaptureFailure();
      const alarm = failureAlarmMessage(consecutiveFailures, sawFirstSuccess, verdict.detail);
      if (alarm) await recordTfBrowserOutcome(false, alarm);
      return NextResponse.json({ success: true, stored: true, outcome: 'error', alarmed: alarm != null });
    }

    const captureId = await recordTfLiveCapture({ endpoint: tag, status: 'success', payloadJson: JSON.stringify(body) });
    const rows = extractRows(tag, body);
    if (captureId && rows) await recordTfLiveRows(captureId, rows);
    noteCaptureSuccess();
    await recordTfBrowserOutcome(true);
    return NextResponse.json({ success: true, stored: true, outcome: 'success', endpoint: tag });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
```

- [ ] **Step 3: Verify against the dev server**

```bash
S="X-TF-Worker-Secret: testsecret"
curl -s -o /dev/null -w "no-secret=%{http_code}\n" -X POST -H "Content-Type: application/json" \
  -d '{"heartbeat":true}' http://localhost:5001/api/tf/ingest
curl -s -X POST -H "$S" -H "Content-Type: application/json" \
  -d '{"heartbeat":true}' http://localhost:5001/api/tf/ingest
curl -s -X POST -H "$S" -H "Content-Type: application/json" \
  -d '{"pathname":"/api_be/servertime","status":200,"ok":true,"body":{"status":"SUCCESS"}}' \
  http://localhost:5001/api/tf/ingest
curl -s -X POST -H "$S" -H "Content-Type: application/json" \
  -d '{"status":200}' http://localhost:5001/api/tf/ingest
# A single rejection must NOT alarm (alarmed:false)
curl -s -X POST -H "$S" -H "Content-Type: application/json" \
  -d '{"pathname":"/api_be/data/order/all_sector","status":200,"ok":true,"body":{"status":"TOKEN_ERROR","code":"TOKEN_ERROR","message":"UNAUTHORISED"}}' \
  http://localhost:5001/api/tf/ingest
```
Expected in order: `no-secret=403`; `{"success":true,"stored":false,"reason":"heartbeat"}`; `{"success":true,"stored":false,"reason":"not-tracked"}`; a 400 naming the missing `pathname`; then `outcome:"error"` with **`alarmed:false`**.

- [ ] **Step 4: Verify the alarm does fire on a sustained run**

Send the same rejection 6 times total:
```bash
for i in 1 2 3 4 5 6; do
  curl -s -X POST -H "X-TF-Worker-Secret: testsecret" -H "Content-Type: application/json" \
    -d '{"pathname":"/api_be/data/order/all_sector","status":200,"ok":true,"body":{"status":"TOKEN_ERROR","code":"TOKEN_ERROR","message":"UNAUTHORISED"}}' \
    http://localhost:5001/api/tf/ingest; echo;
done
```
Expected: `alarmed:false` until the 6th, which returns `alarmed:true`. Then `/tf` shows *running, not capturing* with the "signed out mid-session" reason.

- [ ] **Step 5: Run the local CI gate**

```bash
pnpm typecheck && pnpm typecheck:scripts && pnpm lint
pnpm exec tsx scripts/verify-dependency-hygiene.ts
pnpm exec tsx scripts/verify-tf-worker-protocol.ts && pnpm exec tsx scripts/verify-tf-ingest.ts
```

- [ ] **Step 6: Stop and report — do not commit**

---

### Task 5: Stop launching Chromium on the trading box

The change that actually reclaims the CPU. The local launch path is **deleted, not retained** — see the spec's §3 note: unreachable code fails `no-unused-vars`, and an unreachable second copy of the response handling is the drift risk this design exists to avoid. `deploy/tf-worker/` (Task 6) is the living copy; git history and the module header carry the reasoning.

**Files:**
- Modify: `lib/tf-live/browser.ts`
- Modify: `app/api/tf/browser-session/route.ts:70-77`

**Interfaces:**
- Consumes: `isWorkerAlive`, `WORKER_LIVENESS_MS` (Task 1).
- Produces: `isTfBrowserRunning(): boolean`, `startTfBrowserWatchdog(): void`, `forceStartTfBrowser(): Promise<void>`, `stopTfBrowser(): Promise<void>` — all signatures unchanged, so `instrumentation.ts` and `app/api/tf/browser-session/route.ts` still compile.

- [ ] **Step 1: Delete the local Chromium machinery**

From `lib/tf-live/browser.ts` remove entirely: `launch()`, `handleResponse()`, `closeBrowser()`, `ensureTfBrowserState()`, `logMemory()`, the `mb()` helper, and the constants `MARKET_PULSE_URL`, `SECTOR_SCOPE_URL`, `SITE_URL`, `FIRST_SUCCESS_TIMEOUT_MS`, `WATCHDOG_INTERVAL_MS`, `RELOAD_INTERVAL_MS`, `REALISTIC_UA`, `CHROMIUM_NICE_LEVEL`. Remove the imports they alone used: `freemem`/`setPriority`/`totalmem` from `node:os`, `cookieHeaderToPlaywrightCookies`, `getTfBrowserCookies`, `recordTfLiveCapture`, `recordTfLiveRows`, and the Task-2 `ingest` import added earlier.

From `BrowserState` remove: `browser`, `browserServer`, `starting`, `watchdog`, `reloadTimer`, `reloadTimerB` (and their initializer entries and `??=` lines). **Keep** `consecutiveFailures`, `sawFirstSuccess`, `manualUntilMs`, `lastWorkerSeenAtMs` — all four are still driven by the ingest route and the /tf actions.

`recordTfBrowserOutcome` stays imported only if still referenced; after this step it is not, so remove it too.

- [ ] **Step 2: Redefine `isTfBrowserRunning()`**

```ts
/**
 * True while the REMOTE worker is capturing. Same signature and same meaning to
 * every caller ("is the relay working right now"), but the evidence changed:
 * Chromium no longer runs in this process, so there is no local browser object
 * to inspect — the worker's own traffic is the signal.
 *
 * Still deliberately honest: /tf reads *running, not capturing* whenever
 * `session.lastError` is set, so a worker that is alive but being rejected by
 * TradeFinder shows a warning rather than a green badge.
 */
export function isTfBrowserRunning(): boolean {
  return isWorkerAlive(state().lastWorkerSeenAtMs, Date.now());
}
```

Add the import: `import { isWorkerAlive, WORKER_LIVENESS_MS } from '@/lib/tf-live/worker-protocol';`

- [ ] **Step 3: Replace the boot hook and the /tf actions**

```ts
/**
 * Boot hook, still called once from instrumentation.ts. There is no watchdog to
 * run any more: nothing local to keep alive, and the remote worker drives itself
 * off GET /api/tf/worker-config.
 */
export function startTfBrowserWatchdog(): void {
  console.log(
    `[tf_browser] local Chromium disabled — capture runs on the remote worker; liveness window ${WORKER_LIVENESS_MS / 1000}s`,
  );
}

/** /tf's "Start now" — opens the manual override window the worker polls via
 *  shouldWorkerRun(), so an operator can watch a capture run off-hours. Starts
 *  no local process, so expect up to one worker poll of delay. */
export async function forceStartTfBrowser(): Promise<void> {
  state().manualUntilMs = Date.now() + MANUAL_TEST_DURATION_MS;
}

/** /tf's "Stop" — clears the manual override. Inside the capture window
 *  shouldWorkerRun() stays true regardless, so this only ends an off-hours test
 *  session; that is exactly how the in-process version behaved. */
export async function stopTfBrowser(): Promise<void> {
  state().manualUntilMs = null;
}
```

Both keep `Promise<void>` so the route needs no signature change. `async` with no `await` is intentional for that compatibility — if lint objects, satisfy it with `return Promise.resolve();` rather than changing the exported type.

- [ ] **Step 4: Replace the module header's lifecycle section**

In `lib/tf-live/browser.ts`, replace the `COST AND LIFECYCLE` section with:

```
 * WHERE THIS RUNS — NOT ON THE TRADING BOX ANY MORE (2026-08-24)
 * ---------------------------------------------------------------
 * Chromium used to launch in THIS process. Real historical CPU data settled
 * that it could not stay: the box averaged ~2.5-4% CPU on trading days before
 * this relay existed and ~37-65% sustained afterwards, with Fyers/Dhan polling
 * unchanged. Three in-place mitigations shipped and none fixed it —
 * resource-reduction Chromium flags (v1.55.5), staggered tab reloads (v1.55.6),
 * OS `nice` deprioritization (v1.55.7); a latency probe after the last still
 * caught a 13.4s stall on GET /api/health, a handler doing no async work.
 *
 * Capture now runs on a separate host (deploy/tf-worker/worker.mjs) which polls
 * GET /api/tf/worker-config and POSTs what it sees to POST /api/tf/ingest.
 * What a response MEANS lives in lib/tf-live/ingest.ts — the worker judges
 * nothing, so TradeFinder's schema has exactly one copy.
 *
 * The local launch code is GONE, not commented out: unreachable code fails
 * no-unused-vars, and a dormant second copy of the response handling is the
 * drift risk this design exists to avoid. Git history holds it.
 *
 * There is NO automatic fallback to launching locally — if the worker dies,
 * capture stops, and the existing TF_BOARD_MAX_AGE_MIN staleness gate already
 * refuses entries on a stale board (operator decision, 2026-08-24).
 *
 * Design: docs/superpowers/specs/2026-08-24-tf-browser-remote-worker-design.md
```

- [ ] **Step 5: Repoint the /tf action responses**

In `app/api/tf/browser-session/route.ts` (~lines 70-77), `isTfBrowserRunning()` now describes the remote worker and cannot flip inside the same request. Report the intent instead:

```ts
    if (body.action === 'start') {
      await forceStartTfBrowser();
      // isTfBrowserRunning() describes the REMOTE worker, which cannot have
      // reacted yet — report what was requested, not a stale liveness read.
      return NextResponse.json({ success: true, running: isTfBrowserRunning(), pending: 'start-requested' });
    }
    if (body.action === 'stop') {
      await stopTfBrowser();
      return NextResponse.json({ success: true, running: isTfBrowserRunning(), pending: 'stop-requested' });
    }
```

Also in the same file, the cookie-save path (~lines 92-94) calls `stopTfBrowser()` then `forceStartTfBrowser()` to pick up new cookies. That still works — the worker re-reads cookies every poll — but update the comment above it:

```ts
    // The remote worker re-reads cookies from /api/tf/worker-config on its next
    // poll, so a fresh paste takes effect within one cadence. The override
    // below just guarantees it is allowed to run right now, including
    // off-hours, so the operator gets feedback without waiting for the window.
```

- [ ] **Step 6: Confirm nothing launches locally**

```bash
pnpm dev
```
Expected boot log: `[tf_browser] local Chromium disabled — capture runs on the remote worker; liveness window 180s`, and **no** `[tf_browser] before launch`. Confirm no app-spawned Chromium:
```bash
powershell -c "Get-Process | Where-Object { $_.ProcessName -match 'chrom' } | Select-Object ProcessName,Id"
```

- [ ] **Step 7: Run the FULL CI gate**

```bash
pnpm typecheck && pnpm typecheck:scripts && pnpm lint
pnpm exec tsx scripts/verify-dependency-hygiene.ts
pnpm exec tsx scripts/verify-playwright-pin.ts
for s in verify-tf-worker-protocol verify-tf-ingest verify-quant-shadow \
         verify-option-resolver-store verify-freshness-gate verify-nse-pulse-cache \
         verify-dhan-quote-gate verify-tf-selector verify-ai-decision-context \
         verify-auto-target-stream verify-auto-trade-store \
         verify-auto-trade-settings-safety verify-commentary-store \
         verify-user-access verify-user-access-store; do
  printf '%-42s' "$s"; pnpm exec tsx scripts/$s.ts >/dev/null 2>&1 && echo OK || echo FAILED
done
```
Expected: every bench `OK`.

> **Note:** `playwright` remains a real dependency — `verify-playwright-pin.ts` and the Dockerfile's Chromium layer still matter, because the worker uses the same pinned version. Do not remove it from `package.json`.

- [ ] **Step 8: Stop and report — do not commit**

State plainly in the report: once this deploys, **TF capture is offline until the worker host exists**, which means zero trade entries (fail-closed by design). See the sequencing section at the end of this plan.

---

### Task 6: The standalone worker

Written now, provable only once a host exists. Plain `.mjs` — no TypeScript, no build step, no Prisma. Follows the `deploy/box/**` precedent (standalone scripts, ESLint-ignored on purpose).

**Files:**
- Create: `deploy/tf-worker/worker.mjs`
- Create: `deploy/tf-worker/README.md`
- Modify: `eslint.config.mjs` (add `deploy/tf-worker/**` to `globalIgnores`)

**Interfaces:**
- Consumes: `GET /api/tf/worker-config` (Task 3), `POST /api/tf/ingest` (Task 4).
- Produces: nothing the main app imports.

- [ ] **Step 1: Write the worker**

Create `deploy/tf-worker/worker.mjs`:

```js
/**
 * REMOTE TradeFinder browser worker.
 *
 * Runs on its own small host so Chromium never competes with the trading app
 * for CPU. Design:
 * docs/superpowers/specs/2026-08-24-tf-browser-remote-worker-design.md
 *
 * DELIBERATELY KNOWS NOTHING ABOUT TRADEFINDER. It fetches its cookie, page
 * list and cadence from the main app, opens those pages, and forwards every
 * /api_be/ response it sees. Which feeds matter, what their payloads mean, and
 * whether a response counts as success are ALL decided by the main app (see
 * lib/tf-live/ingest.ts) — so capturing a new feed never requires touching or
 * redeploying this file.
 *
 * Plain .mjs on purpose: no TypeScript, no bundler, no Prisma — `node
 * worker.mjs` is the whole deployment. Mirrors deploy/box/**, ESLint-ignored
 * for the same reason.
 *
 * Env: MAIN_APP_URL, TF_WORKER_SECRET.
 */
import { chromium } from 'playwright';

const MAIN_APP_URL = (process.env.MAIN_APP_URL ?? '').replace(/\/$/, '');
const SECRET = process.env.TF_WORKER_SECRET ?? '';
if (!MAIN_APP_URL || !SECRET) {
  console.error('[tf_worker] MAIN_APP_URL and TF_WORKER_SECRET are both required');
  process.exit(1);
}

/** How often we re-read config. Also the heartbeat cadence, so the main app's
 *  3-minute liveness window sees us even while TradeFinder is silent. */
const POLL_MS = 60_000;
const REALISTIC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const state = { browser: null, context: null, pages: new Map(), reloadTimer: null, reloadIntervalMs: 90_000 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callMain(path, init = {}) {
  const response = await fetch(`${MAIN_APP_URL}${path}`, {
    ...init,
    headers: { 'X-TF-Worker-Secret': SECRET, ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
  return response.json();
}

function postJson(path, payload) {
  return callMain(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Forward one observed response. Never throws into Playwright's event loop. */
async function forward(response) {
  const url = response.url();
  if (!url.includes('/api_be/')) return;
  let body = null;
  let ok = response.ok();
  try {
    body = await response.json();
  } catch {
    // A non-JSON body (e.g. an HTML login redirect served as 200) IS the "looks
    // logged out" signal — report it as a failure rather than drop it.
    ok = false;
  }
  try {
    await postJson('/api/tf/ingest', { pathname: new URL(url).pathname, status: response.status(), ok, body });
  } catch (error) {
    console.warn(`[tf_worker] ingest failed: ${error.message}`);
  }
}

async function openBrowser(config) {
  console.log(`[tf_worker] launching Chromium for ${config.pages.length} page(s)`);
  // No heap cap and no OS nice: this host runs nothing else, which is the whole
  // reason the worker exists.
  state.browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  state.browser.on('disconnected', () => {
    state.browser = null;
    state.context = null;
    state.pages.clear();
  });
  state.context = await state.browser.newContext({ userAgent: REALISTIC_UA });
  await state.context.addCookies(config.cookies);

  for (const url of config.pages) {
    const page = await state.context.newPage();
    page.on('response', (response) => void forward(response).catch(() => undefined));
    state.pages.set(url, page);
    // Sequential, and a failure here is not fatal — the reload loop retries.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  }

  // TradeFinder's page fires ONE round of requests per load and then goes
  // silent, so our own reload IS the capture tick. Staggered across pages so
  // two renderers never navigate in the same instant.
  state.reloadIntervalMs = config.reloadIntervalMs;
  state.reloadTimer = setInterval(() => {
    const urls = [...state.pages.keys()];
    const spacing = state.reloadIntervalMs / Math.max(urls.length, 1);
    urls.forEach((url, index) => {
      setTimeout(() => {
        const page = state.pages.get(url);
        if (page) void page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
      }, spacing * index);
    });
  }, state.reloadIntervalMs);
}

async function closeBrowser() {
  if (state.reloadTimer) {
    clearInterval(state.reloadTimer);
    state.reloadTimer = null;
  }
  const browser = state.browser;
  state.browser = null;
  state.context = null;
  state.pages.clear();
  if (browser) {
    console.log('[tf_worker] closing Chromium');
    await browser.close().catch(() => undefined);
  }
}

async function tick() {
  let config;
  try {
    config = await callMain('/api/tf/worker-config');
  } catch (error) {
    // Cannot reach the main app: keep whatever is running and retry. Tearing the
    // browser down over a transient network blip would lose captures for nothing.
    console.warn(`[tf_worker] config fetch failed: ${error.message}`);
    return;
  }

  const wanted = config.shouldRun === true && Array.isArray(config.cookies) && config.cookies.length > 0;
  if (!wanted) {
    if (state.browser) await closeBrowser();
    // Still check in, so "alive, deliberately idle" is distinguishable from
    // "dead" on /tf.
    await postJson('/api/tf/ingest', { heartbeat: true }).catch(() => undefined);
    return;
  }

  if (!state.browser) {
    try {
      await openBrowser(config);
    } catch (error) {
      console.error(`[tf_worker] launch failed: ${error.message}`);
      await closeBrowser();
    }
    return;
  }
  await postJson('/api/tf/ingest', { heartbeat: true }).catch(() => undefined);
}

process.on('SIGTERM', () => void closeBrowser().then(() => process.exit(0)));
process.on('SIGINT', () => void closeBrowser().then(() => process.exit(0)));

console.log(`[tf_worker] started — polling ${MAIN_APP_URL} every ${POLL_MS / 1000}s`);
for (;;) {
  await tick();
  await sleep(POLL_MS);
}
```

- [ ] **Step 2: Ignore the folder in ESLint**

In `eslint.config.mjs`, add to the same `globalIgnores([...])` array that already contains `"deploy/box/**"`:

```js
    // The remote TF browser worker (deploy/tf-worker/**) is NOT app source: it
    // is a standalone plain-Node script run by `node` on a SEPARATE host,
    // against that host's own node_modules. Same category as deploy/box/**.
    "deploy/tf-worker/**",
```

- [ ] **Step 3: Write the deployment README**

Create `deploy/tf-worker/README.md`:

```markdown
# TF browser worker

Runs the TradeFinder headless-Chromium relay on its own host so Chromium never
competes for CPU with the trading app. Design:
`docs/superpowers/specs/2026-08-24-tf-browser-remote-worker-design.md`.

## Why it is not on the main box

Real CPU history (2026-08-24): the trading box averaged ~2.5-4% CPU on trading
days before this relay existed and ~37-65% sustained afterwards, with
Fyers/Dhan polling unchanged. Three in-place mitigations shipped and none fixed
it (v1.55.5 Chromium flags, v1.55.6 staggered reloads, v1.55.7 OS `nice`); a
probe after the last still caught a 13.4s stall on `GET /api/health`.

## Host requirement: a STABLE outbound IP

Not a preference. All TradeFinder traffic currently leaves from one Elastic IP.
TF already signs this account out roughly daily, and a rotating pool of
datacenter IPs is a scraping signature aimed at the feed the entire trade
selector depends on — and that selector is fail-closed, so a blocked account
means zero picks, not degraded picks. This is why AWS Lambda was rejected: its
egress IP changes per invocation and pinning it needs a ~$33/month NAT Gateway.

Suitable: an Oracle Cloud Always Free VM, or a small AWS EC2 instance.

## Setup

```bash
npm install playwright
npx playwright install --with-deps chromium

export MAIN_APP_URL="https://charan-projectr.duckdns.org"
export TF_WORKER_SECRET="<same value as the main app's env>"
node worker.mjs
```

Keep it running under systemd with `Restart=always` so a crash recovers without
a human. The worker is stateless — it re-reads cookie, page list and cadence
from the main app every 60s, so a fresh "Copy as cURL" paste on `/tf` takes
effect within one poll with no worker restart.

## Verifying it works

- `/tf` on the main app shows *browser running* within ~1 minute of start.
- `/tf`'s capture log shows fresh `all_sector` / `daily-index` / `market_pulse`
  rows.
- The worker log prints `[tf_worker] launching Chromium for 2 page(s)`.
- If `/tf` says *running, not capturing*, the worker is alive but TradeFinder is
  rejecting it — paste a fresh cURL. That distinction is the point of the badge.

## Adding another TradeFinder feed

Do not edit this worker. On the MAIN app: add the endpoint to
`lib/tf-live/endpoints.ts` (and a parser in `parse.ts` if per-symbol rows are
wanted); if the feed lives on a TradeFinder page not already opened, add that
URL to `TF_PAGES` in `app/api/tf/worker-config/route.ts`. The worker picks
either up on its next poll.
```

- [ ] **Step 4: Syntax-check without running**

```bash
node --check deploy/tf-worker/worker.mjs
```
Expected: no output. It cannot run meaningfully until a host exists with `MAIN_APP_URL`/`TF_WORKER_SECRET` set.

- [ ] **Step 5: Confirm CI is unaffected by the new folder**

```bash
pnpm lint && pnpm typecheck
pnpm exec tsx scripts/verify-dependency-hygiene.ts
```
Expected: clean — the folder is ESLint-ignored, is not in the app's module graph, and the hygiene scanner covers only `app`, `lib`, `scripts`, `components`.

- [ ] **Step 6: Stop and report — do not commit**

---

### Task 7: Document the env var and the operational model

**Files:**
- Modify: `DEPLOY.md` (env table ~line 282)
- Modify: `Project-R-simulator/CLAUDE.md` (the TradeFinder capture section)

**Interfaces:** documentation only.

- [ ] **Step 1: Add `TF_WORKER_SECRET` to the DEPLOY.md env table**

Match the format of the neighbouring `TELEGRAM_WEBHOOK_SECRET` row:

```markdown
| `TF_WORKER_SECRET`         | Yes      | Shared secret for the remote TF browser worker — sent as `X-TF-Worker-Secret` on `/api/tf/worker-config` and `/api/tf/ingest`. **Unset in production rejects every worker request**, because that config response carries the live TradeFinder session cookie. Must match the worker host's own env. |
```

- [ ] **Step 2: Update the CLAUDE.md TradeFinder section**

Append to `## TradeFinder capture (/tf) and the pages that read it`:

```markdown
- **Chromium does NOT run on the trading box any more (2026-08-24).** It runs on a
  separate host (`deploy/tf-worker/worker.mjs`) that polls `GET /api/tf/worker-config`
  and POSTs what it sees to `POST /api/tf/ingest`; both are proxy-allowlisted and
  authenticated by the `X-TF-Worker-Secret` header, which **fails closed when
  `TF_WORKER_SECRET` is unset in production** because that config response carries the
  live TF session cookie. Measured cause: the box averaged ~2.5-4% CPU on trading days
  before the in-process relay and ~37-65% sustained after, and three in-place fixes
  (Chromium flags v1.55.5, staggered reloads v1.55.6, OS `nice` v1.55.7) all failed — a
  probe after the last still caught a 13.4s stall on `GET /api/health`, a handler that
  does no async work.
- **The worker is deliberately schema-ignorant and must stay that way.** It forwards
  every `/api_be/` response and judges none of them; `lib/tf-live/ingest.ts` alone owns
  the allowlist (`endpointTagFor`), the parsers (`extractRows`) and the success rule
  (`classifyTfResponse` — TF answers **HTTP 200 with `status: 'TOKEN_ERROR'`** when the
  session lapses, so the status code alone is never the test). Capturing a new feed is
  therefore a main-app-only change: an `endpoints.ts` entry, plus a URL in `TF_PAGES`
  (`app/api/tf/worker-config/route.ts`) if it lives on a page the worker does not already
  open. Never duplicate TF's schema into the worker — two drifting copies is the failure
  this design exists to avoid.
- **The 2026-08-10 alarm rule now has CI coverage** (`scripts/verify-tf-ingest.ts`):
  `failureAlarmMessage()` fires after `CONSECUTIVE_FAILURE_LIMIT` (6) consecutive
  rejections **regardless of an earlier success** — the old `&& !sawFirstSuccess`
  suppression is what let 263 failures over 3h20m hide behind a green badge — and never
  on a single transient blip.
- **`isTfBrowserRunning()` now means "worker seen within 3 minutes"**
  (`WORKER_LIVENESS_MS`), not "is there a local browser object". A future timestamp fails
  closed so clock skew cannot pin the badge green. There is **no auto-fallback to local
  Chromium**: worker down means capture stops, and `TF_BOARD_MAX_AGE_MIN` already refuses
  entries on a stale board. `/tf`'s Start/Stop move a manual override the worker polls
  (`shouldWorkerRun()`), so they take up to one poll to bite — and Stop inside the capture
  window still only pauses until the next poll, exactly as the in-process watchdog behaved.
- **The worker host must have a stable outbound IP.** This is why Lambda was rejected: its
  egress IP rotates per invocation, pinning it costs ~$33/mo in NAT Gateway, and rotating
  datacenter IPs are a scraping signature against the feed the entire selector depends on.
```

- [ ] **Step 3: Run the full CI gate one final time**

```bash
pnpm typecheck && pnpm typecheck:scripts && pnpm lint
pnpm exec tsx scripts/verify-dependency-hygiene.ts
pnpm exec tsx scripts/verify-playwright-pin.ts
for s in verify-tf-worker-protocol verify-tf-ingest verify-quant-shadow \
         verify-option-resolver-store verify-freshness-gate verify-nse-pulse-cache \
         verify-dhan-quote-gate verify-tf-selector verify-ai-decision-context \
         verify-auto-target-stream verify-auto-trade-store \
         verify-auto-trade-settings-safety verify-commentary-store \
         verify-user-access verify-user-access-store; do
  printf '%-42s' "$s"; pnpm exec tsx scripts/$s.ts >/dev/null 2>&1 && echo OK || echo FAILED
done
```

- [ ] **Step 4: Stop and report — do not commit**

Summarize: what shipped; that `TF_WORKER_SECRET` must be added to the box's env-file (needs a container recreate, never committed); and that deploying Task 5 takes TF capture offline until the worker host exists, so sequencing is the operator's call.

---

## Deployment sequencing (operator decision required)

Tasks 1-4 are **additive and safe to deploy alone**: the new endpoints exist, nothing calls them, and the in-process browser keeps capturing exactly as today.

**Task 5 is the cutover.** Once deployed, capture stops until the worker host is live — and with it all trade entries, fail-closed by design. Two viable orders:

1. **Safe (recommended):** deploy Tasks 1-4 → provision the host → run the worker → confirm `/tf` shows *browser running* and captures are landing → then deploy Task 5. No capture gap at any point.
2. **Direct:** deploy Tasks 1-5 together and accept no captures (and no entries) until the host is up.

Either way, `TF_WORKER_SECRET` must be on the box's env-file **before Task 3 deploys**, or every worker request is refused in production.
