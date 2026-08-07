/**
 * PURE checks for the TradeFinder request queue (lib/tf-live/client.ts).
 *
 * The queue exists because TradeFinder refuses BURSTS, reporting them with the
 * same AT_ERROR code a dead token gets (see client.ts for the prod timeline
 * that established this). So the properties below are the whole fix, and a
 * regression in any of them silently returns us to 0 successful captures a day:
 *
 *   • no two requests ever overlap, even from different callers
 *   • consecutive requests are spaced by at least MIN_REQUEST_GAP_MS
 *   • a refusal is retried exactly once, a network fault is not
 *   • one failure never wedges the queue for everything after it
 *
 * No DB and no real network: `fetch` is stubbed. Wired into
 * scripts/verify-quant-shadow.ts, which the build workflow runs.
 */
import { MIN_REQUEST_GAP_MS, tfFetch } from '../lib/tf-live/client';
import { humanAgo, isTransientTfError, summarizeTfHealth } from '../lib/tf-live/status';

export type CheckFn = (name: string, ok: boolean, detail?: string) => void;

const TOKENS = { lt: 'lt-value', at: 'at-value' };
const URL_A = 'https://tradefinder.in/api_be/data/order/all_sector';

interface Call {
  at: number;
  url: string;
  headers: Record<string, string>;
}

/** Replace global fetch with a scripted stub; returns the call log + a restore fn. */
function stubFetch(responder: (callIndex: number) => { status?: number; body: string } | 'network-error') {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const index = calls.length;
    calls.push({ at: Date.now(), url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    const scripted = responder(index);
    if (scripted === 'network-error') throw Object.assign(new Error('boom'), { name: 'TypeError' });
    return {
      ok: (scripted.status ?? 200) < 400,
      status: scripted.status ?? 200,
      text: async () => scripted.body,
    };
  }) as unknown as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const OK_BODY = JSON.stringify({ status: 'SUCCESS', payload: { data: {} } });
const REFUSED_BODY = JSON.stringify({ status: 'ERROR', code: 'AT_ERROR', message: 'INVALID TOKEN' });

export async function runTfClientChecks(check: CheckFn): Promise<void> {
  // ── spacing: two concurrent callers are serialized AND spaced ─────────────
  {
    const { calls, restore } = stubFetch(() => ({ body: OK_BODY }));
    try {
      const started = Date.now();
      const [a, b] = await Promise.all([tfFetch(URL_A, TOKENS), tfFetch(URL_A, TOKENS)]);
      const elapsed = Date.now() - started;
      check('tf client: both concurrent requests succeed', a.ok && b.ok);
      check('tf client: exactly two requests were made', calls.length === 2, `made ${calls.length}`);
      const gap = calls.length === 2 ? calls[1].at - calls[0].at : -1;
      check(
        'tf client: concurrent callers are SPACED, not fired together',
        gap >= MIN_REQUEST_GAP_MS - 50,
        `gap ${gap}ms, floor ${MIN_REQUEST_GAP_MS}ms`
      );
      check('tf client: the spacing actually costs wall-clock time', elapsed >= MIN_REQUEST_GAP_MS - 50, `${elapsed}ms`);
    } finally {
      restore();
    }
  }

  // ── auth headers are exactly the two TradeFinder expects ─────────────────
  {
    const { calls, restore } = stubFetch(() => ({ body: OK_BODY }));
    try {
      await tfFetch(URL_A, TOKENS);
      const h = calls[0]?.headers ?? {};
      check('tf client: sends jwtToken = lt', h.jwtToken === 'lt-value');
      check('tf client: sends accessToken = at', h.accessToken === 'at-value');
      check('tf client: sends no cookie header', !('cookie' in h) && !('Cookie' in h));
    } finally {
      restore();
    }
  }

  // ── a refusal is retried exactly once, and can succeed on the retry ──────
  {
    const { calls, restore } = stubFetch((i) => ({ body: i === 0 ? REFUSED_BODY : OK_BODY }));
    try {
      const result = await tfFetch(URL_A, TOKENS);
      check('tf client: a throttled request is retried and can then succeed', result.ok, result.error ?? '');
      check('tf client: the retry is a SECOND request', calls.length === 2, `made ${calls.length}`);
      check('tf client: attempts are reported honestly', result.attempts === 2, `attempts ${result.attempts}`);
    } finally {
      restore();
    }
  }

  // ── a persistent refusal gives up after ONE retry (no hammering) ─────────
  {
    const { calls, restore } = stubFetch(() => ({ body: REFUSED_BODY }));
    try {
      const result = await tfFetch(URL_A, TOKENS);
      check('tf client: a persistent refusal fails', !result.ok);
      check('tf client: it stops after exactly 2 attempts', calls.length === 2, `made ${calls.length}`);
      check(
        "tf client: the error keeps TradeFinder's own code and notes the retry",
        (result.error ?? '').includes('AT_ERROR') && (result.error ?? '').includes('retry'),
        result.error ?? ''
      );
    } finally {
      restore();
    }
  }

  // ── a NETWORK fault is not retried — the next tick is the retry ──────────
  {
    const { calls, restore } = stubFetch(() => 'network-error');
    try {
      const result = await tfFetch(URL_A, TOKENS);
      check('tf client: a network fault fails', !result.ok);
      check('tf client: a network fault is NOT retried', calls.length === 1, `made ${calls.length}`);
      check('tf client: a network fault is not labelled a refusal', result.refused === false);
    } finally {
      restore();
    }
  }

  // ── HTTP error and non-JSON are refusals, never silent successes ─────────
  {
    const { restore } = stubFetch(() => ({ status: 500, body: 'oops' }));
    try {
      const result = await tfFetch(URL_A, TOKENS);
      check('tf client: HTTP 500 is a failure naming the status', !result.ok && (result.error ?? '').includes('500'));
    } finally {
      restore();
    }
  }
  {
    const { restore } = stubFetch(() => ({ body: '<html>login</html>' }));
    try {
      const result = await tfFetch(URL_A, TOKENS);
      check('tf client: a non-JSON body is a failure, never parsed as data', !result.ok);
    } finally {
      restore();
    }
  }

  // ── one failure must not wedge the queue for everything after it ─────────
  {
    // Only the FIRST call fails. A network fault is not retried, so the first
    // tfFetch consumes exactly one call and the second must get index 1.
    const { restore } = stubFetch((i) => (i === 0 ? 'network-error' : { body: OK_BODY }));
    try {
      const first = await tfFetch(URL_A, TOKENS);
      const second = await tfFetch(URL_A, TOKENS);
      check('tf client: the failing request fails', !first.ok);
      check('tf client: a LATER request still runs after a failure (queue not wedged)', second.ok, second.error ?? '');
    } finally {
      restore();
    }
  }

  // ── /tf health verdict ───────────────────────────────────────────────────
  // The banner must distinguish "paste a token" from "it heals itself". A
  // status line that cries wolf is worse than none: the one time it means
  // "act", it has to be believed.
  const NOW = Date.parse('2026-08-07T05:00:00.000Z');
  const base = {
    configured: true,
    jwtExpiresAt: '2026-08-07T07:00:00.000Z', // still valid
    lastError: null as string | null,
    lastSuccessAt: '2026-08-07T04:58:00.000Z',
    successesToday: 10,
    attemptsToday: 12,
    nowMs: NOW,
  };

  {
    const h = summarizeTfHealth(base);
    check('tf health: a clean tick is ok', h.level === 'ok', h.headline);
    check('tf health: ok needs no action', h.action === null);
  }

  {
    const h = summarizeTfHealth({ ...base, lastError: 'TradeFinder rejected it (AT_ERROR: INVALID TOKEN)' });
    check(
      'tf health: AT_ERROR with a LIVE token is a warning, not an error',
      h.level === 'warning',
      `${h.level}: ${h.headline}`
    );
    check('tf health: a self-healing state asks the operator to do NOTHING', h.action === null);
    check('tf health: it does not parrot the raw AT_ERROR string', !h.headline.includes('AT_ERROR'), h.headline);
    check('tf health: it explains the retry', h.detail.toLowerCase().includes('retries'), h.detail);
  }

  {
    // Same error text, but the token really is dead — THIS one must be red.
    const h = summarizeTfHealth({
      ...base,
      jwtExpiresAt: '2026-08-07T04:00:00.000Z',
      lastError: 'TradeFinder rejected it (AT_ERROR: INVALID TOKEN)',
    });
    check('tf health: an EXPIRED token is an error', h.level === 'error', h.headline);
    check('tf health: the expired case tells the operator exactly what to do', (h.action ?? '').includes('fresh'), h.action ?? '');
  }

  {
    const h = summarizeTfHealth({ ...base, configured: false, lastSuccessAt: null, successesToday: 0, attemptsToday: 0 });
    check('tf health: no stored session is an error with an action', h.level === 'error' && h.action != null);
  }

  {
    const h = summarizeTfHealth({ ...base, lastError: '2 of 4 feeds failed (sector_scope, market_pulse): rejected' });
    check('tf health: a PARTIAL failure is a warning, not a total failure', h.level === 'warning', h.headline);
    check('tf health: partial failure still surfaces the last good capture', h.headline.includes('ago'), h.headline);
  }

  check('tf health: transient classifier catches throttle, timeout and network',
    isTransientTfError('TradeFinder rejected it (AT_ERROR: INVALID TOKEN)') &&
    isTransientTfError('TradeFinder timed out (15s)') &&
    isTransientTfError('TradeFinder request failed (network)'));
  check('tf health: a genuinely unknown error is not silently called transient',
    !isTransientTfError('lt expired at 2026-08-07 — paste a fresh pair on /tf'));

  check('tf health: humanAgo renders minutes', humanAgo('2026-08-07T04:57:00.000Z', NOW) === '3 minutes ago');
  check('tf health: humanAgo handles a null timestamp', humanAgo(null, NOW) === null);
  check('tf health: humanAgo rejects an unparseable timestamp', humanAgo('not-a-date', NOW) === null);
}
