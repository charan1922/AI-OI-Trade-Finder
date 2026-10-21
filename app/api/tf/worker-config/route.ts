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

import { sendCriticalAlert } from '@/lib/auto-trade/alerts';
import {
  checkCaptureStall,
  noteWorkerConfigServed,
  noteWorkerSeen,
  recentUntrackedPaths,
  shouldAlertUntracked,
  shouldWorkerRun,
} from '@/lib/tf-live/browser';
import { CAPTURE_STALL_MS } from '@/lib/tf-live/worker-protocol';
import { cookieHeaderToPlaywrightCookies } from '@/lib/tf-live/parse-curl';
import { getTfBrowserCookies, recordTfBrowserOutcome } from '@/lib/tf-live/store';
import { verifyWorkerSecret, WORKER_SECRET_HEADER } from '@/lib/tf-live/worker-protocol';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The TradeFinder pages the worker opens. /marketPulse fires BOTH captured
 *  feeds (`market_pulse` and `sector_scope`, verified on the worker box), so it
 *  is the only page — one Chromium tab on a 1GB host.
 *
 *  Adding a feed that lives on another TradeFinder page means adding its URL
 *  here — and nothing else. The worker re-reads this every poll. */
const TF_PAGES = ['https://tradefinder.in/marketPulse'];
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
    noteWorkerConfigServed(shouldWorkerRun());
    await healCaptureStall();
    const shouldRun = shouldWorkerRun();
    noteWorkerConfigServed(shouldRun);
    const cookieHeader = await getTfBrowserCookies();
    return NextResponse.json({
      shouldRun,
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

/**
 * Self-heal for a wedged worker browser (2026-10-16: Chromium at ~97% CPU from
 * its 09:20 launch, zero captures and zero errors, green badge all morning).
 * When the worker has been told to run for CAPTURE_STALL_MS with nothing
 * delivered, answer THIS poll with shouldRun=false so the worker closes
 * Chromium, then reopens it on the next — the worker already obeys that, so
 * the fix needs no worker redeploy. The reason goes on /tf (badge turns
 * "running, not capturing") and the operator is told once per outage.
 */
async function healCaptureStall(): Promise<void> {
  const stall = checkCaptureStall();
  const minutes = Math.round(CAPTURE_STALL_MS / 60_000);
  if (stall.verdict === 'feeds-untracked') {
    // The browser works (it forwards TradeFinder traffic) but no market data arrives.
    // 2026-10-19..21: the cause was a LAPSED TradeFinder login — a logged-out page still
    // fires servertime / banners / feature-flags / market status, but never the data
    // calls; the paths themselves were unchanged (re-checked live: market_pulse and
    // sector_scope still answer SUCCESS when logged in). So name the likely cause first,
    // and show what WAS forwarded, so a genuinely renamed feed is visible too.
    // A restart cannot fix either, so none is attempted.
    const seen = recentUntrackedPaths()
      .slice(0, 6)
      .map((p) => p.path.replace(/^\/api_be\//, ''))
      .join(', ');
    const message =
      `No TradeFinder market data for ${minutes}+ min although the worker's page is loading — ` +
      `the TradeFinder login has most likely expired: paste a fresh cURL from a logged-in marketPulse tab. ` +
      `Only these calls arrived: ${seen || 'none recorded'}. ` +
      `(If market data appears there under a new name, endpointTagFor() needs it.)`;
    await recordTfBrowserOutcome(false, message);
    if (shouldAlertUntracked()) {
      sendCriticalAlert(`⚠️ TF capture: ${message} No fresh board = no entries.`);
    }
    return;
  }
  if (!stall.restarted || !stall.episode) return;
  const n = stall.episode.restarts;
  const message = `No TradeFinder capture for ${minutes}+ min while the worker was running — auto-restarted its Chromium (attempt ${n})`;
  console.warn(`[tf_worker] ${message}`);
  await recordTfBrowserOutcome(false, message);
  // Once per outage, plus a nudge every 3rd failed attempt (~20 min) so a
  // restart that keeps not working cannot go quiet.
  if (stall.firstInEpisode || n % 3 === 0) {
    sendCriticalAlert(
      `⚠️ TF capture stalled: ${message}.${n >= 3 ? ' Restarts are not fixing it — check the tf-worker host (CPU/memory) or paste a fresh cURL on /tf.' : ''} No fresh board = no entries.`,
    );
  }
}
