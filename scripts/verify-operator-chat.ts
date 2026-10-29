/**
 * DB-free CI verifier for the operator chat on /trade-commentary: what the
 * operator types reaches the auto-trader as ADVISORY context, capped, stamped
 * and only ever their own words. Opens no database and no network.
 *
 * Run:  pnpm exec tsx scripts/verify-operator-chat.ts   (exit 1 on any failure)
 */
import assert from 'node:assert/strict';
import { ROLE_PERMISSIONS, requiredPermission } from '../lib/auth/rbac';
import { readFileSync } from 'node:fs';
import { CHAT_SETTING_KEYS, describeAction, validateSettingChange } from '../lib/operator-chat/actions';
import { GATE_ORDER } from '../lib/tf-live/board-view';
import { APP_DATA_SOURCES, appDataPath, toScanVerdicts } from '../lib/operator-chat/app-data';
import { AUTO_TRADER_MANAGEMENT_SYSTEM, AUTO_TRADER_SYSTEM } from '../lib/auto-trade/decision/system-prompt';
import {
  ACTION_TTL_MS,
  attachNewNotes,
  describeToolUse,
  isActionExpired,
  OPERATOR_CHAT_MANAGEMENT_RULES,
  OPERATOR_CHAT_RULES,
  OPERATOR_NOTE_CHARS,
  OPERATOR_NOTES_MAX,
  type OperatorMessage,
  toTraderNotes,
} from '../lib/operator-chat/format';

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name} — ${(e as Error).message}`);
  }
}

const msg = (
  id: number,
  role: 'user' | 'assistant',
  content: string,
  at = '2026-10-28T04:35:00.000Z'
): OperatorMessage => ({
  id,
  date: '2026-10-28',
  role,
  content,
  at,
});

console.log('=== Pure verification (no DB): operator chat → auto-trader context ===\n');

check("only the operator's own messages reach the trader — never the assistant's replies", () => {
  const notes = toTraderNotes([
    msg(1, 'user', 'avoid banks'),
    msg(2, 'assistant', 'Passed on. HDFCBANK looks fine.'),
    msg(3, 'user', 'wait till 10:30'),
  ]);
  assert.deepEqual(
    notes.map((n) => n.text),
    ['avoid banks', 'wait till 10:30']
  );
});

check('timestamps are IST wall clock (04:35Z → 10:05) so a stale note is recognisable', () => {
  assert.equal(toTraderNotes([msg(1, 'user', 'x')])[0].atIST, '10:05');
});

check(`keeps only the newest ${OPERATOR_NOTES_MAX} messages`, () => {
  const rows = Array.from({ length: OPERATOR_NOTES_MAX + 5 }, (_, i) => msg(i + 1, 'user', `note ${i + 1}`));
  const notes = toTraderNotes(rows);
  assert.equal(notes.length, OPERATOR_NOTES_MAX);
  assert.equal(notes[notes.length - 1].text, `note ${OPERATOR_NOTES_MAX + 5}`);
  assert.equal(notes[0].text, 'note 6');
});

check(`one huge paste is cut to ${OPERATOR_NOTE_CHARS} chars so it cannot crowd out the decision context`, () => {
  assert.equal(toTraderNotes([msg(1, 'user', 'a'.repeat(5000))])[0].text.length, OPERATOR_NOTE_CHARS);
});

check('blank / whitespace-only messages are dropped', () => {
  assert.equal(toTraderNotes([msg(1, 'user', '   \n '), msg(2, 'user', 'real')]).length, 1);
});

check('a mid-pass message is attached to the tool result WITHOUT losing the original fields', () => {
  const fresh = toTraderNotes([msg(9, 'user', 'exit RELIANCE now')]);
  const out = attachNewNotes({ ok: true, orderId: 7 }, fresh) as Record<string, unknown>;
  assert.equal(out.ok, true);
  assert.equal(out.orderId, 7);
  assert.deepEqual(
    (out.operatorChatNew as { text: string }[]).map((n) => n.text),
    ['exit RELIANCE now']
  );
});

check('attaching never mutates the original result', () => {
  const original = { ok: true };
  attachNewNotes(original, toTraderNotes([msg(1, 'user', 'hi')]));
  assert.deepEqual(original, { ok: true });
});

check('nothing new → the result is returned untouched (same reference)', () => {
  const original = { ok: true };
  assert.equal(attachNewNotes(original, []), original);
});

check('a non-object tool result is wrapped, not discarded', () => {
  const out = attachNewNotes('plain string', toTraderNotes([msg(1, 'user', 'hi')])) as Record<string, unknown>;
  assert.equal(out.result, 'plain string');
  assert.ok(out.operatorChatNew);
});

check('the rules: the operator decides first — but never widens the gates, and entries still need ALLOW', () => {
  const text = OPERATOR_CHAT_RULES.join('\n');
  assert.match(text, /THEIR DECISION COMES FIRST/);
  assert.match(text, /It never widens the gates/);
  assert.match(text, /check_order[\s\S]*place_entry_order only on ALLOW/);
  assert.match(text, /gates do not permit/);
  assert.match(text, /their claim/);
  // The scanner still owns WHICH stock: chat can prefer among eligible picks, never add one.
  assert.match(text, /ELIGIBLE scanner pick/);
  assert.match(text, /A name the scanner did not pick/);
});

check('BOTH trader prompts carry their operator-chat rules — the entry pass the entry version', () => {
  assert.ok(AUTO_TRADER_SYSTEM.includes(OPERATOR_CHAT_RULES.join('\n')));
  assert.ok(AUTO_TRADER_MANAGEMENT_SYSTEM.includes(OPERATOR_CHAT_MANAGEMENT_RULES.join('\n')));
});

check('ADMIN ONLY: a viewer can neither read nor post the operator chat; an admin can do both', () => {
  const none = new URLSearchParams();
  for (const method of ['GET', 'POST']) {
    const need = requiredPermission(method, '/api/trade-commentary/chat', none);
    assert.ok(need !== null, `${method} must require a permission`);
    assert.equal(ROLE_PERMISSIONS.viewer.has(need), false, `viewer must be refused ${method}`);
    assert.equal(ROLE_PERMISSIONS.admin.has(need), true, `admin must be allowed ${method}`);
  }
});

check('read_app_data never reaches an excluded route, never runs a scan, whatever the args', () => {
  const hostile: Record<string, unknown>[] = [
    {},
    { date: '2026-10-28' },
    { date: '../../logs' },
    { date: '2026-10-28&force=1' },
    { symbol: 'RELIANCE' },
    { symbol: 'X&force=1' },
    { symbol: '../tf/worker-config' },
    { section: 'nse-oi' },
    { section: '../../dhan/token' },
    { limit: 9999, days: -1, perSector: 99, basis: 'x' },
  ];
  const forbidden =
    /\/api\/(logs|users|db-explorer|dhan\/token|fyers\/token|fyers\/poller|tf\/worker-config|tf\/browser-session|market-calendar|live\/candles|telegram)|force=1/;
  for (const source of APP_DATA_SOURCES) {
    for (const extra of hostile) {
      const p = appDataPath({ ...extra, source });
      if (typeof p !== 'string') continue;
      assert.doesNotMatch(p, forbidden, `${source} ${JSON.stringify(extra)} → ${p}`);
      assert.ok(!p.includes('..'), `${source} produced a traversal: ${p}`);
      // The bare /api/trade-suggest GET runs + persists a scan — only the read-only views may appear.
      if (p.startsWith('/api/trade-suggest')) assert.match(p, /view=(history|leaderboard)/, p);
    }
  }
  assert.equal(typeof appDataPath({ source: 'logs' }), 'object', 'an unlisted source must be refused');
});

check('scan_verdicts: names WHICH check rejected each stock (proof a fix is gating, not warning)', () => {
  const allTrue = Object.fromEntries(GATE_ORDER.map((k) => [k, true])) as Record<string, boolean | null>;
  const out = toScanVerdicts({
    date: '2026-10-29',
    boardMinuteIST: 10 * 60 + 40,
    stale: false,
    verdictsLive: true,
    board: [
      { symbol: 'KOTAKBANK', side: 'CE', rankNow: 1, tradeable: true, blockedBy: null, needs: null, gates: allTrue },
      {
        symbol: 'OFSS',
        side: 'PE',
        rankNow: 4,
        tradeable: false,
        blockedBy: null,
        needs: 'the move to stop reversing — 0.90% against the trade since 09:45',
        gates: { ...allTrue, fresh: false },
      },
      {
        symbol: 'M&M',
        side: 'CE',
        rankNow: 6,
        tradeable: false,
        blockedBy: 'Supertrend(10,3) to turn with the trade',
        needs: null,
        gates: { ...allTrue, supertrend: false, pool: null },
      },
    ],
  }) as {
    boardAtIST: string;
    picked: number;
    rejected: number;
    checks: string[];
    names: { symbol: string; verdict: string; failedChecks: string[]; notEvaluable: string[]; why: string | null }[];
  };
  assert.equal(out.boardAtIST, '10:40');
  assert.equal(out.picked, 1);
  assert.equal(out.rejected, 2);
  assert.equal(out.checks.length, 10, 'the ten selector checks are listed by name');
  const by = new Map(out.names.map((n) => [n.symbol, n]));
  assert.equal(by.get('KOTAKBANK')?.verdict, 'PICKED');
  assert.equal(by.get('KOTAKBANK')?.why, null);
  assert.deepEqual(by.get('OFSS')?.failedChecks, ['move started'], 'a fading move is REJECTED by check ⑨');
  assert.match(by.get('OFSS')?.why ?? '', /^needs the move to stop reversing/);
  assert.deepEqual(by.get('M&M')?.failedChecks, ['Supertrend with it']);
  assert.deepEqual(by.get('M&M')?.notEvaluable, ['options pool'], 'missing evidence is reported apart from a failure');
});

check('chat length: up to ~300 words for multi-pick/multi-trade, 120–200 for one topic — chat thread only', () => {
  const route = readFileSync(new URL('../app/api/trade-commentary/chat/route.ts', import.meta.url), 'utf8');
  assert.match(route, /one topic → 120–200 words/);
  assert.match(route, /2\+ picks or compares 2\+ trades → up to ~300 words, hard max 350/);
  // The shared /trade-assistant prompt keeps its own limit — the override lives only in the chat framing.
  const shared = readFileSync(new URL('../lib/ai-assistant/system-prompt.ts', import.meta.url), 'utf8');
  assert.match(shared, /about 120–200 words/);
});

check('"what the AI checked": tool calls become plain English, capped, never raw data', () => {
  const live = describeToolUse('read_app_data', { source: 'live_urgency', section: 'nse-oi' }, true, 'live_urgency nse-oi');
  assert.equal(live.label, 'Live Urgency (nse-oi)');
  assert.equal(describeToolUse('read_app_data', { source: 'check_market_sideways' }, true).label, 'market sideways check');
  assert.equal(describeToolUse('get_symbol_snapshot', { symbol: 'RELIANCE' }, false, 'x').label, 'stock snapshot (RELIANCE)');
  assert.equal(describeToolUse('get_symbol_snapshot', {}, false).ok, false);
  assert.ok((describeToolUse('read_app_data', { source: 'tf_race' }, true, 'y'.repeat(900)).summary ?? '').length <= 160);
  assert.equal(describeToolUse('mystery_tool', {}, true).label, 'mystery_tool', 'an unknown tool still shows by name');
});

check('audit record (tools + model) adds NO model tokens — the replayed history is message text only', () => {
  const reply = readFileSync(new URL('../lib/operator-chat/reply.ts', import.meta.url), 'utf8');
  const transcriptFn = reply.slice(reply.indexOf('function transcript'), reply.indexOf('export async function replyToOperator'));
  assert.ok(transcriptFn.length > 0, 'transcript() must exist');
  assert.match(transcriptFn, /m\.content/);
  assert.doesNotMatch(transcriptFn, /tools|toolsJson|action|model/, 'tool lists / actions / model must never be replayed to the model');
});

check('every chat reply is stored with the provider/model that wrote it, and the thread does not list tools', () => {
  const route = readFileSync(new URL('../app/api/trade-commentary/chat/route.ts', import.meta.url), 'utf8');
  assert.match(route, /addOperatorMessage\(date, 'assistant', result\.text, result\.tools, `\$\{result\.provider\}\/\$\{result\.model\}`\)/);
  // Operator 2026-10-29: the "Checked N things" list only repeated the reply's own numbers — stored, not shown.
  const thread = readFileSync(new URL('../app/trade-commentary/_components/chat-thread.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(thread, /message\.tools/);
});

check('the chat never offers a Confirm card for a code change', () => {
  const route = readFileSync(new URL('../app/api/trade-commentary/chat/route.ts', import.meta.url), 'utf8');
  assert.match(route, /is a CODE change: say so plainly and never offer a/);
});

check('read_app_data rejects bad params instead of guessing', () => {
  assert.equal(typeof appDataPath({ source: 'oi_series' }), 'object', 'symbol is required');
  assert.equal(typeof appDataPath({ source: 'tf_eod', date: 'yesterday' }), 'object');
  assert.equal(typeof appDataPath({ source: 'nse_watchlist', section: 'everything' }), 'object');
  assert.equal(appDataPath({ source: 'oi_series', symbol: 'm&m' }), '/api/live/oi-series?symbol=M%26M');
});

check('chat settings: validated by the SAME registry ranges, stored in canonical form', () => {
  assert.deepEqual(validateSettingChange('maxRiskPerLotRupees', '6000'), {
    ok: true,
    key: 'maxRiskPerLotRupees',
    value: '6000',
  });
  const tooBig = validateSettingChange('maxRiskPerLotRupees', '60000');
  assert.equal(tooBig.ok, false, 'a fat-finger 60000 must be refused (registry cap 10,000)');
  assert.equal(validateSettingChange('maxRiskPerLotRupees', 'six thousand').ok, false);
  assert.equal(validateSettingChange('killSwitch', 'true').ok, true);
});

check('chat settings: never live mode, never broker, never an unknown key', () => {
  const live = validateSettingChange('mode', 'live');
  assert.equal(live.ok, false);
  assert.match((live as { error: string }).error, /two-key/);
  assert.equal(validateSettingChange('mode', 'paper').ok, true, 'non-live modes are allowed');
  assert.equal(validateSettingChange('broker', 'dhan').ok, false);
  assert.ok(!CHAT_SETTING_KEYS.includes('broker'));
  assert.equal(validateSettingChange('placeOrderNow', '1').ok, false);
});

check('action cards expire after 10 minutes — "exit X" means now, not an hour later', () => {
  const t0 = Date.parse('2026-10-28T05:00:00Z');
  assert.equal(isActionExpired('2026-10-28T05:00:00Z', t0 + 9 * 60_000), false);
  assert.equal(isActionExpired('2026-10-28T05:00:00Z', t0 + ACTION_TTL_MS + 1), true);
  assert.equal(isActionExpired('garbage', t0), true, 'an unreadable timestamp must not be confirmable');
});

check('every card says what will happen in plain words', () => {
  assert.match(describeAction({ kind: 'take_trade', symbol: 'APOLLOHOSP' }), /Take APOLLOHOSP now/);
  assert.match(
    describeAction({ kind: 'setting', key: 'maxRiskPerLotRupees', from: '5000', value: '6000' }),
    /5000 → 6000/
  );
  assert.match(describeAction({ kind: 'move_stop', symbol: 'X', fromSl: 100, toSl: 101 }), /tighten only/);
});

check('ADMIN ONLY: a viewer cannot tap Confirm (POST /chat/action)', () => {
  const need = requiredPermission('POST', '/api/trade-commentary/chat/action', new URLSearchParams());
  assert.ok(need !== null);
  assert.equal(ROLE_PERMISSIONS.viewer.has(need), false);
  assert.equal(ROLE_PERMISSIONS.admin.has(need), true);
});

check('the chat has NO raw order path — entries only via the trader’s gated pass', () => {
  const src = readFileSync(new URL('../lib/operator-chat/act.ts', import.meta.url), 'utf8');
  for (const forbidden of ['place_entry_order', 'placeEntry', 'brokers/', 'placeOrder', 'checkEntryGates']) {
    assert.ok(!src.includes(forbidden), `act.ts must not reach "${forbidden}"`);
  }
  // take_trade must go through runAutoTradePass (the trader + every gate), not around it.
  assert.match(src, /case 'take_trade'[\s\S]*runPassNow\(\)/);
  assert.match(src, /runAutoTradePass\(scan\)/);
});

check('the management-only rules carry NO entry workflow (that pass cannot open positions)', () => {
  const text = OPERATOR_CHAT_MANAGEMENT_RULES.join('\n');
  assert.doesNotMatch(text, /THE BAR|TRADE NOW|WATCH|place_entry_order|check_order/);
  assert.match(text, /THEIR DECISION COMES FIRST/);
  assert.match(text, /It never widens the gates/);
});

console.log(`\n${failures === 0 ? '✅ all operator-chat checks passed' : `❌ ${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
