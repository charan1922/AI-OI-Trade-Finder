import { TF_ENDPOINTS, TF_ENDPOINT_URL } from '@/lib/tf-live/endpoints';
import {
  CONSECUTIVE_FAILURE_LIMIT,
  classifyTfResponse,
  endpointTagFor,
  extractRows,
  failureAlarmMessage,
} from '@/lib/tf-live/ingest';

let failures = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function main(): void {
  // ── The allowlist IS the security boundary for what gets stored. ──
  check('all_sector maps from its real path', endpointTagFor('/api_be/data/order/all_sector') === 'all_sector');
  check('daily-index maps from its real path', endpointTagFor('/api_be/data/order/daily-index') === 'daily-index');
  // market_pulse sits under /api_be/data/, one segment shallower than the other
  // two (/api_be/data/order/) — TradeFinder's inconsistency, which must be
  // handled rather than assumed away. THIS CHECK CAUGHT A REAL PRODUCTION BUG
  // (2026-08-26): market_pulse had no endsWith case, so the generic fallback
  // produced 'data/market_pulse' and every response was silently dropped —
  // zero captures ever stored, versus 1,667 all_sector and 1,825 daily-index.
  check('market_pulse maps from its shallower path', endpointTagFor('/api_be/data/market_pulse') === 'market_pulse');
  // The generic fallback must never be trusted to derive a tracked tag on its
  // own: no real TradeFinder feed is shaped /api_be/<tag>, so a feed added to
  // the allowlist WITHOUT its own endsWith case above is silently dead. This
  // check exists so that mistake fails loudly here instead of in production.
  check(
    'every tracked feed has an explicit case — the fallback alone matches none of them',
    TF_ENDPOINTS.every((endpoint) => {
      const pathname = new URL(TF_ENDPOINT_URL[endpoint]).pathname;
      return endpointTagFor(pathname) === endpoint;
    }),
    TF_ENDPOINTS.map((e) => `${e}→${endpointTagFor(new URL(TF_ENDPOINT_URL[e]).pathname)}`).join(', '),
  );
  // Added 2026-08-26 (operator request): TradeFinder's own session/entitlement
  // probe, fired by their page on every load — so allowlisting it is what makes
  // it periodic; we never fetch it ourselves.
  check(
    'check_signal maps from its admin path',
    endpointTagFor('/api_be/admin/users/check_signal') === 'check_signal',
  );
  // Real traffic the page fires that nobody in this app reads.
  check('servertime is not tracked', endpointTagFor('/api_be/servertime') === null);
  check('feature_flag is not tracked', endpointTagFor('/api_be/feature_flag/feature_read') === null);
  check('rfactor_data is not tracked', endpointTagFor('/api_be/rfactor_filter/rfactor_data') === null);
  // TF's OWN sector_scope endpoint is unrelated to this app's /sector-scope page.
  check("TF's own sector_scope is not tracked", endpointTagFor('/api_be/data/order/sector_scope') === null);
  check('a non-api_be path is not tracked', endpointTagFor('/market-pulse') === null);
  check('an empty pathname is not tracked', endpointTagFor('') === null);

  // ── Response classification: TF answers HTTP 200 with a failure BODY. ──
  check('a real success is a success', classifyTfResponse(true, 200, { status: 'SUCCESS' }).outcome === 'success');
  const tokenError = classifyTfResponse(true, 200, {
    status: 'TOKEN_ERROR',
    code: 'TOKEN_ERROR',
    message: 'UNAUTHORISED',
  });
  check('HTTP 200 with a TOKEN_ERROR body is a REJECTION, not a success', tokenError.outcome === 'rejected');
  check(
    'the rejection names TF’s own code and message',
    tokenError.outcome === 'rejected' &&
      tokenError.detail.includes('TOKEN_ERROR') &&
      tokenError.detail.includes('UNAUTHORISED'),
  );
  const http500 = classifyTfResponse(false, 500, null);
  check('a transport failure is a rejection', http500.outcome === 'rejected');
  check(
    'a rejection with no code falls back to the status',
    http500.outcome === 'rejected' && http500.detail.includes('500'),
  );
  check('a null body is never read as success', classifyTfResponse(true, 200, null).outcome === 'rejected');
  check(
    'a missing status field is never read as success',
    classifyTfResponse(true, 200, { data: [] }).outcome === 'rejected',
  );
  check(
    'lowercase "success" is not accepted (TF sends uppercase)',
    classifyTfResponse(true, 200, { status: 'success' }).outcome === 'rejected',
  );

  // ── The 2026-08-10 lesson, now actually tested. ──
  check('limit is 6', CONSECUTIVE_FAILURE_LIMIT === 6);
  check('one transient failure raises no alarm', failureAlarmMessage(1, true, 'HTTP 500') === null);
  check(
    'below the limit raises no alarm',
    failureAlarmMessage(CONSECUTIVE_FAILURE_LIMIT - 1, true, 'HTTP 500') === null,
  );
  // THE BUG: this used to be suppressed once any request had ever succeeded, so
  // 263 consecutive failures over 3h20m hid behind a green badge.
  const midSession = failureAlarmMessage(CONSECUTIVE_FAILURE_LIMIT, true, 'TOKEN_ERROR: UNAUTHORISED');
  check('at the limit AFTER an earlier success, the alarm STILL fires', midSession !== null);
  check('the mid-session message says it was working earlier', midSession != null && /earlier/i.test(midSession));
  const neverWorked = failureAlarmMessage(CONSECUTIVE_FAILURE_LIMIT, false, 'TOKEN_ERROR: UNAUTHORISED');
  check('at the limit with no success ever, the alarm fires', neverWorked !== null);
  check('the never-worked message says it looks logged out', neverWorked != null && /logged out/i.test(neverWorked));
  check(
    'both messages tell the operator the fix (paste a fresh cURL)',
    midSession != null && neverWorked != null && /cURL/i.test(midSession) && /cURL/i.test(neverWorked),
  );
  check('past the limit keeps alarming', failureAlarmMessage(CONSECUTIVE_FAILURE_LIMIT + 20, true, 'x') !== null);

  // ── Row extraction stays delegated to the confirmed parsers. ──
  check('an unparsed feed yields no rows', extractRows('market_pulse', { status: 'SUCCESS' }) === undefined);
  check('a garbage all_sector payload yields no rows', extractRows('all_sector', { nope: true }) === undefined);
  check('an unknown tag yields no rows', extractRows('not_a_feed', {}) === undefined);
}

main();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
