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
