/**
 * TradeFinder BROWSER relay — a real headless Chromium, started out logged in
 * by an injected cookie jar, watching TradeFinder's OWN JavaScript make its
 * OWN requests, and simply recording what comes back.
 *
 * WHY THIS EXISTS — read lib/tf-live/client.ts's history first. Short version:
 * every attempt to capture and REPLAY TradeFinder's `accessToken` (the
 * sessionStorage `at` value) failed, including one captured live from a real,
 * currently-succeeding browser request and replayed under a second later. The
 * evidence says `at` is single-use, minted by TradeFinder's own frontend code
 * at the instant of each request — there is no way to fetch-and-replay it from
 * outside a real browser (confirmed exhaustively 2026-08-07/08).
 *
 * This module sidesteps that instead of solving it: rather than minting `at`
 * ourselves, it runs an ACTUAL Chromium, injects the cookies the operator's
 * own browser already has (see lib/tf-live/parse-curl.ts for how those are
 * captured), and navigates to the site. AS FAR AS TRADEFINDER CAN TELL THIS IS
 * A LOGGED-IN BROWSER, so their own code mints lt/at exactly as it does for a
 * human — we never touch lt/at at all. We only listen to whatever the page
 * fires and keep the three endpoints lib/tf-live/endpoints.ts actually lists
 * (see ALLOWED_TAGS below) — the page also fires several others nobody reads
 * (admin/users/check_signal, feature_flag/feature_read,
 * rfactor_filter/rfactor_data, servertime, TradeFinder's OWN sector_scope),
 * which are dropped before they ever reach the database (scoped down
 * 2026-08-08, user request).
 *
 * HOW LONG THE INJECTED SESSION LASTS — SHORTER THAN TRADEFINDER CLAIMS
 * -----------------------------------------------------------------------
 * The one cookie that matters is `__Secure-next-auth.session-token` —
 * TradeFinder's own Google-login session. Their own /api/auth/session response
 * reports a ~30-day `expires`, but that is the cookie's outer ceiling, not a
 * promise: at least one real account gets signed out of tradefinder.in DAILY
 * despite that (confirmed 2026-08-08), so this injected copy should be
 * expected to need refreshing about that often too — not monthly. Either way,
 * the fix when it does lapse is the same one-time action: paste a fresh
 * "Copy as cURL" on /tf. Still a large improvement over lt/at, which needed
 * re-pasting roughly every few seconds.
 *
 * COST AND LIFECYCLE
 * -------------------
 * A real Chromium process, launched once per trading day at CAPTURE_START_MIN
 * and closed at CAPTURE_END_MIN (lib/tf-live/collector.ts owns those
 * constants) — not relaunched per tick. The site's own polling loop IS the
 * ticking mechanism; we only listen. A watchdog restarts it if the process
 * dies mid-session. This is the cost the user explicitly accepted in exchange
 * for data that plain HTTP replay can never produce (2026-08-08).
 */
import { freemem, totalmem } from 'node:os';
import { withinCaptureWindow } from '@/lib/tf-live/collector';
import { TF_ENDPOINTS } from '@/lib/tf-live/endpoints';
import { cookieHeaderToPlaywrightCookies } from '@/lib/tf-live/parse-curl';
import { parseAllSector, parseDailyIndex } from '@/lib/tf-live/parse';
import { getTfBrowserCookies, recordTfBrowserOutcome, recordTfLiveCapture, recordTfLiveRows } from '@/lib/tf-live/store';

/** The page whose own JavaScript makes the requests we watch for. */
const ENTRY_URL = 'https://tradefinder.in/market-pulse';
/** ONLY these get stored — see lib/tf-live/endpoints.ts's module note for
 *  why the list is exactly these three and no more. Everything else the page
 *  fires (admin/users/check_signal, feature_flag/feature_read,
 *  rfactor_filter/rfactor_data, servertime, TF's own sector_scope) is real
 *  traffic nobody in this app reads, so it's dropped in handleResponse()
 *  before recordTfLiveCapture is ever called. */
const ALLOWED_TAGS = new Set<string>(TF_ENDPOINTS);
/** Passed to addCookies as `url`, not `domain` — see parse-curl.ts's module
 *  note on why `__Secure-`/`__Host-` cookies reject an explicit Domain. */
const SITE_URL = 'https://tradefinder.in/';

/** After this many consecutive TradeFinder responses with NO success at all,
 *  the session is treated as broken rather than "still warming up". */
const CONSECUTIVE_FAILURE_LIMIT = 6;
/** If a launch never produces even one success within this long, give up and
 *  let the watchdog retry on the next check rather than run forever blind.
 *  Must stay comfortably above RELOAD_INTERVAL_MS — real evidence (2026-08-08)
 *  shows the FIRST page load can fail even on a good session (a one-time cold
 *  start), so this needs room for at least a second reload to prove the
 *  session is actually fine before giving up on it. */
const FIRST_SUCCESS_TIMEOUT_MS = 4 * 60_000;
/** How often the watchdog checks the browser is alive and still in-window. */
const WATCHDOG_INTERVAL_MS = 60_000;
/** How often WE reload the page to force a fresh round of requests. The
 *  module originally assumed TradeFinder's own page keeps polling forever on
 *  its own ~10s timer (observed once in a real human browser's Network tab,
 *  2026-08-08) — two separate live tests on the actual headless relay proved
 *  that wrong: it fires ONE round of requests at page load and then goes
 *  silent, whether or not any of those requests succeeded. Rather than trust
 *  an undocumented client-side timer we don't control, this module now
 *  drives its own reloads, so a fresh attempt is guaranteed on a schedule we
 *  own (2026-08-08, second live-test failure). */
const RELOAD_INTERVAL_MS = 90_000;
/** A manual "Start now" (or a fresh cookie save) outside market hours used to
 *  get killed by the very next watchdog tick, at most 60s later — the tick
 *  calls ensureTfBrowserState() with no `force`, sees the window is closed,
 *  and shuts it straight back down. That made it impossible to just watch it
 *  run for a few minutes to confirm it's actually working (user request,
 *  2026-08-08). A manual start now stays up for this long regardless of the
 *  time of day, then reverts to normal window-based behaviour. */
const MANUAL_TEST_DURATION_MS = 10 * 60_000;

const REALISTIC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

/** Chromium runs as its OWN OS process, not inside this Node process — so
 *  `process.memoryUsage()` would never see it. System-wide free memory is
 *  the only number that actually answers "does this fit on the box", which is
 *  what matters for a small always-on server running the live trading loops
 *  alongside this (user request, 2026-08-08: know the real cost, not a guess). */
const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024));
function logMemory(label: string): void {
  const freeMb = mb(freemem());
  const totalMb = mb(totalmem());
  console.log(`[tf_browser] ${label} — free ${freeMb}MB / ${totalMb}MB total (${Math.round((freeMb / totalMb) * 100)}% free)`);
}

/** Map a TradeFinder request path to the endpoint tag the rest of the app
 *  already reads from tf_live_captures. Keeps the SAME tags the old
 *  fetch-based collector used ('all_sector', 'daily-index', 'market_pulse')
 *  so race.ts / snapshot.ts / the EOD page need no changes. Returns null for
 *  anything NOT in ALLOWED_TAGS — the caller drops those before they're ever
 *  recorded (lib/tf-live/endpoints.ts owns the allowlist and the reasoning). */
function endpointTagFor(pathname: string): string | null {
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
function extractRows(tag: string, payload: unknown): unknown[] | undefined {
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

interface BrowserState {
  browser: import('playwright').Browser | null;
  starting: Promise<void> | null;
  consecutiveFailures: number;
  sawFirstSuccess: boolean;
  watchdog: NodeJS.Timeout | null;
  /** Epoch ms until which a manual start should keep running even outside
   *  the capture window. Null when there's no active manual override. */
  manualUntilMs: number | null;
  /** Drives the page reload loop (see RELOAD_INTERVAL_MS) — cleared in
   *  closeBrowser() so a stale timer from a previous session can never fire
   *  against a browser that's already gone. */
  reloadTimer: NodeJS.Timeout | null;
}

const store = globalThis as unknown as { __tfBrowserState?: BrowserState };
store.__tfBrowserState ??= {
  browser: null,
  starting: null,
  consecutiveFailures: 0,
  sawFirstSuccess: false,
  watchdog: null,
  manualUntilMs: null,
  reloadTimer: null,
};
const state = (): BrowserState => store.__tfBrowserState as BrowserState;

/** True while a browser process is currently up. Exported for the /tf status API. */
export function isTfBrowserRunning(): boolean {
  return state().browser != null;
}

async function handleResponse(response: import('playwright').Response): Promise<void> {
  const url = response.url();
  if (!url.includes('/api_be/')) return;

  const pathname = new URL(url).pathname;
  const tag = endpointTagFor(pathname);
  if (!tag) return; // not one of the three we keep — real traffic, but nobody reads it
  const s = state();

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A non-JSON response (e.g. an HTML login redirect served with a 200) is
    // exactly the "looks logged out" signal — record it as a failure, not
    // silently ignore it.
    await recordTfLiveCapture({ endpoint: tag, status: 'error', error: `non-JSON response (HTTP ${response.status()})` });
    s.consecutiveFailures += 1;
    return;
  }

  const shape = body as { status?: string; code?: string; message?: string } | null;
  if (!response.ok() || shape?.status !== 'SUCCESS') {
    const detail = shape?.code ? `${shape.code}: ${shape.message ?? 'rejected'}` : `HTTP ${response.status()}`;
    await recordTfLiveCapture({ endpoint: tag, status: 'error', error: `TradeFinder rejected it (${detail})` });
    s.consecutiveFailures += 1;
    if (s.consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT && !s.sawFirstSuccess) {
      await recordTfBrowserOutcome(
        false,
        'the injected session looks logged out (repeated rejections with zero successes) — paste a fresh "Copy as cURL" on /tf'
      );
    }
    return;
  }

  s.consecutiveFailures = 0;
  s.sawFirstSuccess = true;
  const payloadJson = JSON.stringify(body);
  const captureId = await recordTfLiveCapture({ endpoint: tag, status: 'success', payloadJson });
  const rows = extractRows(tag, body);
  if (captureId && rows) await recordTfLiveRows(captureId, rows);
  await recordTfBrowserOutcome(true);
}

/** Launch one browser, inject cookies, open the entry page, and wire the
 *  response listener. Resolves once navigation completes; from there OUR OWN
 *  reload loop (not the page's own JS) keeps producing fresh attempts every
 *  RELOAD_INTERVAL_MS until stopped or the browser crashes. */
async function launch(cookieHeader: string): Promise<void> {
  logMemory('before launch');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const s = state();
  s.browser = browser;
  s.consecutiveFailures = 0;
  s.sawFirstSuccess = false;

  browser.on('disconnected', () => {
    if (s.browser === browser) s.browser = null;
    if (s.reloadTimer) {
      clearInterval(s.reloadTimer);
      s.reloadTimer = null;
    }
  });

  const context = await browser.newContext({ userAgent: REALISTIC_UA });
  await context.addCookies(cookieHeaderToPlaywrightCookies(cookieHeader, SITE_URL));
  const page = await context.newPage();
  page.on('response', (response) => void handleResponse(response).catch(() => undefined));

  await page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // A few seconds for Chromium's own process to finish settling after the
  // page load — reading memory immediately after goto() would under-count it.
  setTimeout(() => logMemory('~5s after page load (steady-state cost)'), 5_000);

  // WE drive every subsequent attempt — see RELOAD_INTERVAL_MS's module note
  // on why the page's own polling loop can't be trusted to keep going.
  if (s.reloadTimer) clearInterval(s.reloadTimer);
  s.reloadTimer = setInterval(() => {
    if (s.browser !== browser) return; // stale timer from a since-replaced browser
    void page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  }, RELOAD_INTERVAL_MS);
  s.reloadTimer.unref?.();

  // Give our own reload loop a bounded number of rounds to prove the session
  // is real before declaring it broken — a slow first load is normal, total
  // silence across several reloads is not.
  setTimeout(() => {
    void (async () => {
      if (s.browser === browser && !s.sawFirstSuccess) {
        await recordTfBrowserOutcome(
          false,
          `no successful TradeFinder response within ${FIRST_SUCCESS_TIMEOUT_MS / 1000}s of loading ${ENTRY_URL} — the session may be logged out`
        );
      }
    })();
  }, FIRST_SUCCESS_TIMEOUT_MS);
}

async function closeBrowser(): Promise<void> {
  const s = state();
  if (s.reloadTimer) {
    clearInterval(s.reloadTimer);
    s.reloadTimer = null;
  }
  const browser = s.browser;
  s.browser = null;
  if (browser) {
    await browser.close().catch(() => undefined);
    logMemory('after close (should return near the "before launch" figure)');
  }
}

/**
 * Ensure a browser is running when it should be, and closed when it should
 * not be. Idempotent — safe to call on every watchdog tick. `options.force`
 * bypasses the capture window (the manual "Start now" action on /tf).
 */
export async function ensureTfBrowserState(options: { force?: boolean } = {}): Promise<void> {
  const s = state();
  const manualActive = s.manualUntilMs != null && Date.now() < s.manualUntilMs;
  const shouldRun = options.force || withinCaptureWindow() || manualActive;

  if (!shouldRun) {
    if (s.manualUntilMs != null) s.manualUntilMs = null; // the override just lapsed — clear it, don't keep checking
    await closeBrowser();
    return;
  }
  if (s.browser) return; // already running
  if (s.starting) return s.starting; // launch already in flight

  s.starting = (async () => {
    try {
      const cookieHeader = await getTfBrowserCookies();
      if (!cookieHeader) return; // nothing configured — nothing to do
      await launch(cookieHeader);
    } catch (error) {
      await recordTfBrowserOutcome(false, `browser launch failed: ${(error as Error).message}`);
      await closeBrowser();
    } finally {
      s.starting = null;
    }
  })();
  await s.starting;
}

/** Boot hook, mirrors startTfLiveCollector — called once from instrumentation.ts. */
export function startTfBrowserWatchdog(): void {
  const s = state();
  if (s.watchdog) return;
  void ensureTfBrowserState();
  s.watchdog = setInterval(() => void ensureTfBrowserState(), WATCHDOG_INTERVAL_MS);
  s.watchdog.unref?.();
  console.log(`[tf_browser] watchdog started — checks every ${WATCHDOG_INTERVAL_MS / 1000}s, window 09:22–15:30 IST`);
}

/** Manual "Start now" action on /tf (also used right after a fresh cookie
 *  save) — force a launch outside the window, and keep it up for
 *  MANUAL_TEST_DURATION_MS so the next watchdog tick doesn't immediately
 *  shut it back down again. */
export async function forceStartTfBrowser(): Promise<void> {
  state().manualUntilMs = Date.now() + MANUAL_TEST_DURATION_MS;
  await ensureTfBrowserState({ force: true });
}

/** Manual "Stop" action on /tf. */
export async function stopTfBrowser(): Promise<void> {
  // Clear any active manual-test override too — otherwise the next watchdog
  // tick would see it's still within MANUAL_TEST_DURATION_MS and relaunch the
  // very browser this call is meant to stop.
  state().manualUntilMs = null;
  await closeBrowser();
}
