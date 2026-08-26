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
import { freemem, setPriority, totalmem } from 'node:os';
import { withinCaptureWindow } from '@/lib/tf-live/collector';
// endpointTagFor/extractRows/CONSECUTIVE_FAILURE_LIMIT moved to ingest.ts —
// they are TradeFinder schema logic, and they now also serve POST /api/tf/ingest.
import { CONSECUTIVE_FAILURE_LIMIT, endpointTagFor, extractRows } from '@/lib/tf-live/ingest';
import { cookieHeaderToPlaywrightCookies } from '@/lib/tf-live/parse-curl';
import { getTfBrowserCookies, recordTfBrowserOutcome, recordTfLiveCapture, recordTfLiveRows } from '@/lib/tf-live/store';

/** TWO separate TradeFinder pages, each firing a different subset of the
 *  three endpoints we keep — confirmed with the operator 2026-08-08:
 *  /market-pulse fires `market_pulse`; /sector-scope fires `all_sector` AND
 *  `daily-index`. Watching only /market-pulse (the original design) meant
 *  all_sector/daily-index had ZERO fresh captures since the fetch-based
 *  collector was retired — that's why the "TF R-Factor" column on /live had
 *  been empty. Both pages are opened as separate tabs in the SAME browser
 *  context, so they share the one injected cookie jar. */
const MARKET_PULSE_URL = 'https://tradefinder.in/market-pulse';
const SECTOR_SCOPE_URL = 'https://tradefinder.in/sector-scope';
/** Passed to addCookies as `url`, not `domain` — see parse-curl.ts's module
 *  note on why `__Secure-`/`__Host-` cookies reject an explicit Domain. */
const SITE_URL = 'https://tradefinder.in/';
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
/** OS `nice` value applied to the Chromium process (range -20 highest to 19
 *  lowest priority; no special privilege needed to RAISE this number for a
 *  process we own). Real historical CPU data (2026-08-24) showed this box's
 *  average CPU jumping from ~3% to 40-65% the day this browser shipped, with
 *  Fyers/Dhan polling unchanged — so the browser IS the contention, not a
 *  bystander. This doesn't reduce how much CPU Chromium burns overall; it
 *  makes the OS scheduler favour the trading-critical Next.js process over
 *  Chromium whenever both want the same core at the same instant, which is
 *  exactly the "page loading slowly" symptom (Node request handling starved
 *  mid-request), independent of the total CPU% CloudWatch reports. */
const CHROMIUM_NICE_LEVEL = 10;

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

interface BrowserState {
  browser: import('playwright').Browser | null;
  /** The launchServer() handle, kept so closeBrowser() can terminate the
   *  actual OS process — a Browser obtained via connect() only disconnects
   *  on .close(), it doesn't kill the process it's connected to. */
  browserServer: import('playwright').BrowserServer | null;
  starting: Promise<void> | null;
  consecutiveFailures: number;
  sawFirstSuccess: boolean;
  watchdog: NodeJS.Timeout | null;
  /** Epoch ms until which a manual start should keep running even outside
   *  the capture window. Null when there's no active manual override. */
  manualUntilMs: number | null;
  /** Drives market-pulse's reload loop (see RELOAD_INTERVAL_MS) — cleared in
   *  closeBrowser() so a stale timer from a previous session can never fire
   *  against a browser that's already gone. */
  reloadTimer: NodeJS.Timeout | null;
  /** Drives sector-scope's reload loop, offset by RELOAD_INTERVAL_MS/2 from
   *  reloadTimer so the two tabs' reload-driven JS/render bursts never land
   *  in the same instant — see the staggering note on launch(). */
  reloadTimerB: NodeJS.Timeout | null;
  /** When the REMOTE worker last reached us (config poll, ingest, heartbeat).
   *  Null until it checks in for the first time. */
  lastWorkerSeenAtMs: number | null;
}

const store = globalThis as unknown as { __tfBrowserState?: BrowserState };
store.__tfBrowserState ??= {
  browser: null,
  browserServer: null,
  starting: null,
  consecutiveFailures: 0,
  sawFirstSuccess: false,
  watchdog: null,
  manualUntilMs: null,
  reloadTimer: null,
  reloadTimerB: null,
  lastWorkerSeenAtMs: null,
};
store.__tfBrowserState.reloadTimerB ??= null;
store.__tfBrowserState.browserServer ??= null;
store.__tfBrowserState.lastWorkerSeenAtMs ??= null;
const state = (): BrowserState => store.__tfBrowserState as BrowserState;

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

/** One rejection observed by the ingest route. Returns the running counters so
 *  the caller can ask failureAlarmMessage() whether this crosses into an alarm.
 *  Stateful across requests on purpose — a single transient blip must not raise
 *  it (see failureAlarmMessage's note on the 2026-08-10 incident). */
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
    // A session that dies PART-WAY THROUGH the day must raise the alarm just
    // as loudly as one that was never valid. This condition used to carry
    // `&& !s.sawFirstSuccess`, so once any request had ever succeeded the
    // warning could never fire again — and that is exactly what happened on
    // 2026-08-10: captures ran cleanly until 12:10 IST, TradeFinder then
    // answered TOKEN_ERROR: UNAUTHORISED to every single request for the next
    // 3h20m (263 of them), and because the morning had succeeded, `lastError`
    // stayed NULL and /tf kept showing a green "browser running" badge with no
    // warning anywhere. The operator's report was "it failed, I could not know
    // the reason". TradeFinder signs this account out roughly daily (see the
    // module note above), so mid-session death is the NORMAL failure, not the
    // exotic one.
    if (s.consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
      await recordTfBrowserOutcome(
        false,
        s.sawFirstSuccess
          ? `TradeFinder signed this session out mid-session — it was capturing fine earlier today, then rejected ${s.consecutiveFailures} requests in a row (${detail}). Paste a fresh "Copy as cURL" below to resume.`
          : `the injected session looks logged out (repeated rejections with zero successes, ${detail}) — paste a fresh "Copy as cURL" on /tf`
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

/** Launch one browser, inject cookies, open BOTH entry pages, and wire the
 *  response listener on each. Resolves once both navigations complete; from
 *  there OUR OWN reload loop (not either page's own JS) keeps producing
 *  fresh attempts on both tabs every RELOAD_INTERVAL_MS until stopped or the
 *  browser crashes. */
/** The box this runs on is a 2 vCPU / 2GB instance shared with the Next.js
 *  app and the Fyers poller — there is no CPU/memory isolation between them.
 *  Confirmed live 2026-08-24: with the default Chromium flags, CPU sat at a
 *  sustained 65-83% through market hours (vs 1.5-1.8% pre-open) and the box
 *  eventually stalled hard enough that even GET /api/health (zero async work)
 *  took 12.6s — stopping this browser brought it back to 0.13s immediately.
 *  These flags strip GPU/audio/extension/background-service overhead this
 *  headless relay never uses and cap the renderer's V8 heap, without changing
 *  what gets captured or how often (RELOAD_INTERVAL_MS, the two tabs, and the
 *  capture window are untouched — those feed the live trade selector). */
async function launch(cookieHeader: string): Promise<void> {
  logMemory('before launch');
  const { chromium } = await import('playwright');
  // launchServer(), not launch(): only launchServer() hands back the real OS
  // process (browserServer.process()), which is what CHROMIUM_NICE_LEVEL needs
  // to actually apply. connect() below gives back an ordinary Browser/Page API
  // — everything past this point is identical to a plain launch().
  const browserServer = await chromium.launchServer({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--js-flags=--max-old-space-size=128',
    ],
  });
  const chromiumPid = browserServer.process().pid;
  if (chromiumPid != null) {
    try {
      setPriority(chromiumPid, CHROMIUM_NICE_LEVEL);
    } catch (error) {
      // Best-effort: a sandboxed environment that refuses setpriority() should
      // never take the whole relay down over it.
      console.warn(`[tf_browser] could not lower Chromium's OS priority: ${(error as Error).message}`);
    }
  }
  const browser = await chromium.connect(browserServer.wsEndpoint());
  const s = state();
  s.browser = browser;
  s.browserServer = browserServer;
  s.consecutiveFailures = 0;
  s.sawFirstSuccess = false;

  browser.on('disconnected', () => {
    if (s.browser === browser) s.browser = null;
    if (s.browserServer === browserServer) s.browserServer = null;
    if (s.reloadTimer) {
      clearInterval(s.reloadTimer);
      s.reloadTimer = null;
    }
    if (s.reloadTimerB) {
      clearInterval(s.reloadTimerB);
      s.reloadTimerB = null;
    }
  });

  const context = await browser.newContext({ userAgent: REALISTIC_UA });
  await context.addCookies(cookieHeaderToPlaywrightCookies(cookieHeader, SITE_URL));

  const marketPulsePage = await context.newPage();
  marketPulsePage.on('response', (response) => void handleResponse(response).catch(() => undefined));
  const sectorScopePage = await context.newPage();
  sectorScopePage.on('response', (response) => void handleResponse(response).catch(() => undefined));

  // Each page's initial navigation is independent — a timeout or nav error on
  // ONE (e.g. a slow market-pulse load) must never take down the other or the
  // whole launch. Before this fix, an unhandled goto() failure here threw out
  // of launch(), which the caller's catch treated as "browser launch failed"
  // and closed the ENTIRE browser — killing a perfectly good sector-scope tab
  // over an unrelated market-pulse hiccup (confirmed live 2026-08-08: 15
  // successful all_sector/daily-index captures, then reported "not running").
  // The reload loop below retries both every RELOAD_INTERVAL_MS regardless,
  // so a failed first load here just means the first reload is the real one.
  // SEQUENTIAL, not Promise.all: real historical CPU data (2026-08-24) showed
  // this box's average CPU jumped from ~3% to 40-65% the day this browser
  // shipped — two Chromium renderers doing navigation/JS work in the SAME
  // instant is exactly the kind of concurrent spike that costs more than the
  // same work spread out, on a 2 vCPU box with nothing else to give.
  await marketPulsePage.goto(MARKET_PULSE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  await sectorScopePage.goto(SECTOR_SCOPE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  // A few seconds for Chromium's own process to finish settling after both
  // page loads — reading memory immediately after goto() would under-count it.
  setTimeout(() => logMemory('~5s after page load (steady-state cost)'), 5_000);

  // WE drive every subsequent attempt on BOTH tabs — see RELOAD_INTERVAL_MS's
  // module note on why neither page's own polling loop can be trusted to
  // keep going by itself. STAGGERED across two timers (not one firing both):
  // each tab still reloads every RELOAD_INTERVAL_MS, but sector-scope's timer
  // starts half an interval after market-pulse's, so the two reload-driven
  // JS/render bursts never land in the same instant — same capture cadence
  // and freshness per tab, half the peak concurrent Chromium load.
  if (s.reloadTimer) clearInterval(s.reloadTimer);
  if (s.reloadTimerB) clearInterval(s.reloadTimerB);
  s.reloadTimer = setInterval(() => {
    if (s.browser !== browser) return; // stale timer from a since-replaced browser
    void marketPulsePage.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  }, RELOAD_INTERVAL_MS);
  s.reloadTimer.unref?.();
  const staggerTimeout = setTimeout(() => {
    if (s.browser !== browser) return; // browser already closed/replaced before the offset elapsed
    s.reloadTimerB = setInterval(() => {
      if (s.browser !== browser) return;
      void sectorScopePage.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    }, RELOAD_INTERVAL_MS);
    s.reloadTimerB.unref?.();
  }, RELOAD_INTERVAL_MS / 2);
  staggerTimeout.unref?.();

  // Give our own reload loop a bounded number of rounds to prove the session
  // is real before declaring it broken — a slow first load is normal, total
  // silence across several reloads is not.
  setTimeout(() => {
    void (async () => {
      if (s.browser === browser && !s.sawFirstSuccess) {
        await recordTfBrowserOutcome(
          false,
          `no successful TradeFinder response within ${FIRST_SUCCESS_TIMEOUT_MS / 1000}s of loading ${MARKET_PULSE_URL} or ${SECTOR_SCOPE_URL} — the session may be logged out`
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
  if (s.reloadTimerB) {
    clearInterval(s.reloadTimerB);
    s.reloadTimerB = null;
  }
  const browser = s.browser;
  const browserServer = s.browserServer;
  s.browser = null;
  s.browserServer = null;
  if (browser) await browser.close().catch(() => undefined);
  // browser.close() on a connect()-obtained Browser only ends OUR connection —
  // it does not kill the process launchServer() started. browserServer.close()
  // is what actually terminates it (Playwright: "makes sure the process is
  // terminated"); without this every restart would leak an orphaned Chromium.
  if (browserServer) await browserServer.close().catch(() => undefined);
  if (browser || browserServer) logMemory('after close (should return near the "before launch" figure)');
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
