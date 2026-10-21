import {
  CAPTURE_STALL_MS,
  WORKER_LIVENESS_MS,
  captureStallVerdict,
  WORKER_SECRET_HEADER,
  isWorkerAlive,
  parseIngestPayload,
  verifyWorkerSecret,
} from '@/lib/tf-live/worker-protocol';
import { noteWorkerForward, recentUntrackedPaths, shouldAlertUntracked } from '@/lib/tf-live/browser';

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

  // ── Capture-stall self-heal (2026-10-16: Chromium wedged at ~97% CPU, zero
  //    captures, zero errors, green badge all morning). ──
  const stall = (wantedSinceMs: number | null, lastCaptureAtMs: number | null, lastForwardAtMs: number | null) =>
    captureStallVerdict({ nowMs: now, wantedSinceMs, lastCaptureAtMs, lastForwardAtMs });
  const past = now - CAPTURE_STALL_MS - 1;
  check('stall window is 5 minutes (three missed 90s reloads + launch)', CAPTURE_STALL_MS === 300_000);
  check('worker not meant to run → never stalled', stall(null, null, null) === 'ok');
  check('fresh run gets the full window before any restart', stall(now - CAPTURE_STALL_MS, null, null) === 'ok');
  check('the 2026-10-16 case: running, nothing delivered → browser-stalled', stall(past, null, null) === 'browser-stalled');
  check('a recent capture keeps an old run healthy', stall(past, now - 60_000, now - 60_000) === 'ok');
  check('captures that stopped → browser-stalled', stall(past - 600_000, past, past) === 'browser-stalled');
  check(
    'forwarding traffic but no tracked feed → feeds-untracked (restart would not help)',
    stall(past, null, now - 30_000) === 'feeds-untracked',
  );
  check('a future run start (clock skew) is not a stall', stall(now + 60_000, null, null) === 'ok');
}


// ── 2026-10-21: logged-out page = background calls only. Record them; alert at most hourly. ──
function untrackedChecks(): void {
  for (const p of ['/api_be/servertime', '/api_be/banners/active', '/api_be/servertime']) noteWorkerForward(false, p);
  const seen = recentUntrackedPaths();
  check('untracked: newest first, deduplicated', seen[0]?.path === '/api_be/servertime' && seen[1]?.path === '/api_be/banners/active' && seen.length === 2);
  check('untracked: repeat paths are counted', seen[0]?.count === 2 && seen[1]?.count === 1);
  for (let i = 0; i < 20; i++) noteWorkerForward(false, '/api_be/x' + i);
  check('untracked: list is capped at 12', recentUntrackedPaths().length === 12);
  check('untracked: a tracked delivery is not recorded as untracked', (noteWorkerForward(true, '/api_be/data/market_pulse'), !recentUntrackedPaths().some((p) => p.path.endsWith('market_pulse'))));
  const t0 = Date.UTC(2026, 9, 21, 9, 0);
  check('alert: fires the first time', shouldAlertUntracked(t0) === true);
  check('alert: silent within the hour', shouldAlertUntracked(t0 + 30 * 60_000) === false);
  check('alert: fires again after an hour', shouldAlertUntracked(t0 + 61 * 60_000) === true);
  noteWorkerForward(true, '/api_be/data/sector_scope');
  check('alert: a good capture re-arms it immediately', shouldAlertUntracked(t0 + 62 * 60_000) === true);
}

main();
untrackedChecks();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
