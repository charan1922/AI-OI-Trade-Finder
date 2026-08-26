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
 *
 * EVERY tracked feed needs its own `endsWith` case — the generic fallback below
 * only produces a bare tag for a path shaped `/api_be/<tag>`, and not one of
 * TradeFinder's three is actually shaped that way.
 *
 * THE BUG THAT PROVED IT (found 2026-08-26 by scripts/verify-tf-ingest.ts, the
 * first test this function ever had): `market_pulse` lives at
 * `/api_be/data/market_pulse` — one segment shallower than the other two, which
 * sit under `/api_be/data/order/`. It had no `endsWith` case, so the fallback
 * computed `'data/market_pulse'`, which is not in ALLOWED_TAGS, so every single
 * response was dropped. Confirmed against production: `all_sector` had 1,667
 * stored captures and `daily-index` 1,825, while `market_pulse` was absent from
 * the history entirely — zero, ever, since the browser relay replaced the
 * fetch-based collector on 2026-08-08. That silence is also why endpoints.ts
 * still records "no parser exists because no successful capture has been
 * inspected": there were none to inspect.
 */
export function endpointTagFor(pathname: string): string | null {
  let tag: string;
  if (pathname.endsWith('/data/order/all_sector')) tag = 'all_sector';
  else if (pathname.endsWith('/data/order/daily-index')) tag = 'daily-index';
  else if (pathname.endsWith('/data/market_pulse')) tag = 'market_pulse';
  else if (pathname.endsWith('/admin/users/check_signal')) tag = 'check_signal';
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
