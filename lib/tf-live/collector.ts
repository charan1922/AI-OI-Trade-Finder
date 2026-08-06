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
import { parseAllSector, parseDailyIndex } from '@/lib/tf-live/parse';
import {
  decodeJwtExpiry,
  getTfLiveTokens,
  recordTfLiveCapture,
  recordTfLiveRows,
  recordTfLiveSessionOutcome,
} from '@/lib/tf-live/store';

const ENDPOINTS = ['all_sector', 'daily-index'] as const;
type Endpoint = (typeof ENDPOINTS)[number];

const ENDPOINT_URL: Record<Endpoint, string> = {
  'all_sector': 'https://tradefinder.in/api_be/data/order/all_sector',
  'daily-index': 'https://tradefinder.in/api_be/data/order/daily-index',
};

const INTERVAL_MS = 5 * 60_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

function configured(): boolean {
  return process.env.AUTONOMOUS_SERVER === 'true' && process.env.TF_LIVE_ENABLED === 'true';
}

function marketOpen(now = new Date()): boolean {
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
  return day !== 'Sat' && day !== 'Sun' && minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

/** `all_sector`'s payload is an OBJECT keyed by symbol; `daily-index`'s is
 *  already an array keyed by Symbol. Normalize both to one row shape. */
function extractRows(endpoint: Endpoint, payload: unknown): unknown[] | undefined {
  // Shapes are owned by lib/tf-live/parse.ts, confirmed against a real payload:
  // all_sector is BASKET-keyed then symbol-keyed with positional param_N fields
  // (param_0 ltp, param_1 prevClose, param_2 %, param_3 R-Factor); daily-index
  // is already a flat array. The raw payloadJson is retained on the capture row
  // regardless, so a future re-parse never needs to re-call TradeFinder.
  if (endpoint === 'all_sector') {
    const rows = parseAllSector(payload);
    return rows.length > 0 ? rows : undefined;
  }
  const rows = parseDailyIndex(payload);
  return rows.length > 0 ? rows.map((r) => ({ symbol: r.name, value: r.value })) : undefined;
}

/** options.force skips the autonomous/market-hours gates — used by the manual
 *  "Capture now" button on /tf so an operator can test off-hours too. */
export async function captureTfLiveEndpoint(endpoint: Endpoint, options: { force?: boolean } = {}): Promise<void> {
  if (!options.force && (!configured() || !marketOpen())) return;
  const tokens = await getTfLiveTokens();
  if (!tokens) return;

  // The JWT knows its own expiry — skip the network round-trip entirely for
  // a token we already know is dead, and say so precisely rather than let it
  // surface as a generic TradeFinder rejection.
  const jwtExpiresAt = decodeJwtExpiry(tokens.lt);
  if (jwtExpiresAt && new Date(jwtExpiresAt).getTime() <= Date.now()) {
    const message = `lt expired at ${jwtExpiresAt} — paste a fresh pair on /tf`;
    await recordTfLiveCapture({ endpoint, status: 'error', error: message });
    await recordTfLiveSessionOutcome(false, message);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(ENDPOINT_URL[endpoint], {
      cache: 'no-store',
      headers: { accept: 'application/json', jwtToken: tokens.lt, accessToken: tokens.at },
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`TradeFinder returned HTTP ${response.status}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('TradeFinder returned non-JSON');
    }
    const shape = parsed as { status?: string; code?: string; message?: string } | null;
    if (shape?.status !== 'SUCCESS') {
      const detail = shape?.code ? `${shape.code}: ${shape.message ?? 'rejected'}` : 'no response body';
      throw new Error(`TradeFinder rejected it (${detail.slice(0, 200)})`);
    }
    const captureId = await recordTfLiveCapture({ endpoint, status: 'success', payloadJson: body });
    const rows = extractRows(endpoint, parsed);
    if (captureId && rows) await recordTfLiveRows(captureId, rows);
    await recordTfLiveSessionOutcome(true);
  } catch (error) {
    const message = (error as Error).message;
    await recordTfLiveCapture({ endpoint, status: 'error', error: message });
    await recordTfLiveSessionOutcome(false, message);
  } finally {
    clearTimeout(timeout);
  }
}

export async function captureTfLive(options: { force?: boolean } = {}): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const endpoint of ENDPOINTS) await captureTfLiveEndpoint(endpoint, options);
  } finally {
    running = false;
  }
}

export function startTfLiveCollector(): void {
  if (timer || !configured()) return;
  void captureTfLive();
  timer = setInterval(() => void captureTfLive(), INTERVAL_MS);
  timer.unref?.();
  console.log('[tf_live] collector started (plain fetch, no browser)');
}
