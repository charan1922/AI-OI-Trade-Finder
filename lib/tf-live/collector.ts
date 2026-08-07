/**
 * TradeFinder data collector — plain HTTPS fetch, no browser.
 *
 * TradeFinder's own frontend authenticates /api_be/* calls with two small
 * values pulled from browser storage: `localStorage.lt` (sent as the
 * `jwtToken` header) and `sessionStorage.at` (sent as the `accessToken`
 * header). No cookie is required. Confirmed live 2026-08-05: a plain fetch
 * with only these two headers, credentials:'omit' (zero cookies sent),
 * returned real data from both `all_sector` (33,392 bytes, 196 stocks) and
 * `daily-index` (857 bytes, 15 indices) — see
 * R-Obsidian/project-r/raw/tf-captures/daily-index-formula-hypothesis.md.
 *
 * This REPLACES an earlier CDP/Chromium-sidecar design (kept a signed-in
 * browser tab alive on the AWS box, drove it over the DevTools protocol). That
 * approach needed ~850MB of RAM next to the live auto-trade poller and had to
 * be re-logged-in by hand when its session lapsed. This version needs neither
 * — the two tokens are pasted on /tf, encrypted at rest, and used directly.
 */
import { MIN_REQUEST_GAP_MS, tfFetch } from '@/lib/tf-live/client';
import { TF_ENDPOINT_URL, TF_ENDPOINTS, type TfEndpoint } from '@/lib/tf-live/endpoints';
import { parseAllSector, parseDailyIndex } from '@/lib/tf-live/parse';
import {
  decodeJwtExpiry,
  getTfLiveTokens,
  recordTfLiveCapture,
  recordTfLiveRows,
  recordTfLiveSessionOutcome,
} from '@/lib/tf-live/store';

/** Which feeds exist and where they live: lib/tf-live/endpoints.ts. */
const ENDPOINTS = TF_ENDPOINTS;
type Endpoint = TfEndpoint;
const ENDPOINT_URL = TF_ENDPOINT_URL;

/** Capture cadence: 60s, at the user's explicit request (2026-08-07). A
 *  5-minute grid was too coarse to see a name climbing TF's board inside the
 *  09:45–11:00 entry window. Four feeds spaced MIN_REQUEST_GAP_MS apart use
 *  ~12s of each minute, so a tick always finishes well before the next. */
const INTERVAL_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

function configured(): boolean {
  return process.env.AUTONOMOUS_SERVER === 'true' && process.env.TF_LIVE_ENABLED === 'true';
}

/**
 * Capture window, IST. Starts at 09:22 — NOT 09:15 — at the user's explicit
 * request (2026-08-07): TradeFinder's numbers in the first few minutes reflect
 * the pre-open auction unwinding rather than real session participation, so the
 * earliest captures were describing noise. Ends with the session at 15:30.
 *
 * Exported so the window is testable and so there is one place to change it.
 */
export const CAPTURE_START_MIN = 9 * 60 + 22; // 09:22 IST
export const CAPTURE_END_MIN = 15 * 60 + 30; // 15:30 IST

/** True inside the capture window on a weekday. `now` is injectable for tests. */
export function withinCaptureWindow(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const day = parts.find((part) => part.type === 'weekday')?.value;
  const minutes = value('hour') * 60 + value('minute');
  return day !== 'Sat' && day !== 'Sun' && minutes >= CAPTURE_START_MIN && minutes <= CAPTURE_END_MIN;
}

/**
 * Normalize a payload into per-symbol rows, for the feeds whose shape we have
 * actually SEEN. Shapes are owned by lib/tf-live/parse.ts, confirmed against a
 * real payload: `all_sector` is BASKET-keyed then symbol-keyed with positional
 * param_N fields (param_0 ltp, param_1 prevClose, param_2 %, param_3 R-Factor);
 * `daily-index` is already a flat array.
 *
 * `sector_scope` and `market_pulse` intentionally return undefined: no parser
 * exists because no real payload has been inspected. They are still CAPTURED —
 * the raw payloadJson is stored on every capture row, so nothing is lost and a
 * re-parse never needs to re-call TradeFinder.
 */
function extractRows(endpoint: Endpoint, payload: unknown): unknown[] | undefined {
  if (endpoint === 'all_sector') {
    const rows = parseAllSector(payload);
    return rows.length > 0 ? rows : undefined;
  }
  if (endpoint === 'daily-index') {
    const rows = parseDailyIndex(payload);
    return rows.length > 0 ? rows.map((r) => ({ symbol: r.name, value: r.value })) : undefined;
  }
  return undefined;
}

/**
 * Capture ONE endpoint. Returns whether it succeeded so the caller can report a
 * single honest verdict for the whole tick — this function deliberately does
 * NOT touch the session's lastError. Four endpoints each writing their own
 * outcome meant the /tf banner showed whatever the LAST one did: three
 * successes and one throttled retry still painted the page red.
 *
 * options.force skips the autonomous/window gates — the manual "Capture now"
 * button on /tf, so an operator can test off-hours.
 */
export async function captureTfLiveEndpoint(
  endpoint: Endpoint,
  options: { force?: boolean } = {}
): Promise<{ endpoint: Endpoint; ok: boolean; error?: string; skipped?: boolean }> {
  if (!options.force && (!configured() || !withinCaptureWindow())) {
    return { endpoint, ok: false, skipped: true };
  }
  const tokens = await getTfLiveTokens();
  if (!tokens) return { endpoint, ok: false, skipped: true };

  // The JWT knows its own expiry — skip the network round-trip entirely for a
  // token we already know is dead, and say so precisely rather than let it
  // surface as a generic TradeFinder rejection.
  const jwtExpiresAt = decodeJwtExpiry(tokens.lt);
  if (jwtExpiresAt && new Date(jwtExpiresAt).getTime() <= Date.now()) {
    const error = `lt expired at ${jwtExpiresAt} — paste a fresh pair on /tf`;
    await recordTfLiveCapture({ endpoint, status: 'error', error });
    return { endpoint, ok: false, error };
  }

  // Every request goes through the shared queue in client.ts: serialized
  // globally and spaced, because bursts are what TradeFinder refuses.
  const result = await tfFetch(ENDPOINT_URL[endpoint], tokens);
  if (!result.ok) {
    const error = result.error ?? 'TradeFinder request failed';
    await recordTfLiveCapture({ endpoint, status: 'error', error });
    return { endpoint, ok: false, error };
  }

  const captureId = await recordTfLiveCapture({ endpoint, status: 'success', payloadJson: result.body });
  const rows = extractRows(endpoint, result.payload);
  if (captureId && rows) await recordTfLiveRows(captureId, rows);
  return { endpoint, ok: true };
}

/**
 * One full tick: every endpoint, sequentially, spaced by the shared queue.
 *
 * The session outcome is recorded ONCE, for the tick as a whole, and only
 * counts endpoints that actually attempted a request. A tick where some feeds
 * succeed and others are throttled is reported as a partial failure naming the
 * feeds that failed — not as a blanket "TradeFinder rejected it", which is what
 * made the /tf banner scream red immediately after a capture that had just
 * stored 210 stocks.
 */
export async function captureTfLive(options: { force?: boolean } = {}): Promise<void> {
  if (running) return;
  running = true;
  try {
    const results = [];
    for (const endpoint of ENDPOINTS) results.push(await captureTfLiveEndpoint(endpoint, options));

    const attempted = results.filter((r) => !r.skipped);
    if (attempted.length === 0) return; // outside the window / no token — not a failure

    const failed = attempted.filter((r) => !r.ok);
    if (failed.length === 0) {
      await recordTfLiveSessionOutcome(true);
      return;
    }
    const summary =
      failed.length === attempted.length
        ? (failed[0].error ?? 'TradeFinder request failed')
        : `${failed.length} of ${attempted.length} feeds failed (${failed.map((f) => f.endpoint).join(', ')}): ${failed[0].error ?? 'rejected'}`;
    await recordTfLiveSessionOutcome(false, summary);
  } finally {
    running = false;
  }
}

export function startTfLiveCollector(): void {
  if (timer || !configured()) return;
  void captureTfLive();
  timer = setInterval(() => void captureTfLive(), INTERVAL_MS);
  timer.unref?.();
  console.log(
    `[tf_live] collector started — ${ENDPOINTS.length} feeds every ${INTERVAL_MS / 1000}s, ` +
      `spaced ${MIN_REQUEST_GAP_MS / 1000}s apart, window 09:22–15:30 IST`
  );
}
