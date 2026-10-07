import { TF_ENDPOINTS, TF_ENDPOINT_URL } from '@/lib/tf-live/endpoints';
import {
  CONSECUTIVE_FAILURE_LIMIT,
  classifyTfResponse,
  endpointTagFor,
  failureAlarmMessage,
} from '@/lib/tf-live/ingest';
import { TF_BOARD_ENDPOINTS } from '@/lib/tf-live/endpoints';
import {
  isPriceList,
  parseAllSector,
  parseMarketPulse,
  parseSectorScope,
  parseTfBoard,
  parseTfIndices,
} from '@/lib/tf-live/parse';

/** Reading a sector_scope payload with the OLD parser would treat 'all_sector'
 *  as a basket and each sector as a stock — rows with every value null. That is
 *  the silent-wrong-numbers failure parseTfBoard exists to prevent. */
function parseAllSectorShapeMisread(): boolean {
  const payload = { payload: { data: { all_sector: { 'NIFTY AUTO_r_factor': { ASHOKLEY: { Symbol: 'ASHOKLEY', param_3: 1.64 } } } } } };
  const misread = parseAllSector(payload);
  return misread.every((r) => r.rFactor == null) && parseTfBoard('sector_scope', payload).every((r) => r.rFactor != null);
}

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
  // Retired feeds must no longer be stored (operator request 2026-10-08).
  for (const [name, path] of [
    ['all_sector', '/api_be/data/order/all_sector'],
    ['rfactor_data', '/api_be/rfactor_filter/rfactor_data'],
    ['daily-index', '/api_be/data/order/daily-index'],
    ['check_signal', '/api_be/admin/users/check_signal'],
  ] as const) {
    check(`${name} is no longer captured`, endpointTagFor(path) === null);
  }
  check('exactly two feeds are captured', TF_ENDPOINTS.length === 2, TF_ENDPOINTS.join(', '));
  check('market_pulse maps from its shallower path', endpointTagFor('/api_be/data/market_pulse') === 'market_pulse');
  check('sector_scope maps from its /data/ path', endpointTagFor('/api_be/data/sector_scope') === 'sector_scope');
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
  // Real traffic the page fires that nobody in this app reads.
  check('servertime is not tracked', endpointTagFor('/api_be/servertime') === null);
  check('feature_flag is not tracked', endpointTagFor('/api_be/feature_flag/feature_read') === null);
  // Only the /data/sector_scope feed is tracked; a look-alike under /data/order/ is not.
  check('a sector_scope look-alike under /data/order/ is not tracked', endpointTagFor('/api_be/data/order/sector_scope') === null);
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

  // ── The two captured feeds. Fixtures copy real rows (2026-10-08 captures). ──
  // sector_scope nests the old all_sector board one level deeper.
  const sectorRows = parseSectorScope({
    status: 'SUCCESS',
    payload: {
      data: {
        all_sector: {
          'NIFTY AUTO_r_factor': {
            ASHOKLEY: { Symbol: 'ASHOKLEY', param_0: 149.4, param_1: 153.7, param_2: -2.8, param_3: 1.64 },
          },
          'NIFTY BANK_r_factor': {
            CANBK: { Symbol: 'CANBK', param_0: 118.7, param_1: 117.82, param_2: 0.75, param_3: 3.64 },
          },
          'NIFTY PSU BANK_r_factor': {
            CANBK: { Symbol: 'CANBK', param_0: 118.7, param_1: 117.82, param_2: 0.75, param_3: 3.64 },
          },
        },
      },
    },
  });
  const ashok = sectorRows.find((r) => r.symbol === 'ASHOKLEY');
  check('sector_scope: one row per symbol (de-duplicated across sectors)', sectorRows.length === 2);
  check(
    'sector_scope: param_0..3 = LTP, prev close, %, R-Factor',
    ashok?.ltp === 149.4 && ashok.previousClose === 153.7 && ashok.pctChange === -2.8 && ashok.rFactor === 1.64,
  );
  check(
    'sector_scope: a symbol keeps every sector it appears under',
    sectorRows.find((r) => r.symbol === 'CANBK')?.baskets.join('|') === 'NIFTY BANK|NIFTY PSU BANK',
  );
  // sector_scope ALSO carries the old daily-index sector values (2026-10-08 capture).
  const indices = parseTfIndices('sector_scope', {
    status: 'SUCCESS',
    payload: { data: { all_sector: {}, 'daily-index': [{ Symbol: 'NIFTY PSU BANK', param_3: 3.25 }] } },
  });
  check('sector_scope: its daily-index list yields the sector values', indices.length === 1 && indices[0].name === 'NIFTY PSU BANK' && indices[0].value === 3.25);
  check(
    'old daily-index captures still parse',
    parseTfIndices('daily-index', { payload: { data: [{ Symbol: 'NIFTY AUTO', param_3: 5.29 }] } })[0]?.value === 5.29,
  );
  // Every board reader goes through parseTfBoard, so each stored feed must route to its own parser.
  check('parseTfBoard: sector_scope rows', parseTfBoard('sector_scope', { payload: { data: { all_sector: { 'NIFTY AUTO_r_factor': { ASHOKLEY: { Symbol: 'ASHOKLEY', param_3: 1.64 } } } } } })[0]?.rFactor === 1.64);
  check('parseTfBoard: old all_sector rows', parseTfBoard('all_sector', { payload: { data: { 'NIFTY AUTO_r_factor': { ASHOKLEY: { Symbol: 'ASHOKLEY', param_3: 1.64 } } } } })[0]?.rFactor === 1.64);
  check(
    'parseTfBoard: sector_scope is NOT read as an old all_sector board (it is one level deeper)',
    parseAllSectorShapeMisread(),
  );
  check('board endpoints: sector_scope is read first', TF_BOARD_ENDPOINTS[0] === 'sector_scope');
  check('sector_scope: an unrelated payload yields no rows', parseSectorScope({ payload: { data: {} } }).length === 0);
  const pulse = parseMarketPulse({
    status: 'SUCCESS',
    payload: {
      data: {
        top_gainers: [{ Symbol: 'KALYANKJIL', param_0: 571, param_1: 548.15, param_2: 4.17, param_3: 2.26 }],
        breakout_beacon: [{ Symbol: 'UNIONBANK', param_0: 2.7, param_1: 3.99, param_2: 'BULL', param_3: '10:15' }],
      },
    },
  });
  check('market_pulse: every list is kept, by its own name', pulse.map((l) => l.name).join('|') === 'top_gainers|breakout_beacon');
  check(
    'market_pulse: params are passed through raw, strings included',
    pulse[1]?.rows[0]?.symbol === 'UNIONBANK' && pulse[1].rows[0].params.join('|') === '2.7|3.99|BULL|10:15',
  );
  check('market_pulse: a list whose params satisfy (p0−p1)/p1 = p2 is labelled as prices', pulse[0] != null && isPriceList(pulse[0]));
  check('market_pulse: breakout_beacon (p2 = BULL) is NOT labelled as prices', pulse[1] != null && !isPriceList(pulse[1]));
  check(
    'market_pulse: one row that breaks the arithmetic un-labels the whole list',
    !isPriceList({ name: 'x', rows: [
      { symbol: 'A', params: [571, 548.15, 4.17, 1] },
      { symbol: 'B', params: [100, 90, 4.17, 1] },
    ] }),
  );
  check('market_pulse: an empty list is never labelled', !isPriceList({ name: 'x', rows: [] }));
  check('market_pulse: an unrelated payload yields no lists', parseMarketPulse({ payload: { data: null } }).length === 0);
}

main();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
