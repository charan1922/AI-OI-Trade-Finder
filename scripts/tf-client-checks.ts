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
}
