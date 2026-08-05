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
import { getTfLiveTokens, recordTfLiveCapture, recordTfLiveRows, recordTfLiveSessionOutcome } from '@/lib/tf-live/store';

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
function extractRows(payload: unknown): unknown[] | undefined {
  const data = (payload as { payload?: { data?: unknown } } | null)?.payload?.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    return Object.entries(data as Record<string, unknown>).map(([symbol, value]) => ({
      symbol,
      ...(value && typeof value === 'object' ? (value as Record<string, unknown>) : { value }),
    }));
  }
  return undefined;
}

/** options.force skips the autonomous/market-hours gates — used by the manual
 *  "Capture now" button on /tf so an operator can test off-hours too. */
export async function captureTfLiveEndpoint(endpoint: Endpoint, options: { force?: boolean } = {}): Promise<void> {
  if (!options.force && (!configured() || !marketOpen())) return;
  const tokens = await getTfLiveTokens();
  if (!tokens) return;

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
    if ((parsed as { status?: string } | null)?.status !== 'SUCCESS') {
      throw new Error(`TradeFinder rejected the token: ${((parsed as { message?: string })?.message ?? 'unknown').slice(0, 200)}`);
    }
    const captureId = await recordTfLiveCapture({ endpoint, status: 'success', payloadJson: body });
    const rows = extractRows(parsed);
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
