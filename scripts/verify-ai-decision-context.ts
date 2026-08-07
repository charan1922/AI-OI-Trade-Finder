/**
 * DB-free regression suite for the auto-trader's model-visible context,
 * management tool surface, commentary audit cards and MiMo model migration.
 *
 * Run: pnpm exec tsx scripts/verify-ai-decision-context.ts
 */
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { buildOpenPositionPicks } from '../lib/ai-commentary/picks';
import { executionStateFlag } from '../lib/ai-commentary/store';
import { MIMO_DEFAULT_MODEL, resolveMimoModel } from '../lib/ai-commentary/client';
import { commentaryForRole, timelinesForRole, tradeSuggestForRole } from '../lib/auth/trading-privacy';
import {
  buildScanContext,
  composeDecisionContext,
  evaluateEntryConsideration,
  filterPreviousReadForManagement,
  type DecisionOpenPosition,
  type EntryConsiderationInput,
} from '../lib/auto-trade/decision/context-policy';
import { AUTO_TRADER_MANAGEMENT_SYSTEM, AUTO_TRADER_SYSTEM } from '../lib/auto-trade/decision/system-prompt';
import { runMimoLoopWithClient, type ToolLoopRequest } from '../lib/auto-trade/decision/providers';
import { AUTO_TRADE_MANAGEMENT_TOOLS, AUTO_TRADE_TOOLS } from '../lib/auto-trade/tools/defs';
import type { AccountState } from '../lib/auto-trade/types';
import type { SuggestResponse } from '../lib/trade-suggest/types';

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    process.exitCode = 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    process.exitCode = 1;
    console.error(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}

const suggestion = (
  symbol: string,
  strike: number,
  slSpot: number
): Record<string, unknown> => ({
  symbol,
  sector: 'IT',
  direction: 'bearish',
  score: 80,
  changePctOpen: -1,
  option: {
    optionType: 'PE',
    strike,
    expiryDate: '2026-07-30',
    lotSize: 300,
    optSecurityId: String(strike),
    premium: { ltp: 40, perLotCost: 12_000, liquidityWarning: null },
  },
  plan: { entrySpot: 2_800, slSpot, targetSpot: 2_700, slBasis: 'structure' },
  rFactor: 4.1,
  rFactorConfidence: 82,
  oiLevel: 1.4,
  oiUrgency: 'rising',
  orBreakout: true,
  tfBreakout: { grade: 'strong', direction: 'bearish' },
  extended: false,
  factors: {
    vwapAligned: true,
    supertrendAligned: true,
    combinedOiSlope30m: 1.2,
    sectorAligned: true,
  },
  reasons: ['breakdown confirmed'],
});

const scan = {
  window: { active: true, nowIST: '10:20' },
  tilt: 'bearish',
  scanned: 40,
  gated: 2,
  suggestions: [suggestion('INFY', 2_750, 2_805), suggestion('TCS', 3_000, 3_050)],
  tracked: [
    {
      symbol: 'INFY',
      direction: 'bearish',
      side: 'PE',
      entrySpot: 2_800,
      slSpot: 2_820,
      targetSpot: 2_700,
      ltp: 2_775,
    },
  ],
  managedPositionSignals: [
    {
      symbol: 'INFY',
      direction: 'bearish',
      changePctOpen: -1.4,
      rFactor: 2.7,
      confidence: 0.42,
      oiLevel: 0.9,
      oiUrgency: -1,
      nseOiPct: -2.1,
      combinedOiSlope30m: -1.8,
      vwapAligned: false,
      supertrendAligned: false,
      orBreakout: false,
      tfBreakout: null,
      sectorAligned: false,
      dataAsOfMs: 1_785_000_000_000,
    },
  ],
} as unknown as SuggestResponse;

const accountState = {
  mode: 'paper',
  broker: 'paper',
  aiProvider: 'mimo',
  mimoModel: 'mimo-v2.5-pro',
  killSwitch: false,
  liveEnvEnabled: false,
  marketOpen: true,
  entryWindowActive: true,
  entryWindowOpensAt: '09:45',
  entryWindowClosesAt: '10:59',
  squareOffAt: '15:12',
  nowIST: '10:20',
  entriesToday: 0,
  maxTradesPerDay: 2,
  openLots: 1,
  maxOpenLots: 2,
  deployedRupees: 20_000,
  maxCapitalRupees: 60_000,
  optionStopPct: 20,
  maxRiskPerLotRupees: 2_500,
  dailyRealizedPnlRupees: 0,
  dailyLossHaltRupees: 5_000,
  profitTargetMode: 'per_trade',
  profitTargetRupees: 1_100,
  pendingApprovals: 0,
  brokerFundsAvailable: 40_000,
  brokerFundsCheckedAtPlacement: true,
} satisfies AccountState;

const heldPosition: DecisionOpenPosition = {
  tradeId: 24,
  symbol: 'INFY',
  direction: 'bearish',
  contract: '2800PE',
  strike: 2_800,
  optionType: 'PE',
  expiryDate: '2026-07-30',
  lotSize: 300,
  lots: 1,
  entrySpot: 2_800,
  slSpot: 2_780,
  targetSpot: 2_700,
  entryFillPremium: 42,
  slPremium: 33.6,
  targetPremium: 45.67,
  livePremium: 38,
  liveBid: 37.8,
  liveAsk: 38.2,
  liveSpreadPct: 1.05,
  quoteFreshThisPass: true,
  liveSpot: null,
  spotPointsFromEntry: null,
  openedAt: '2026-07-24T04:30:00.000Z',
  entryReason: 'scanner entry',
};

check('management tools are the position actions plus read-only TF corroboration', () => {
  // The real guard is the assertion BELOW: no entry tool may ever be offered on
  // a management pass. The exact list is pinned so an addition has to be
  // deliberate. `get_tf_race` is here on purpose and is read-only — a held name
  // sliding down TradeFinder's board corroborates an EARLY EXIT, which is the
  // one place the AI adds value over the deterministic backstops.
  assert.deepEqual(AUTO_TRADE_MANAGEMENT_TOOLS.map((tool) => tool.name), [
    'get_tf_race',
    'get_quote',
    'get_open_positions',
    'modify_stop',
    'exit_position',
  ]);
  assert.ok(!AUTO_TRADE_MANAGEMENT_TOOLS.some((tool) => ['check_order', 'place_entry_order'].includes(tool.name)));
  assert.ok(!AUTO_TRADE_TOOLS.some((tool) => tool.name === 'record_note'));
});

check('management context removes unrelated symbols and every competing plan field', () => {
  const context = composeDecisionContext({
    accountState,
    openPositions: [heldPosition],
    scan,
    entryEnabled: false,
    entryBlockReasons: ['open-lot cap is reached'],
  });
  const signals = (context.scan.signals ?? []) as Record<string, unknown>[];
  assert.deepEqual(signals.map((signal) => signal.symbol), ['INFY']);
  for (const forbidden of ['contract', 'strike', 'side', 'entrySpot', 'slSpot', 'targetSpot', 'premium']) {
    assert.ok(!Object.hasOwn(signals[0], forbidden), `management signal leaked ${forbidden}`);
  }
});

check('held symbol retains current thesis signals after dropping from suggestions', () => {
  const dropoutScan = {
    ...scan,
    suggestions: scan.suggestions.filter((candidate) => candidate.symbol !== 'INFY'),
  } as SuggestResponse;
  const context = composeDecisionContext({
    accountState,
    openPositions: [heldPosition],
    scan: dropoutScan,
    entryEnabled: false,
  });
  const signals = context.scan.signals as Record<string, unknown>[];
  assert.equal(signals.length, 1);
  assert.equal(signals[0].symbol, 'INFY');
  assert.equal(signals[0].combinedOiSlope30m, -1.8);
  assert.equal(signals[0].vwapAligned, false);
  assert.equal(signals[0].supertrendAligned, false);
});

check('held contract and tightened stop are the only authoritative plan', () => {
  const context = composeDecisionContext({ accountState, openPositions: [heldPosition], scan, entryEnabled: false });
  assert.equal(context.openPositions[0].contract, '2800PE');
  assert.equal(context.openPositions[0].slSpot, 2_780);
  assert.equal(context.openPositions[0].liveSpot, 2_775, 'tracked live spot should fill the missing held spot');
  const encoded = JSON.stringify(context);
  assert.equal((encoded.match(/"contract"/g) ?? []).length, 1);
  assert.equal((encoded.match(/"slSpot"/g) ?? []).length, 1);
  assert.ok(!encoded.includes('2750PE'));
  assert.ok(!encoded.includes('2820'));
});

check('management commentary cards equal the exact model-visible held positions', () => {
  const context = composeDecisionContext({ accountState, openPositions: [heldPosition], scan, entryEnabled: false });
  const cards = buildOpenPositionPicks(context.openPositions);
  assert.deepEqual(cards.map((card) => card.symbol), context.openPositions.map((position) => position.symbol));
  assert.equal(cards[0].kind, 'position');
  assert.equal(cards[0].strike, 2_800);
  assert.equal(cards[0].slSpot, 2_780);
});

check('entry context still carries every scanner candidate', () => {
  const context = buildScanContext(scan) as { picks: { symbol: string }[] };
  assert.deepEqual(context.picks.map((pick) => pick.symbol), ['INFY', 'TCS']);
});

check('management previous read keeps only held position and Bottom line', () => {
  const previous = [
    '10:15 — market weak.',
    '### INFY — HOLD',
    '- stop 2780.',
    '### TCS — WATCH',
    '- wait for breakout.',
    '### Bottom line',
    'Hold INFY; ignore TCS.',
  ].join('\n');
  const filtered = filterPreviousReadForManagement(previous, ['INFY']) ?? '';
  assert.match(filtered, /INFY — HOLD/);
  assert.match(filtered, /### Bottom line/);
  assert.doesNotMatch(filtered, /TCS — WATCH/);
});

check('management prompt is materially smaller and contains no entry workflow', () => {
  assert.ok(AUTO_TRADER_MANAGEMENT_SYSTEM.length < AUTO_TRADER_SYSTEM.length * 0.6);
  assert.doesNotMatch(AUTO_TRADER_MANAGEMENT_SYSTEM, /THE BAR|TRADE NOW|WATCH|place_entry_order|check_order/);
  assert.match(AUTO_TRADER_MANAGEMENT_SYSTEM, /openPositions array is the ONLY authority/);
});

const entryInput = {
  accountState,
  hasEntryCandidate: true,
  exchangeSessionVerified: true,
  riskLatchReasons: [],
  staleEntryProtectionEnabled: true,
  freshCandidateAvailable: true,
} satisfies EntryConsiderationInput;

check('cheap global gates allow a genuinely available entry path', () => {
  assert.equal(evaluateEntryConsideration(entryInput).allowed, true);
});

check('lot, capital, daily-loss, latch, session and stale blockers close the entry path', () => {
  const blocked = [
    { ...entryInput, accountState: { ...accountState, openLots: 2 } },
    { ...entryInput, accountState: { ...accountState, deployedRupees: 60_000 } },
    { ...entryInput, accountState: { ...accountState, dailyRealizedPnlRupees: -5_000 } },
    { ...entryInput, riskLatchReasons: ['orphan position'] },
    { ...entryInput, exchangeSessionVerified: false },
    { ...entryInput, freshCandidateAvailable: false },
  ];
  assert.ok(blocked.every((fixture) => !evaluateEntryConsideration(fixture).allowed));
});

check('MiMo model resolution preserves env migration and validates every source', () => {
  assert.equal(resolveMimoModel(null, null), MIMO_DEFAULT_MODEL);
  assert.equal(resolveMimoModel(null, 'mimo-v2.5'), 'mimo-v2.5');
  assert.equal(resolveMimoModel('mimo-v2.5-pro', 'mimo-v2.5'), 'mimo-v2.5-pro');
  assert.throws(() => resolveMimoModel('mimo-v2.5-typo', null), /Unsupported MiMo model/);
  assert.throws(() => resolveMimoModel(null, 'mimo-v2.5-typo'), /Unsupported MiMo model/);
});

check('viewer trade-suggest response hides held-position membership without mutating the internal scan', () => {
  const viewerResult = tradeSuggestForRole(scan, true);
  assert.equal(viewerResult.managedPositionSignals, undefined);
  assert.equal(scan.managedPositionSignals?.[0]?.symbol, 'INFY');
  assert.equal(tradeSuggestForRole(scan, false).managedPositionSignals?.[0]?.symbol, 'INFY');
});

check('viewer commentary redacts management text and exact position cards only', () => {
  // containsExecutionState is now explicit on both rows: an absent flag means
  // "the writer could not tell" and is deliberately treated as private, so a
  // public fixture has to say so (PR#22 re-review).
  const rows = [
    {
      promptKey: 'auto-trader',
      containsExecutionState: true,
      text: 'INFY exact fill/stop/target',
      picks: [{ symbol: 'INFY' }],
      picksCount: 1,
    },
    {
      promptKey: 'trade-commentary',
      containsExecutionState: false,
      text: 'Public scanner read',
      picks: [{ symbol: 'TCS' }],
      picksCount: 1,
    },
  ];
  const viewerRows = commentaryForRole(rows, true);
  assert.equal(viewerRows[0].picksCount, 0);
  assert.deepEqual(viewerRows[0].picks, []);
  assert.doesNotMatch(viewerRows[0].text, /INFY|fill|stop|target/i);
  assert.equal(viewerRows[1].text, 'Public scanner read');
  assert.equal(commentaryForRole(rows, false)[0].text, 'INFY exact fill/stop/target');
});

check('an unclassified commentary writer STORES private, not public', () => {
  // The read side fails private (map() treats null as private; commentaryForRole
  // uses ?? true). The WRITE side did not: `row.containsExecutionState ? 1 : 0`
  // stored 0/public for any caller that omitted the field — and both auto-trader
  // inserts in engine.ts omitted it, so the rows richest in execution state were
  // stored as public. No leak reached a viewer only because trading-privacy.ts
  // separately ORs in promptKey === 'auto-trader'. That redundancy is a backstop,
  // not the design: keying redaction off the semantic field alone would have
  // published them.
  assert.equal(executionStateFlag(undefined), 1, 'omitted flag must store PRIVATE');
  assert.equal(executionStateFlag(true), 1);
  assert.equal(executionStateFlag(false), 0, 'an explicit public classification is still honoured');
});

check('viewer redaction keys off execution state, not promptKey', () => {
  // The standalone fallback narrator runs whenever the auto-trader does not
  // (kill switch, mode off, AI failure). It receives the EXECUTION TRUTH line
  // naming the held contract and its premiums, yet stores itself as an ordinary
  // 'trade-commentary' row — so the old promptKey test published it (PR#22
  // re-review).
  const rows = [
    {
      promptKey: 'trade-commentary',
      containsExecutionState: true,
      text: '### INFY — HOLD. Open at ₹50, stop ₹37.50.',
      picks: [{ symbol: 'INFY' }],
      picksCount: 1,
    },
    {
      promptKey: 'trade-commentary',
      containsExecutionState: false,
      text: 'Nothing was traded today — scanner read only.',
      picks: [{ symbol: 'TCS' }],
      picksCount: 1,
    },
    // Written before the flag existed / caller could not tell → must be private.
    { promptKey: 'trade-commentary', text: 'Legacy row that may name a position', picks: [], picksCount: 0 },
  ];
  const viewer = commentaryForRole(rows, true);
  assert.doesNotMatch(JSON.stringify(viewer[0]), /INFY|50|37\.5/);
  assert.deepEqual(viewer[0].picks, []);
  assert.equal(viewer[1].text, 'Nothing was traded today — scanner read only.');
  assert.match(viewer[2].text, /operator only/);
  // The operator still sees all three unchanged.
  assert.match(commentaryForRole(rows, false)[0].text, /INFY — HOLD/);
  assert.match(commentaryForRole(rows, false)[2].text, /Legacy row/);
});

check('viewer cycle timelines keep step timings but lose the position-guard detail', () => {
  // Real shape: the guard step joins its action lines, which name the held
  // contract and its premiums. Redacting the commentary card while leaking the
  // same facts through a timeline tooltip would defeat the whole redaction.
  const timelines = [
    {
      date: '2026-07-24',
      steps: [
        { name: 'scan (trade-suggest)', ms: 1639, ok: true, detail: '68 scanned · 10 pick(s)' },
        {
          name: 'position guard',
          ms: 42,
          ok: true,
          detail: 'INFY 1020PE: premium stop hit (bid ₹9.35 ≤ ₹9.42) · exited −₹680',
        },
      ],
    },
  ];
  const viewer = timelinesForRole(timelines, true);
  const serialized = JSON.stringify(viewer);
  assert.doesNotMatch(serialized, /INFY|1020PE|9\.35|680/);
  assert.equal(viewer[0].steps[1].detail, undefined);
  // Operational value is preserved: names, durations and ok flags survive.
  assert.equal(viewer[0].steps[1].name, 'position guard');
  assert.equal(viewer[0].steps[1].ms, 42);
  assert.equal(viewer[0].steps[1].ok, true);
  assert.equal(viewer[0].steps.length, 2);
  // The operator still sees everything, and the source object is not mutated.
  assert.match(timelinesForRole(timelines, false)[0].steps[1].detail ?? '', /INFY 1020PE/);
  assert.match(timelines[0].steps[1].detail, /INFY 1020PE/);
});

function mimoHttpClient(
  responder: (payload: Record<string, unknown>, call: number) => Record<string, unknown>,
  payloads: Record<string, unknown>[]
): OpenAI {
  let call = 0;
  return new OpenAI({
    apiKey: 'contract-test-only',
    baseURL: 'https://mimo-contract.test/v1',
    fetch: async (_input, init) => {
      const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      payloads.push(payload);
      call += 1;
      return new Response(JSON.stringify(responder(payload, call)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

function completion(model: string, message: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'contract-test',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

await checkAsync('both MiMo tiers serialize thinking=disabled through a two-tool HTTP exchange', async () => {
  for (const model of ['mimo-v2.5', 'mimo-v2.5-pro']) {
    const payloads: Record<string, unknown>[] = [];
    const client = mimoHttpClient((_payload, call) => {
      if (call === 1) {
        return completion(model, {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call-a', type: 'function', function: { name: 'get_quote', arguments: '{"symbol":"INFY"}' } },
          ],
        });
      }
      if (call === 2) {
        return completion(model, {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call-b', type: 'function', function: { name: 'get_open_positions', arguments: '{}' } },
          ],
        });
      }
      return completion(model, { role: 'assistant', content: '### INFY — HOLD\n### Bottom line\nHold.' });
    }, payloads);
    const request: ToolLoopRequest = {
      provider: 'mimo',
      system: AUTO_TRADER_MANAGEMENT_SYSTEM,
      user: '{}',
      tools: AUTO_TRADE_MANAGEMENT_TOOLS,
      execute: async (name, args) => ({
        result: { ok: true, name },
        trace: { name, args, ok: true, summary: 'contract test' },
      }),
    };
    const result = await runMimoLoopWithClient(request, client, model, new AbortController().signal);
    assert.match(result.text, /INFY — HOLD/);
    assert.equal(payloads.length, 3);
    assert.ok(payloads.every((payload) => (payload.thinking as { type?: string })?.type === 'disabled'));
    assert.ok(
      ((payloads[1].messages as Record<string, unknown>[]) ?? []).some(
        (message) => message.role === 'tool' && message.tool_call_id === 'call-a'
      )
    );
    assert.ok(
      ((payloads[2].messages as Record<string, unknown>[]) ?? []).some(
        (message) => message.role === 'tool' && message.tool_call_id === 'call-b'
      )
    );
  }
});

await checkAsync('MiMo forced-final HTTP request also disables thinking', async () => {
  const model = 'mimo-v2.5-pro';
  const payloads: Record<string, unknown>[] = [];
  const client = mimoHttpClient((payload, call) => {
    if (!Object.hasOwn(payload, 'tools')) {
      return completion(model, { role: 'assistant', content: '### Bottom line\nStep cap reached.' });
    }
    return completion(model, {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: `call-${call}`, type: 'function', function: { name: 'get_open_positions', arguments: '{}' } },
      ],
    });
  }, payloads);
  await runMimoLoopWithClient(
    {
      provider: 'mimo',
      system: AUTO_TRADER_MANAGEMENT_SYSTEM,
      user: '{}',
      tools: AUTO_TRADE_MANAGEMENT_TOOLS,
      execute: async (name, args) => ({
        result: { ok: true },
        trace: { name, args, ok: true, summary: 'contract test' },
      }),
    },
    client,
    model,
    new AbortController().signal
  );
  const forcedFinal = payloads.at(-1);
  assert.ok(forcedFinal && !Object.hasOwn(forcedFinal, 'tools'));
  assert.equal((forcedFinal?.thinking as { type?: string })?.type, 'disabled');
});

if (process.exitCode === 1) {
  console.error('\nAI decision-context verification FAILED');
} else {
  console.log(`\nAI decision-context verification passed: ${passed} checks`);
}
