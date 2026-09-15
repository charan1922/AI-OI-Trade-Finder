/**
 * TradeFinder BROWSER relay — state and control for a real headless Chromium
 * that is started out logged in by an injected cookie jar, watches
 * TradeFinder's OWN JavaScript make its OWN requests, and records what comes
 * back.
 *
 * WHY THIS EXISTS — read lib/tf-live/client.ts's history first. Short version:
 * every attempt to capture and REPLAY TradeFinder's `accessToken` (the
 * sessionStorage `at` value) failed, including one captured live from a real,
 * currently-succeeding browser request and replayed under a second later. The
 * evidence says `at` is single-use, minted by TradeFinder's own frontend code
 * at the instant of each request — there is no way to fetch-and-replay it from
 * outside a real browser (confirmed exhaustively 2026-08-07/08).
 *
 * The relay sidesteps that instead of solving it: rather than minting `at`
 * ourselves, an ACTUAL Chromium runs with the cookies the operator's own
 * browser already has (see lib/tf-live/parse-curl.ts for how those are
 * captured) and navigates to the site. AS FAR AS TRADEFINDER CAN TELL THIS IS
 * A LOGGED-IN BROWSER, so their own code mints lt/at exactly as it does for a
 * human — we never touch lt/at at all.
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
 * "Copy as cURL" on /tf.
 *
 * WHERE THIS RUNS — NOT ON THE TRADING BOX ANY MORE (2026-08-24)
 * ---------------------------------------------------------------
 * Chromium used to launch in THIS process. Real historical CPU data settled
 * that it could not stay: the box averaged ~2.5-4% CPU on trading days before
 * this relay existed and ~37-65% sustained afterwards, with Fyers/Dhan polling
 * unchanged across both. Three in-place mitigations shipped and none fixed it —
 * resource-reduction Chromium flags (v1.55.5), staggered tab reloads
 * (v1.55.6), OS `nice` deprioritization (v1.55.7); a latency probe after the
 * last still caught a 13.4s stall on GET /api/health, a handler that does no
 * async work at all.
 *
 * Capture now runs on a separate host (deploy/tf-worker/worker.mjs) which polls
 * GET /api/tf/worker-config and POSTs what it sees to POST /api/tf/ingest.
 * What a response MEANS lives in lib/tf-live/ingest.ts — the worker judges
 * nothing, so TradeFinder's schema has exactly one copy.
 *
 * The local launch code is GONE, not commented out: unreachable code fails
 * no-unused-vars, and a dormant second copy of the response handling is the
 * drift risk this design exists to avoid — on a box we just proved cannot
 * afford to run it. Git history holds it.
 *
 * There is NO automatic fallback to launching locally. If the worker dies,
 * capture stops, and the existing TF_BOARD_MAX_AGE_MIN staleness gate already
 * refuses entries on a stale board (operator decision, 2026-08-24).
 *
 * This module therefore keeps only what the remote arrangement needs: the
 * worker's liveness signal, the manual run/stop override /tf drives, and the
 * consecutive-failure counter the ingest route feeds.
 *
 * Design: docs/superpowers/specs/2026-08-24-tf-browser-remote-worker-design.md
 */
import { withinCaptureWindow } from '@/lib/tf-live/collector';
import { isWorkerAlive, WORKER_LIVENESS_MS } from '@/lib/tf-live/worker-protocol';

/** A manual "Start now" (or a fresh cookie save) outside market hours used to
 *  get killed by the very next watchdog tick, at most 60s later, which made it
 *  impossible to just watch a capture run for a few minutes to confirm it works
 *  (user request, 2026-08-08). A manual start therefore stays in force for this
 *  long regardless of the time of day, then reverts to window-based behaviour. */
const MANUAL_TEST_DURATION_MS = 10 * 60_000;

interface BrowserState {
  /** Consecutive TradeFinder rejections, fed by the ingest route. Drives the
   *  alarm threshold in lib/tf-live/ingest.ts. */
  consecutiveFailures: number;
  /** Whether any capture has ever succeeded. Only chooses the alarm's wording —
   *  it must never suppress the alarm (see failureAlarmMessage). */
  sawFirstSuccess: boolean;
  /** Epoch ms until which a manual start keeps the worker running even outside
   *  the capture window. Null when there's no active manual override. */
  manualUntilMs: number | null;
  /** When the REMOTE worker last reached us (config poll, ingest, heartbeat).
   *  Null until it checks in for the first time. */
  lastWorkerSeenAtMs: number | null;
}

/** State lives on globalThis, not a module `let`: Turbopack HMR re-evaluates
 *  modules on every hot reload, and separate route bundles can hold their own
 *  copy — which would reset or duplicate the counters. globalThis is the one
 *  thing shared across all of them in a single server process. */
const store = globalThis as unknown as { __tfBrowserState?: BrowserState };
store.__tfBrowserState ??= {
  consecutiveFailures: 0,
  sawFirstSuccess: false,
  manualUntilMs: null,
  lastWorkerSeenAtMs: null,
};
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

/**
 * True while the REMOTE worker is capturing. Same signature and same meaning to
 * every caller ("is the relay working right now"), but the evidence changed:
 * Chromium no longer runs in this process, so there is no local browser object
 * to inspect — the worker's own traffic is the signal.
 *
 * Still deliberately honest: /tf reads *running, not capturing* whenever
 * `session.lastError` is set, so a worker that is alive but being rejected by
 * TradeFinder shows a warning rather than a green badge. That distinction is
 * the 2026-08-10 fix and it survives the move.
 */
export function isTfBrowserRunning(): boolean {
  return isWorkerAlive(state().lastWorkerSeenAtMs, Date.now());
}

/**
 * Boot hook, still called once from instrumentation.ts. There is no watchdog to
 * run any more: nothing local to keep alive, and the remote worker drives
 * itself off GET /api/tf/worker-config.
 */
export function startTfBrowserWatchdog(): void {
  console.log(
    `[tf_browser] local Chromium disabled — capture runs on the remote worker; liveness window ${WORKER_LIVENESS_MS / 1000}s`,
  );
}

/** /tf's "Start now" — opens the manual override window the worker polls via
 *  shouldWorkerRun(), so an operator can watch a capture run off-hours. Starts
 *  no local process, so expect up to one worker poll of delay rather than an
 *  instant start. */
export async function forceStartTfBrowser(): Promise<void> {
  state().manualUntilMs = Date.now() + MANUAL_TEST_DURATION_MS;
}

/** /tf's "Stop" — clears the manual override. Inside the capture window
 *  shouldWorkerRun() stays true regardless, so this only ends an off-hours test
 *  session; that is exactly how the in-process version behaved. */
export async function stopTfBrowser(): Promise<void> {
  state().manualUntilMs = null;
}
