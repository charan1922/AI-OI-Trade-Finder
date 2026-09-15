import { NextResponse } from 'next/server';

import { adminOnly } from '@/lib/auth/server';
import { forceStartTfBrowser, isTfBrowserRunning, stopTfBrowser } from '@/lib/tf-live/browser';
import { extractCookieHeaderFromCurl } from '@/lib/tf-live/parse-curl';
import {
  assertTfLiveSessionKeyConfigured,
  clearTfLiveCaptureHistory,
  getLatestTfLiveCaptures,
  getTfBrowserSessionStatus,
  getTfLiveCaptureHistory,
  saveTfBrowserCookies,
} from '@/lib/tf-live/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** ONE endpoint for everything /tf shows: the browser cookie session status,
 *  whether it's running, and the capture log — folded together 2026-08-08 so
 *  the page doesn't need two separate polls for what's really one screen.
 *  Never returns the stored cookie value. */
export async function GET(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const [session, captures, history] = await Promise.all([
      getTfBrowserSessionStatus(),
      getLatestTfLiveCaptures(),
      getTfLiveCaptureHistory(),
    ]);
    return NextResponse.json({ success: true, session, running: isTfBrowserRunning(), captures, history });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}

/** Clear the "Last capture per endpoint" / "Capture history by date" tables —
 *  the "Clear history" button on /tf. Leaves the browser cookie jar
 *  untouched; only the capture log is wiped. */
export async function DELETE(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    await clearTfLiveCaptureHistory();
    const [session, captures, history] = await Promise.all([
      getTfBrowserSessionStatus(),
      getLatestTfLiveCaptures(),
      getTfLiveCaptureHistory(),
    ]);
    return NextResponse.json({ success: true, session, running: isTfBrowserRunning(), captures, history });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}

/**
 * Accept a pasted "Copy as cURL" of any tradefinder.in request, pull the
 * Cookie header out of it (see lib/tf-live/parse-curl.ts), and store it —
 * encrypted, same scheme as lt/at. Never validated with a network call here
 * the way lt/at is: proving a cookie jar works means actually launching
 * Chromium, which the watchdog does within a minute anyway. `action:'start'`
 * or `action:'stop'` control the browser directly for manual testing.
 */
export async function POST(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const body = (await req.json()) as { curl?: unknown; action?: unknown };

    if (body.action === 'start') {
      await forceStartTfBrowser();
      // isTfBrowserRunning() now describes the REMOTE worker, which cannot have
      // reacted inside this request — it picks the override up on its next poll.
      // `pending` says what was asked for so the UI isn't reading a stale
      // liveness value as if it were the result of the click.
      return NextResponse.json({ success: true, running: isTfBrowserRunning(), pending: 'start-requested' });
    }
    if (body.action === 'stop') {
      await stopTfBrowser();
      return NextResponse.json({ success: true, running: isTfBrowserRunning(), pending: 'stop-requested' });
    }

    if (typeof body.curl !== 'string') {
      return NextResponse.json({ success: false, error: 'body must be { curl: string } or { action: "start"|"stop" }' }, { status: 400 });
    }
    const parsed = extractCookieHeaderFromCurl(body.curl);
    if ('error' in parsed) {
      return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
    }
    assertTfLiveSessionKeyConfigured();
    await saveTfBrowserCookies(parsed.cookieHeader);
    // The remote worker re-reads cookies from /api/tf/worker-config on every
    // poll, so a fresh paste takes effect within one cadence with no restart to
    // orchestrate from here. Clearing then re-opening the manual override just
    // guarantees the worker is allowed to run right now — including off-hours —
    // so the operator gets feedback without waiting for the capture window.
    await stopTfBrowser();
    await forceStartTfBrowser();
    return NextResponse.json({ success: true, running: isTfBrowserRunning(), pending: 'cookies-saved' });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 400 });
  }
}
