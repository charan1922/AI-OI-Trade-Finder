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

/** ONLY these get stored — exactly `market_pulse` and `sector_scope` (operator
 *  request 2026-10-08, see lib/tf-live/endpoints.ts). Everything else the page
 *  fires (all_sector, daily-index, rfactor_data, check_signal, servertime,
 *  feature flags…) is real traffic that is dropped before it can reach the
 *  database. */
const ALLOWED_TAGS = new Set<string>(TF_ENDPOINTS);

/**
 * Map a TradeFinder request path to the endpoint tag stored in
 * tf_live_captures, or null for anything not in ALLOWED_TAGS.
 *
 * EVERY tracked feed needs its own `endsWith` case — the generic fallback below
 * only produces a bare tag for a path shaped `/api_be/<tag>`, and none of
 * TradeFinder's real paths is. Without one a feed is silently dropped: that is
 * how `market_pulse` lost every response from 2026-08-08 to 2026-08-26.
 * scripts/verify-tf-ingest.ts round-trips every TF_ENDPOINTS entry to catch it.
 */
export function endpointTagFor(pathname: string): string | null {
  let tag: string;
  if (pathname.endsWith('/data/market_pulse')) tag = 'market_pulse';
  // `/data/sector_scope` only — TF's older `/data/order/sector_scope` must stay untracked.
  else if (pathname.endsWith('/data/sector_scope') && !pathname.endsWith('/data/order/sector_scope')) tag = 'sector_scope';
  else {
    const marker = '/api_be/';
    const at = pathname.indexOf(marker);
    tag = at >= 0 ? pathname.slice(at + marker.length) : pathname;
  }
  return ALLOWED_TAGS.has(tag) ? tag : null;
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
