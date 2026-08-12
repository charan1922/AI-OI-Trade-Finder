/**
 * Bench for lib/nse/pulse-cache.ts — the guards that keep a slow or blocked NSE
 * off the /live critical path.
 *
 * Why this needs a bench: POST /api/live/quote awaits the oi-spurts feed for its
 * display columns, and the /live client abandons the request after 8s
 * (FETCH_TIMEOUT_MS in app/live/_lib/quote-scheduler.ts). An NSE miss from a
 * datacentre IP can run for tens of seconds — cookie warm-up (2 × 6s) + API
 * timeout (9s) + one 401/403 retry — so without these guards the page shows a
 * wall of `(canceled)` quote requests with nothing actually wrong on the Dhan
 * side. Pure and network-free (the fetcher is stubbed), so it runs in CI rather
 * than only on a box with credentials.
 */

import type { FeedKey } from '@/lib/nse/pulse';
import {
  __PULSE_CACHE_TUNING as TUNING,
  __resetPulseCacheForTest,
  __seedPulseCacheForTest,
  getPulseFeed,
} from '@/lib/nse/pulse-cache';

const FEED = 'oiSpurts' as FeedKey;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A stub feed fetcher with a controllable delay and outcome. */
function stub(opts: { delayMs?: number; fail?: boolean; value?: unknown } = {}) {
  const calls = { n: 0 };
  const fn = async (): Promise<unknown> => {
    calls.n++;
    if (opts.delayMs) await sleep(opts.delayMs);
    if (opts.fail) throw new Error('NSE blocked');
    return opts.value ?? [{ symbol: 'RELIANCE' }];
  };
  return { calls, map: { [FEED]: fn } as Record<string, () => Promise<unknown>> };
}

async function main(): Promise<void> {
  console.log('\nNSE pulse cache — /live latency guards\n');

  // ── 1. A fresh hit never touches upstream ─────────────────────────────────
  {
    const s = stub();
    __resetPulseCacheForTest(s.map);
    const a = await getPulseFeed(FEED);
    const b = await getPulseFeed(FEED);
    check('fresh hit served from cache', s.calls.n === 1, `upstream called ${s.calls.n}×`);
    check('fresh hit not flagged stale', a.stale === false && b.stale === false);
    check('fresh hit reports cached', b.cached === true);
  }

  // ── 2. Concurrent misses coalesce into ONE upstream fetch ─────────────────
  // Four /live sections × N open windows used to each start their own cookie
  // warm-up — the stampede that gets us throttled in the first place.
  {
    const s = stub({ delayMs: 60 });
    __resetPulseCacheForTest(s.map);
    const results = await Promise.all([getPulseFeed(FEED), getPulseFeed(FEED), getPulseFeed(FEED), getPulseFeed(FEED)]);
    check('4 concurrent misses → 1 upstream fetch', s.calls.n === 1, `upstream called ${s.calls.n}×`);
    check('every joiner gets the data', results.every((r) => Array.isArray(r.data)));
  }

  // ── 3. maxWaitMs caps the block; the caller falls back to the last value ──
  // THE /live fix: a display column may be a little old, never a dead request.
  {
    const slow = stub({ delayMs: 3_000, value: [{ symbol: 'NEW' }] });
    __resetPulseCacheForTest(slow.map);
    __seedPulseCacheForTest(FEED, [{ symbol: 'OLD' }], TUNING.FRESH_MS + 1_000);

    const t0 = Date.now();
    const res = await getPulseFeed<{ symbol: string }[]>(FEED, { maxWaitMs: 150 });
    const elapsed = Date.now() - t0;

    check('slow upstream does not hold the caller', elapsed < 1_000, `waited ${elapsed}ms`);
    check('caller gets the last captured value', res.data[0]?.symbol === 'OLD');
    check('held-over value is flagged stale', res.stale === true);
    check('fetchedAt reports the value’s real age, not now', Date.now() - res.fetchedAt >= TUNING.FRESH_MS);
    check('the refresh was still started', slow.calls.n === 1, `upstream called ${slow.calls.n}×`);

    // ...and it keeps running in the background, so the NEXT caller is fresh.
    await sleep(3_200);
    const after = await getPulseFeed<{ symbol: string }[]>(FEED);
    check('background refresh populated the cache', after.data[0]?.symbol === 'NEW');
    check('the refreshed value is not stale', after.stale === false);
  }

  // ── 4. No caller waits longer than it asked, even with nothing cached ─────
  {
    const slow = stub({ delayMs: 3_000 });
    __resetPulseCacheForTest(slow.map);
    const t0 = Date.now();
    let threw = false;
    try {
      await getPulseFeed(FEED, { maxWaitMs: 150 });
    } catch {
      threw = true;
    }
    const elapsed = Date.now() - t0;
    check('cold miss + maxWaitMs returns inside the cap', elapsed < 1_000, `waited ${elapsed}ms`);
    check('cold miss + deadline throws rather than fabricating', threw);
  }

  // ── 5. A failure trips a cooldown: the next caller does NOT re-hit NSE ────
  // Without this a blocked NSE makes EVERY request pay the full penalty.
  {
    const s = stub({ fail: true });
    __resetPulseCacheForTest(s.map);
    let firstThrew = false;
    try {
      await getPulseFeed(FEED);
    } catch {
      firstThrew = true;
    }
    let secondThrew = false;
    try {
      await getPulseFeed(FEED);
    } catch {
      secondThrew = true;
    }
    check('cold miss whose fetch fails throws', firstThrew);
    check('a second cold call also throws (nothing to serve)', secondThrew);
    check('cooldown suppressed the second upstream attempt', s.calls.n === 1, `upstream called ${s.calls.n}×`);
  }

  // ── 6. Cooling down WITH a cached value serves it instead of failing ──────
  {
    const s = stub({ fail: true });
    __resetPulseCacheForTest(s.map);
    __seedPulseCacheForTest(FEED, [{ symbol: 'LAST_GOOD' }], TUNING.FRESH_MS + 1_000);
    const first = await getPulseFeed<{ symbol: string }[]>(FEED); // fails upstream, serves cache
    const second = await getPulseFeed<{ symbol: string }[]>(FEED); // cooling down, no upstream
    check('failed refresh serves the last good value', first.data[0]?.symbol === 'LAST_GOOD');
    check('and flags it stale', first.stale === true && second.stale === true);
    check('cooldown blocked a second upstream attempt', s.calls.n === 1, `upstream called ${s.calls.n}×`);
  }

  // ── 7. A value older than MAX_SERVE_AGE_MS is not passed off as usable ───
  {
    const s = stub({ fail: true });
    __resetPulseCacheForTest(s.map);
    __seedPulseCacheForTest(FEED, [{ symbol: 'ANCIENT' }], TUNING.MAX_SERVE_AGE_MS + 1_000);
    let threw = false;
    try {
      await getPulseFeed(FEED);
    } catch {
      threw = true;
    }
    check('an over-age value is not served as a fallback', threw);
  }

  // ── 8. Tuning stays inside the /live latency budget ──────────────────────
  {
    check('failure cooldown is a full minute', TUNING.FAILURE_COOLDOWN_MS === 60_000);
    check('stale window is bounded, and wider than fresh', TUNING.MAX_SERVE_AGE_MS > TUNING.FRESH_MS && TUNING.MAX_SERVE_AGE_MS <= 30 * 60_000);
  }

  __resetPulseCacheForTest();

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
