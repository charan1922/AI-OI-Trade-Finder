import {
  WORKER_LIVENESS_MS,
  WORKER_SECRET_HEADER,
  isWorkerAlive,
  parseIngestPayload,
  verifyWorkerSecret,
} from '@/lib/tf-live/worker-protocol';

let failures = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function main(): void {
  // ── Secret verification must FAIL CLOSED: this guards the endpoint that
  //    serves the live TradeFinder session cookie. ──
  check('header name is lowercase (Next normalizes incoming headers)', WORKER_SECRET_HEADER === 'x-tf-worker-secret');
  check('matching secret is accepted', verifyWorkerSecret('s3cret', 's3cret', true));
  check('wrong secret is rejected', !verifyWorkerSecret('nope', 's3cret', true));
  check('null supplied secret is rejected', !verifyWorkerSecret(null, 's3cret', true));
  check('empty supplied secret is rejected', !verifyWorkerSecret('', 's3cret', true));
  check('unset secret in PRODUCTION rejects everything', !verifyWorkerSecret('anything', undefined, true));
  check('unset secret in production rejects null too', !verifyWorkerSecret(null, undefined, true));
  check('empty-string secret is treated as unset, not a valid password', !verifyWorkerSecret('', '', true));
  // Local dev with no secret stays usable — the same concession
  // verifyWebhookSecret() makes in lib/telegram/bot.ts.
  check('unset secret in DEV allows the local worker', verifyWorkerSecret('anything', undefined, false));

  // ── Liveness replaces "is there a local browser object". ──
  const now = 1_700_000_000_000;
  check('never-seen worker is not alive', !isWorkerAlive(null, now));
  check('just-seen worker is alive', isWorkerAlive(now - 1_000, now));
  check('one missed 60s poll does not false-alarm', isWorkerAlive(now - 90_000, now));
  check('liveness window is 3 minutes', WORKER_LIVENESS_MS === 180_000);
  check('stale beyond the window is not alive', !isWorkerAlive(now - WORKER_LIVENESS_MS - 1, now));
  check('exactly at the boundary is still alive', isWorkerAlive(now - WORKER_LIVENESS_MS, now));
  check('a future timestamp is not trusted', !isWorkerAlive(now + 60_000, now));
  check('non-finite last-seen fails closed', !isWorkerAlive(Number.NaN, now));

  // ── Ingest body validation: garbage must not reach the store layer. ──
  const heartbeat = parseIngestPayload({ heartbeat: true });
  check('heartbeat parses', 'payload' in heartbeat && heartbeat.payload.kind === 'heartbeat');

  const response = parseIngestPayload({
    pathname: '/api_be/data/order/all_sector',
    status: 200,
    ok: true,
    body: { status: 'SUCCESS' },
  });
  check(
    'well-formed response keeps its fields',
    'payload' in response &&
      response.payload.kind === 'response' &&
      response.payload.pathname === '/api_be/data/order/all_sector' &&
      response.payload.status === 200 &&
      response.payload.ok === true,
  );

  check('null body is rejected', 'error' in parseIngestPayload(null));
  check('a bare string is rejected', 'error' in parseIngestPayload('all_sector'));
  check('an array is rejected', 'error' in parseIngestPayload([{ pathname: '/api_be/x' }]));
  check('missing pathname is rejected', 'error' in parseIngestPayload({ status: 200, ok: true, body: {} }));
  check(
    'non-string pathname is rejected',
    'error' in parseIngestPayload({ pathname: 42, status: 200, ok: true, body: {} }),
  );
  check(
    'non-numeric status is rejected',
    'error' in parseIngestPayload({ pathname: '/api_be/x', status: 'ok', ok: true, body: {} }),
  );
  check(
    'an over-long pathname is rejected',
    'error' in parseIngestPayload({ pathname: `/api_be/${'x'.repeat(4_000)}`, status: 200, ok: true, body: {} }),
  );
  check(
    'ok is derived from status when omitted',
    (() => {
      const parsed = parseIngestPayload({ pathname: '/api_be/x', status: 503, body: {} });
      return 'payload' in parsed && parsed.payload.kind === 'response' && parsed.payload.ok === false;
    })(),
  );
}

main();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
