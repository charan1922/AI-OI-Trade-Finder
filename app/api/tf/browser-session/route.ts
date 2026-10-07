import { NextResponse } from 'next/server';

import { adminOnly } from '@/lib/auth/server';
import { todayIST } from '@/lib/ist';
import { forceStartTfBrowser, isTfBrowserRunning, restartTfBrowser, stopTfBrowser } from '@/lib/tf-live/browser';
import { parseMarketPulse, parseSectorScope } from '@/lib/tf-live/parse';
import { extractCookieHeaderFromCurl } from '@/lib/tf-live/parse-curl';
import {
  assertTfLiveSessionKeyConfigured,
  clearTfLiveCaptureHistory,
  getLatestTfLiveCaptures,
  getTfBrowserSessionStatus,
  getTfCaptureCountsForDate,
  getTfLiveCaptureForDate,
  saveTfBrowserCookies,
} from '@/lib/tf-live/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** ONE endpoint for everything /tf shows: the browser cookie session status,
 *  whether it's running, the last capture and today's counts per feed, and with
 *  `?data=1` today's data itself. Never returns the stored cookie value. */
export async function GET(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    return NextResponse.json(await statusBody(new URL(req.url).searchParams.get('data') === '1'));
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}

async function statusBody(withData: boolean) {
  const [session, captures, counts, today] = await Promise.all([
    getTfBrowserSessionStatus(),
    getLatestTfLiveCaptures(),
    getTfCaptureCountsForDate(todayIST()),
    withData ? getTodaysData() : Promise.resolve(undefined),
  ]);
  return { success: true, session, running: isTfBrowserRunning(), captures, counts, today };
}

/** `?data=1`: the latest successful capture of each feed TODAY (IST), parsed —
 *  what /tf shows as its data tables. Older days live on /tf/history. */
async function getTodaysData() {
  const date = todayIST();
  const [sector, pulse] = await Promise.all([
    getTfLiveCaptureForDate('sector_scope', date),
    getTfLiveCaptureForDate('market_pulse', date),
  ]);
  return {
    date,
    sectorScope: sector ? { capturedAt: sector.capturedAt, rows: parseSectorScope(sector.payload) } : null,
    marketPulse: pulse ? { capturedAt: pulse.capturedAt, lists: parseMarketPulse(pulse.payload) } : null,
  };
}

/** Clear the capture log — the "Clear history" button on /tf. Leaves the browser cookie jar
 *  untouched; only the capture log is wiped. */
export async function DELETE(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    await clearTfLiveCaptureHistory();
    return NextResponse.json(await statusBody(true));
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}

/**
 * Accept a pasted "Copy as cURL" of any tradefinder.in request, pull the
 * Cookie header out of it (see lib/tf-live/parse-curl.ts), and store it —
 * encrypted at rest. Never validated with a network call here: proving a
 * cookie jar works means the worker actually opening TradeFinder with it,
 * which it does on its next poll. `action:'start'`
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
    if (body.action === 'restart') {
      await restartTfBrowser();
      return NextResponse.json({ success: true, running: isTfBrowserRunning(), pending: 'restart-requested' });
    }

    if (typeof body.curl !== 'string') {
      return NextResponse.json(
        { success: false, error: 'body must be { curl: string } or { action: "start"|"stop"|"restart" }' },
        { status: 400 }
      );
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
