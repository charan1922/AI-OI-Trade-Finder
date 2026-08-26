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

import { noteWorkerSeen, shouldWorkerRun } from '@/lib/tf-live/browser';
import { cookieHeaderToPlaywrightCookies } from '@/lib/tf-live/parse-curl';
import { getTfBrowserCookies } from '@/lib/tf-live/store';
import { verifyWorkerSecret, WORKER_SECRET_HEADER } from '@/lib/tf-live/worker-protocol';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The TradeFinder pages the worker opens. Each fires a different subset of the
 *  feeds endpoints.ts allowlists: /market-pulse fires `market_pulse`;
 *  /sector-scope fires `all_sector` AND `daily-index`.
 *
 *  Adding a feed that lives on another TradeFinder page means adding its URL
 *  here — and nothing else. The worker re-reads this every poll. */
const TF_PAGES = ['https://tradefinder.in/market-pulse', 'https://tradefinder.in/sector-scope'];
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
    const cookieHeader = await getTfBrowserCookies();
    return NextResponse.json({
      shouldRun: shouldWorkerRun(),
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
