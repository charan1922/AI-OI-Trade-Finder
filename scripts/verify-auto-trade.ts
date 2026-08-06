/**
 * Auto-trade verification bench — exercises the pure risk gates, Fyers option
 * symbology, settings CRUD, store lifecycle math, and one quiet engine pass
 * in paper mode. No broker orders, no AI calls. Uses a synthetic 2099 date,
 * deletes its own rows, and restores the mode it found. Run before trusting a
 * config change or flipping toward live:
 *   npx tsx scripts/verify-auto-trade.ts
 * Exit 1 when any check fails.
 */
try {
  process.loadEnvFile('.env.local');
} catch {
  // fine — DB is file-based, nothing else is needed for this bench
}

import { prisma } from '../lib/db';
import { parseFiniteNumber } from '../lib/auto-trade/brokers/adapter';
import { safeJson, toFyersOptionSymbol } from '../lib/auto-trade/brokers/fyers-adapter';
import { checkEntryGates, checkStopMove } from '../lib/auto-trade/risk/gates';
import { getRiskLatch } from '../lib/auto-trade/risk/latch';
import {
  executeAutoTradeTool,
  newPassPolicyState,
  type ToolRuntime,
} from '../lib/auto-trade/tools/execute';
import { DEFAULT_SETTINGS } from '../lib/auto-trade/config';
import { getAutoTradeSettings, setAutoTradeSetting } from '../lib/auto-trade/settings';
import {
  claimApprovalForPlacement,
  countEntriesToday,
  claimExitOrder,
  dailyRealizedPnl,
  getExposure,
  getOpenTrades,
  getQuoteSnapshotsForTrade,
  getTrade,
  insertQuoteSnapshots,
  insertTrade,
  updateOrder,
  updateTrade,
} from '../lib/auto-trade/store';
import { runAutoTradePass } from '../lib/auto-trade/engine';
import { approveTrade } from '../lib/auto-trade/approval';
import { runPositionGuard } from '../lib/auto-trade/risk/position-guard';
import {
  backstopsFromFill,
  backstopsFromProposalFill,
  correlationIdForOrder,
  targetRupeesForPosition,
} from '../lib/auto-trade/execution';
import { chunkForTelegram, isNearDuplicateRead, markdownToTelegramHtml } from '../lib/telegram/commentary';
import { isAdminOnlyPage, requiredPermission, roleForGoogleEmail } from '../lib/auth/rbac';
import { computeGex } from '../lib/signals/gex';
import { runQuantShadowChecks } from './quant-shadow-checks';
import { runConfigDriftChecks } from './config-drift-checks';
import { runPremiumStopChecks } from './premium-stop-checks';
import { runGradeChecks } from './grade-checks';
import { runProfitProtectChecks } from './profit-protect-checks';
import { runExpiryPolicyChecks } from './expiry-policy-checks';
import { ensureSuggestionsTable, getSuggestions, recordOutcome } from '../lib/trade-suggest/store';
import { todayIST } from '../lib/dhan/market-feed';
import { hasRequiredEqBar } from '../lib/fyers/poller';
import {
  fyersStreamReconnectDelayMs,
  fyersStreamNeedsTokenRotation,
  isStreamTargetExecutable,
  parseFyersPnlTick,
} from '../lib/auto-trade/fyers-pnl-stream';

let failures = 0;
let modeToRestore: 'off' | 'paper' | 'approval' | 'live' | null = null;
let modeRowExisted = false;
let modeUpdatedAtToRestore: string | null = null;

async function restoreOriginalMode(): Promise<void> {
  if (!modeToRestore) return;
  if (modeRowExisted) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO auto_trade_settings (key, value, updatedAt) VALUES ('mode', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
      modeToRestore,
      modeUpdatedAtToRestore ?? new Date().toISOString()
    );
  } else {
    await prisma.$executeRawUnsafe(`DELETE FROM auto_trade_settings WHERE key = 'mode'`);
  }
}

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const originalMode = (await getAutoTradeSettings()).mode;
  modeToRestore = originalMode;
  const modeRows = (await prisma.$queryRawUnsafe(
    `SELECT key, updatedAt FROM auto_trade_settings WHERE key = 'mode'`
  )) as { key: string; updatedAt: string }[];
  modeRowExisted = modeRows.length > 0;
  modeUpdatedAtToRestore = modeRows[0]?.updatedAt ?? null;
  const realOpen = await getOpenTrades();
  if (realOpen.length > 0) throw new Error(`verification refuses to run with ${realOpen.length} real open trade(s)`);
  const streamTick = parseFyersPnlTick({
    symbol: 'NSE:TEST26JUL100CE',
    ltp: 20.1,
    bid_price: 20,
    bid_size: 1_000,
    ask_price: 20.2,
  });
  check(
    'FYERS P&L stream: full tick parses executable bid and size',
    streamTick?.bid === 20 && streamTick.ask === 20.2 && streamTick.bidSize === 1_000
  );
  const crossedTick = parseFyersPnlTick({
    symbol: 'NSE:TEST26JUL100CE',
    ltp: 20.1,
    bid_price1: 21,
    ask_price1: 20,
  });
  check('FYERS P&L stream: crossed book bid rejected', crossedTick?.bid == null && crossedTick?.ltp === 20.1);
  check(
    'FYERS streamed target: full position is executable',
    isStreamTargetExecutable({ bid: 20, bidSize: 1_000, targetPremium: 20, qtyUnits: 1_000, bidAgeMs: 0 })
  );
  check(
    'FYERS streamed target: bid below target is rejected',
    !isStreamTargetExecutable({ bid: 19.95, bidSize: 2_000, targetPremium: 20, qtyUnits: 1_000, bidAgeMs: 0 })
  );
  check(
    'FYERS streamed target: missing displayed size is rejected',
    !isStreamTargetExecutable({ bid: 20, bidSize: null, targetPremium: 20, qtyUnits: 1_000, bidAgeMs: 0 })
  );
  check(
    'FYERS streamed target: partial displayed size is rejected',
    !isStreamTargetExecutable({ bid: 20, bidSize: 999, targetPremium: 20, qtyUnits: 1_000, bidAgeMs: 0 })
  );
  check(
    'FYERS streamed target: stale bid is rejected',
    !isStreamTargetExecutable({ bid: 20, bidSize: 1_000, targetPremium: 20, qtyUnits: 1_000, bidAgeMs: 2_001 })
  );
  check('FYERS P&L stream: reconnect starts at 1 second', fyersStreamReconnectDelayMs(0) === 1_000);
  check('FYERS P&L stream: reconnect backoff is capped at 30 seconds', fyersStreamReconnectDelayMs(99) === 30_000);
  check(
    'FYERS P&L stream: unchanged access token keeps the installed socket',
    !fyersStreamNeedsTokenRotation('token-a', 'token-a'),
  );
  check(
    'FYERS P&L stream: a fresh morning token rotates the installed socket',
    fyersStreamNeedsTokenRotation('token-a', 'token-b'),
  );
  check(
    'FYERS P&L stream: an older hot-reload state without a token fingerprint rotates once',
    fyersStreamNeedsTokenRotation(null, 'token-b'),
  );
  // ── 1. Pure gates ──────────────────────────────────────────────────────────
  const base = {
    // This fixture's ₹30,000 lot (kept because the capital-cap check below is
    // written against it) inherently risks ₹7,500 at a 25% stop, so it needs a
    // matching ceiling to isolate the OTHER gates. The risk ceiling itself is
    // covered with realistic contracts in scripts/premium-stop-checks.ts.
    settings: { ...DEFAULT_SETTINGS, mode: 'paper' as const, maxRiskPerLotRupees: 10_000 },
    tradeDate: '2099-01-01',
    expiryDate: '2099-01-28',
    liveEnvEnabled: false,
    marketOpen: true,
    sessionVerified: true,
    riskLatchReasons: [] as string[],
    minuteIST: 10 * 60, // 10:00 — inside the window
    entriesToday: 0,
    openLots: 0,
    deployedRupees: 0,
    dailyRealizedPnl: 0,
    symbolTradedToday: false,
    lots: 1,
    perLotCost: 30_000,
    // The risk ceiling now FAILS CLOSED without these, so the base fixture must
    // carry an executable price and enough displayed size (PR#18 review).
    lotSize: 500,
    askPrice: 60,
    askQty: 500,
    slippagePct: 1,
    spreadPct: 2,
    hasSlSpot: true,
    brokerFundsAvailable: null,
    blockStaleAutoEntry: true,
    candleLatestBucketTs: 1_000_000_000,
    candleRequiredBucketTs: 1_000_000_000, // latest == required → fresh
    candleFresh: true,
  };
  check('gates: clean entry allowed', checkEntryGates(base).allow);
  runExpiryPolicyChecks(check);
  check(
    'gates: the placement gate itself rejects the 27-Jul near-month contract',
    !checkEntryGates({ ...base, tradeDate: '2026-07-27', expiryDate: '2026-07-28' }).allow &&
      checkEntryGates({ ...base, tradeDate: '2026-07-27', expiryDate: '2026-07-28' }).reasons.some((reason) =>
        reason.includes('use the next-month contract')
      )
  );
  const oneLotTarget = backstopsFromFill(127, 125, 1, targetRupeesForPosition(DEFAULT_SETTINGS, 1)).targetPremium;
  check('target: default ₹1,100 per trade maps to premium ₹135.80', oneLotTarget === 135.8, String(oneLotTarget));
  const twoLotTradeTarget = backstopsFromFill(
    127,
    125,
    2,
    targetRupeesForPosition({ profitTargetMode: 'per_trade', profitTargetRupees: 1_100 }, 2)
  ).targetPremium;
  check('target: per-trade cash stays ₹1,100 across two lots', twoLotTradeTarget === 131.4, String(twoLotTradeTarget));
  const twoLotPerLotTarget = backstopsFromFill(
    127,
    125,
    2,
    targetRupeesForPosition({ profitTargetMode: 'per_lot', profitTargetRupees: 1_100 }, 2)
  ).targetPremium;
  check(
    'target: per-lot cash becomes ₹2,200 across two lots',
    twoLotPerLotTarget === 135.8,
    String(twoLotPerLotTarget)
  );
  const reanchoredTarget = backstopsFromProposalFill(128, 125, 1, 127, 135.8).targetPremium;
  check(
    'target: proposal cash snapshot survives a different broker fill',
    reanchoredTarget === 136.8,
    String(reanchoredTarget)
  );

  // The premium-stop and per-lot-risk assertions moved to premium-stop-checks.ts
  // so they run in CI (this bench needs a populated DB and is box-only). Invoked
  // below with the rest of the pure suites — see runPremiumStopChecks.
  check('gates: off mode blocked', !checkEntryGates({ ...base, settings: { ...base.settings, mode: 'off' } }).allow);
  check(
    'gates: kill switch blocked',
    !checkEntryGates({
      ...base,
      settings: { ...base.settings, killSwitch: true },
    }).allow
  );
  check('gates: outside window blocked', !checkEntryGates({ ...base, minuteIST: 11 * 60 + 5 }).allow);
  check('gates: before 09:45 blocked', !checkEntryGates({ ...base, minuteIST: 9 * 60 + 40 }).allow);
  check('gates: daily cap blocked', !checkEntryGates({ ...base, entriesToday: 2 }).allow);
  check('gates: lot cap blocked', !checkEntryGates({ ...base, openLots: 2 }).allow);
  check(
    'gates: capital cap blocked',
    !checkEntryGates({ ...base, deployedRupees: 40_000 }).allow,
    'deployed 40k + 30k > 60k'
  );
  check('gates: re-entry blocked', !checkEntryGates({ ...base, symbolTradedToday: true }).allow);
  check('gates: loss halt blocked', !checkEntryGates({ ...base, dailyRealizedPnl: -5_000 }).allow);
  check(
    'gates: loss halt NOT tripped one rupee short of the limit',
    checkEntryGates({ ...base, dailyRealizedPnl: -4_999 }).allow,
    'halt is ≤ −dailyLossHaltRupees, not <'
  );
  check('gates: slippage blocked', !checkEntryGates({ ...base, slippagePct: 6 }).allow);
  check('gates: no premium blocked', !checkEntryGates({ ...base, perLotCost: null }).allow);
  check('gates: no stop blocked', !checkEntryGates({ ...base, hasSlSpot: false }).allow);
  check(
    'gates: stale candle blocked (block ON)',
    !checkEntryGates({ ...base, candleFresh: false, candleLatestBucketTs: 1_000_000_000 - 600 }).allow,
    'latest is 2 buckets behind required'
  );
  check(
    'gates: missing candle blocked (block ON)',
    !checkEntryGates({ ...base, candleFresh: false, candleLatestBucketTs: null }).allow
  );
  check(
    'gates: stale candle allowed when block OFF (existing gates decide)',
    checkEntryGates({ ...base, blockStaleAutoEntry: false, candleFresh: false, candleLatestBucketTs: null }).allow
  );
  check(
    'gates: live without env key blocked',
    !checkEntryGates({ ...base, settings: { ...base.settings, mode: 'live' } }).allow
  );
  check('gates: broker funds short blocked', !checkEntryGates({ ...base, brokerFundsAvailable: 10_000 }).allow);
  check('gates: wide spread blocked', !checkEntryGates({ ...base, spreadPct: 12 }).allow, 'spread 12% > default max');
  check(
    'gates: spread over tightened default blocked',
    !checkEntryGates({ ...base, spreadPct: 5 }).allow,
    'spread 5% > default 3% (SIEMENS 2026-07-16 profile — was passed by the old 8% ceiling)'
  );
  check(
    'gates: settings maxSpreadPct override respected',
    checkEntryGates({ ...base, settings: { ...base.settings, maxSpreadPct: 6 }, spreadPct: 5 }).allow,
    'spread 5% allowed when the runtime setting is raised to 6%'
  );
  check(
    'gates: null spread blocked',
    !checkEntryGates({ ...base, spreadPct: null }).allow,
    'no depth → liquidity cannot be verified'
  );
  check('gates: invalid negative spread blocked', !checkEntryGates({ ...base, spreadPct: -1 }).allow);
  check(
    'gates: hard entry cutoff blocked',
    !checkEntryGates({ ...base, minuteIST: 10 * 60, entryCutoffMin: 10 * 60 }).allow
  );
  check(
    'gates: square-off boundary blocked',
    !checkEntryGates({
      ...base,
      minuteIST: base.settings.squareOffMin,
      settings: {
        ...base.settings,
        entryEndMin: base.settings.squareOffMin,
      },
    }).allow
  );
  // Fail-closed hardening (2026-07-15 review by the gate's author):
  check(
    'gates: real-order funds unknown blocked',
    checkEntryGates({
      ...base,
      settings: { ...base.settings, mode: 'approval' },
    }).reasons.some((r) => r.includes('broker funds unavailable')),
    'approval mode + null funds → fail closed'
  );
  check(
    'gates: paper tolerates null funds',
    !checkEntryGates(base).reasons.some((r) => r.includes('broker funds unavailable')),
    'paper computes budget-minus-deployed upstream'
  );
  check(
    'gates: unknown slippage blocked',
    !checkEntryGates({ ...base, slippagePct: null }).allow,
    'no scan-quote comparison → fail closed'
  );
  check('gates: NaN pnl fails closed', !checkEntryGates({ ...base, dailyRealizedPnl: Number.NaN }).allow);
  check(
    'gates: NaN minute fails closed',
    !checkEntryGates({ ...base, minuteIST: Number.NaN }).allow,
    'NaN passes both window comparisons without the guard'
  );
  check(
    'gates: unverified exchange session fails closed',
    !checkEntryGates({ ...base, sessionVerified: false }).allow,
    'weekday+clock alone can never authorize an entry (AT-007)'
  );
  check(
    'gates: active risk latch blocks entry',
    !checkEntryGates({ ...base, riskLatchReasons: ['orphan-position:NSE:TEST26JUL100CE (unmanaged venue position)'] })
      .allow
  );
  // A live spot is now required: the stop-MOVE noise floor is measured against
  // it, and the gate fails closed without one (see stop-move-checks.ts, which
  // owns the exhaustive floor/fail-closed cases). The spots here sit well clear
  // of the proposed stops so these keep asserting only the direction rule.
  check('stop: bullish tighten up allowed', checkStopMove('bullish', 100, 105, 120).allow);
  check('stop: bullish loosen down blocked', !checkStopMove('bullish', 100, 95, 120).allow);
  check('stop: bearish tighten down allowed', checkStopMove('bearish', 100, 95, 80).allow);
  check('stop: bearish loosen up blocked', !checkStopMove('bearish', 100, 105, 80).allow);

  // ── 2. Fyers option symbology ──────────────────────────────────────────────
  const sym = toFyersOptionSymbol({
    symbol: 'RELIANCE',
    optionType: 'CE',
    strike: 3000,
    expiryDate: '2026-07-28',
  });
  check('fyers symbol format', sym === 'NSE:RELIANCE26JUL3000CE', sym);
  const correlationId = correlationIdForOrder('2026-07-15:RELIANCE:CE:entry:123');
  check(
    'order correlation: broker-safe deterministic id',
    correlationId.length === 20 && /^[A-Za-z0-9]+$/.test(correlationId),
    correlationId
  );
  // Placement logging must never crash the order flow (2026-07-16 SRF
  // incident): safeJson survives circular SDK error objects.
  const circular: Record<string, unknown> = { s: 'error', message: 'x' };
  circular.self = circular;
  check('fyers error: safeJson survives circular error objects', safeJson(circular).length > 0);
  check('fyers error: safeJson truncates', safeJson({ m: 'y'.repeat(500) }).length <= 300);
  const fyersBar = (bucketTs: number, open = 100) => ({
    bucketTs,
    open,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
  });
  check(
    'fyers freshness: empty, stale, and malformed history rejected',
    !hasRequiredEqBar([], 1_000) &&
      !hasRequiredEqBar([fyersBar(999)], 1_000) &&
      !hasRequiredEqBar([fyersBar(1_000, 0)], 1_000)
  );
  check(
    'fyers freshness: exact completed bucket accepted',
    hasRequiredEqBar([fyersBar(1_000)], 1_000) && hasRequiredEqBar([fyersBar(500)], null)
  );

  // ── 2a. Broker quantity truth (AT-001): strict parse, never fail-open ─────
  check(
    'broker parse: valid quantities (number, string, negative, zero) pass',
    parseFiniteNumber({ netQty: 75 }, ['netQty']) === 75 &&
      parseFiniteNumber({ netQty: '75' }, ['netQty']) === 75 &&
      parseFiniteNumber({ netQty: -50 }, ['netQty']) === -50 &&
      parseFiniteNumber({ netQty: 0 }, ['netQty']) === 0
  );
  check(
    'broker parse: malformed/renamed quantity is null, never 0/flat',
    parseFiniteNumber({}, ['netQty']) === null &&
      parseFiniteNumber({ netQty: null }, ['netQty']) === null &&
      parseFiniteNumber({ netQty: '' }, ['netQty']) === null &&
      parseFiniteNumber({ netQty: 'unexpected' }, ['netQty']) === null &&
      parseFiniteNumber({ netQty: Number.NaN }, ['netQty']) === null &&
      parseFiniteNumber({ netQuantity: 75 }, ['netQty']) === null
  );

  // ── 2b′. AT-006: one entry per pass + check-before-place, code-enforced ───
  const policyRt: ToolRuntime = {
    scan: null,
    settings: { ...DEFAULT_SETTINGS, mode: 'paper' },
    date: '2099-01-01',
    pass: newPassPolicyState(),
  };
  const noCheckPlace = await executeAutoTradeTool(policyRt, 'place_entry_order', { symbol: 'TESTSYM' });
  check(
    'pass policy: placement without a recent check_order ALLOW refused',
    noCheckPlace.trace.ok === false && JSON.stringify(noCheckPlace.result).includes('check_order'),
    noCheckPlace.trace.summary
  );
  policyRt.pass.entryAttempted = true;
  policyRt.pass.checkedAllowAt.set('TESTSYM', Date.now());
  const secondPlace = await executeAutoTradeTool(policyRt, 'place_entry_order', { symbol: 'TESTSYM' });
  check(
    'pass policy: second entry call in one pass refused',
    secondPlace.trace.ok === false && JSON.stringify(secondPlace.result).includes('one entry attempt'),
    secondPlace.trace.summary
  );
  const latchState = await getRiskLatch();
  check(
    'risk latch: state readable and self-consistent',
    latchState.blocked === latchState.reasons.length > 0,
    latchState.reasons.map((r) => r.key).join(', ') || 'unlatched'
  );

  // ── 2b. Pure operational helpers ──────────────────────────────────────────
  const rendered = markdownToTelegramHtml('### TEST — HOLD\n**Risk** < safe');
  check(
    'telegram: markdown renders as safe HTML',
    rendered.includes('<b>TEST — HOLD</b>') && rendered.includes('<b>Risk</b> &lt; safe')
  );
  const longVisible = 'x'.repeat(9_000);
  const chunks = chunkForTelegram(`<b>${longVisible}</b>`);
  const recoveredVisible = chunks.map((chunk) => chunk.replace(/<\/?(?:b|i|code)>/g, '')).join('');
  check(
    'telegram: long HTML chunks are bounded and balanced',
    chunks.length >= 3 &&
      chunks.every(
        (chunk) => chunk.length <= 4_096 && (chunk.match(/<b>/g) ?? []).length === (chunk.match(/<\/b>/g) ?? []).length
      ) &&
      recoveredVisible === longVisible,
    `${chunks.length} chunks`
  );
  const holdRead = '### TEST — HOLD\nNo material change in setup today';
  check('telegram: identical quiet read is muted', isNearDuplicateRead(holdRead, holdRead));
  check('telegram: actionable read is never muted', !isNearDuplicateRead(holdRead, '### TEST — TRADE NOW\nAct now'));
  check(
    'rbac: explicit Google viewer allowlist',
    roleForGoogleEmail('viewer@example.com', 'viewer@example.com') === 'viewer' &&
      roleForGoogleEmail('outsider@example.com', 'viewer@example.com') === null
  );
  check(
    'rbac: sensitive page and GET API are admin-only',
    isAdminOnlyPage('/auto-trade/anything') &&
      requiredPermission('GET', '/api/auto-trade', new URLSearchParams()) === 'app:write'
  );
  const gex = computeGex([{ strike: 25_000, callGamma: 1, callOi: 10, putGamma: 1, putOi: 5 }], 100, 1);
  check(
    'gex: normalized display proxy uses call-minus-put convention',
    gex.balance === 'call-side-higher' && Math.abs(gex.netSharePct - 100 / 3) < 1e-9
  );

  // ── 2c. Quant SHADOW math (measurement only — never gates) ─────────────────
  // The full pure suite (re-anchor, excursion, observed-baseline MFE/MAE,
  // entry-candle exclusion, chgOpen bucketing, sector-rate rank) lives in
  // scripts/quant-shadow-checks.ts so the SAME assertions also run DB-free in
  // CI (scripts/verify-quant-shadow.ts). Single source — no drift.
  runQuantShadowChecks(check);
  await runConfigDriftChecks(check);
  runPremiumStopChecks(check);
  runGradeChecks(check);
  runProfitProtectChecks(check);

  // ── 2b. trade_suggestions store: outcome persistence + regrade idempotency ──
  //     Pure aggregation is covered DB-free above; this exercises the DB path
  //     recordOutcome() → getSuggestions() that CI can't (PR#5 review #4/#5).
  {
    const sd = '2099-02-02'; // synthetic — cannot collide with real rows
    const sym = 'TESTPROT';
    await ensureSuggestionsTable();
    await prisma.$executeRawUnsafe(`DELETE FROM trade_suggestions WHERE date = ?`, sd);
    await prisma.$executeRawUnsafe(
      `INSERT INTO trade_suggestions (date, symbol, optionType, spotAtSuggest, slSpot, targetSpot, suggestedAt, lastSeenAt)
       VALUES (?,?,?,?,?,?,?,?)`,
      sd,
      sym,
      'CE',
      100,
      90,
      120,
      `${sd}T10:00:00.000Z`,
      `${sd}T10:00:00.000Z`
    );
    // First grading: a stop, blob present. outcomeAt should be pinned to T1.
    const t1 = Date.parse('2099-02-02T10:05:00Z');
    await recordOutcome(
      sd,
      sym,
      'CE',
      {
        maxUpPct: 1.3,
        maxDownPct: -1,
        closePct: -1,
        spotOutcome: 'stop',
        spotOutcomeR: -1,
        protectShadow: '{"breakeven@1R":0}',
      },
      t1
    );
    const afterFirst = (await getSuggestions(sd)).find((s) => s.symbol === sym);
    check(
      'store: first grade persists stop + blob + outcomeAt',
      afterFirst?.spotOutcome === 'stop' &&
        afterFirst?.spotOutcomeR === -1 &&
        afterFirst?.protectShadow === '{"breakeven@1R":0}' &&
        afterFirst?.outcomeAt != null,
      JSON.stringify(afterFirst?.outcomeAt)
    );
    const pinnedOutcomeAt = afterFirst?.outcomeAt;
    // Regrade LATER (T2) with a corrected grade: grade + shadow overwrite, but
    // outcomeAt (the UI "Outcome" grade time) is PRESERVED via COALESCE.
    const t2 = Date.parse('2099-02-03T09:00:00Z');
    await recordOutcome(
      sd,
      sym,
      'CE',
      {
        maxUpPct: 2,
        maxDownPct: -0.2,
        closePct: 2,
        spotOutcome: 'target',
        spotOutcomeR: 2,
        protectShadow: '{"breakeven@1R":2}',
      },
      t2
    );
    const afterRegrade = (await getSuggestions(sd)).find((s) => s.symbol === sym);
    check(
      'store: regrade overwrites grade + shadow',
      afterRegrade?.spotOutcome === 'target' &&
        afterRegrade?.spotOutcomeR === 2 &&
        afterRegrade?.protectShadow === '{"breakeven@1R":2}',
      `${afterRegrade?.spotOutcome} ${afterRegrade?.spotOutcomeR}`
    );
    check(
      'store: regrade PRESERVES original outcomeAt (UI Outcome grade time)',
      afterRegrade?.outcomeAt === pinnedOutcomeAt,
      `${pinnedOutcomeAt} → ${afterRegrade?.outcomeAt}`
    );
    await prisma.$executeRawUnsafe(`DELETE FROM trade_suggestions WHERE date = ?`, sd);
  }

  // ── 3. Settings CRUD ───────────────────────────────────────────────────────
  const defaults = await getAutoTradeSettings();
  check('settings: current mode is valid', ['off', 'paper', 'approval', 'live'].includes(defaults.mode), defaults.mode);
  await setAutoTradeSetting('mode', 'paper');
  check('settings: mode set to paper', (await getAutoTradeSettings()).mode === 'paper');
  let rejected = false;
  try {
    await setAutoTradeSetting('mode', 'yolo');
  } catch {
    rejected = true;
  }
  check('settings: invalid mode rejected', rejected);
  rejected = false;
  try {
    await setAutoTradeSetting('nonsense', '1');
  } catch {
    rejected = true;
  }
  check('settings: unknown key rejected', rejected);
  rejected = false;
  try {
    await setAutoTradeSetting('entryStartMin', '09:99');
  } catch {
    rejected = true;
  }
  check('settings: malformed HH:MM rejected', rejected);

  // A proposal must not bypass an operator switching the engine away from
  // approval mode. This returns before any quote/funds/broker request.
  const approvalDate = todayIST();
  const approvalSymbol = 'APPROVALBENCH';
  await prisma.$executeRawUnsafe(
    `DELETE FROM auto_orders WHERE tradeId IN (SELECT id FROM auto_trades WHERE date = ? AND symbol = ?)`,
    approvalDate,
    approvalSymbol
  );
  await prisma.$executeRawUnsafe(`DELETE FROM auto_trades WHERE date = ? AND symbol = ?`, approvalDate, approvalSymbol);
  const approvalTradeId = await insertTrade({
    date: approvalDate,
    symbol: approvalSymbol,
    direction: 'bullish',
    optionType: 'CE',
    strike: 100,
    expiryDate: '2099-01-28',
    lotSize: 500,
    lots: 1,
    optSecurityId: '999998',
    mode: 'approval',
    broker: 'dhan',
    status: 'pending_approval',
    entrySpot: 1000,
    slSpot: 990,
    targetSpot: 1020,
    entryPremium: 20,
    slPremium: 17,
    targetPremium: 30,
    aiReasonEntry: 'approval mode bench',
  });
  if (approvalTradeId == null) throw new Error('approval bench trade claim unexpectedly failed');
  const blockedApproval = await approveTrade(approvalTradeId);
  check(
    'approval: runtime mode change blocks broker placement',
    !blockedApproval.ok && blockedApproval.message.includes('runtime mode is paper')
  );
  await prisma.$executeRawUnsafe(`DELETE FROM auto_orders WHERE tradeId = ?`, approvalTradeId);
  await prisma.$executeRawUnsafe(`DELETE FROM auto_trades WHERE id = ?`, approvalTradeId);

  // ── 4. Store lifecycle ─────────────────────────────────────────────────────
  const date = '2099-01-01'; // synthetic test date — can't collide with real rows
  await prisma.$executeRawUnsafe(
    `DELETE FROM auto_orders WHERE tradeId IN (SELECT id FROM auto_trades WHERE date = ?)`,
    date
  );
  await prisma.$executeRawUnsafe(`DELETE FROM auto_trades WHERE date = ?`, date);
  const tradeId = await insertTrade({
    date,
    symbol: 'TESTSYM',
    direction: 'bullish',
    optionType: 'CE',
    strike: 100,
    expiryDate: '2099-01-28',
    lotSize: 500,
    lots: 1,
    optSecurityId: '999999',
    mode: 'paper',
    broker: 'paper',
    status: 'open',
    entrySpot: 1000,
    slSpot: 990,
    targetSpot: 1020,
    entryPremium: 20,
    slPremium: 17,
    targetPremium: 30,
    aiReasonEntry: 'bench trade',
  });
  check('store: insert returns id', tradeId != null && tradeId > 0, String(tradeId));
  if (tradeId == null) throw new Error('synthetic trade claim unexpectedly failed');
  const duplicateTradeId = await insertTrade({
    date,
    symbol: 'TESTSYM',
    direction: 'bullish',
    optionType: 'CE',
    strike: 100,
    expiryDate: '2099-01-28',
    lotSize: 500,
    lots: 1,
    optSecurityId: '999999',
    mode: 'paper',
    broker: 'paper',
    status: 'placing',
    entrySpot: 1000,
    slSpot: 990,
    targetSpot: 1020,
    entryPremium: 20,
    slPremium: 17,
    targetPremium: 30,
    aiReasonEntry: 'duplicate bench trade',
  });
  check('store: duplicate symbol claim blocked', duplicateTradeId == null);
  check('store: entry counted', (await countEntriesToday(date)) === 1);
  const exposure = await getExposure(date);
  check('store: exposure lots', exposure.openLots === 1);
  check('store: exposure rupees = premium×lot', exposure.deployedRupees === 20 * 500, String(exposure.deployedRupees));
  // Atomic exit claim: concurrent callers produce one attempt; a rejected
  // attempt frees a NEW numbered key without losing the prior audit row.
  const quoteAt = new Date().toISOString();
  await insertQuoteSnapshots([
    {
      tradeId,
      date,
      capturedAt: quoteAt,
      source: 'guard',
      optSecurityId: '999001',
      ltp: 24.1,
      priceSource: 'ltp',
      bid: 24,
      ask: 24.2,
      bidQty: null,
      askQty: null,
      spreadPct: 0.83,
      slPremium: 17,
      targetPremium: 22.2,
    },
  ]);
  const quoteHistory = await getQuoteSnapshotsForTrade(tradeId);
  check(
    'store: executable bid/ask snapshot persisted',
    quoteHistory.length === 1 && quoteHistory[0]?.bid === 24 && quoteHistory[0]?.ask === 24.2
  );

  const exitClaimInput = {
    tradeId,
    idemKeyBase: `${date}:TESTSYM:CE:exit:${tradeId}`,
    broker: 'paper',
    mode: 'paper' as const,
    qtyUnits: 500,
  };
  const claims = await Promise.all([claimExitOrder(exitClaimInput), claimExitOrder(exitClaimInput)]);
  const firstClaim = claims.find((claim) => claim != null) ?? null;
  check('exit claim: concurrent callers yield one order', claims.filter(Boolean).length === 1);
  if (firstClaim)
    await updateOrder(firstClaim.id, {
      status: 'rejected',
      error: 'synthetic rejection',
    });
  const retryClaim = await claimExitOrder(exitClaimInput);
  check(
    'exit claim: rejected order gets attempt 2',
    retryClaim?.idemKey.endsWith(':attempt:2') === true,
    retryClaim?.idemKey ?? 'none'
  );
  await prisma.$executeRawUnsafe(`DELETE FROM auto_orders WHERE tradeId = ?`, tradeId);

  await updateTrade(tradeId, {
    status: 'closed',
    entryFillPremium: 20,
    exitFillPremium: 26,
    realizedPnlRupees: (26 - 20) * 500,
    closedAt: new Date().toISOString(),
  });
  const closed = await getTrade(tradeId);
  check('store: close persisted', closed?.status === 'closed' && closed.realizedPnlRupees === 3000);
  check('store: daily pnl', (await dailyRealizedPnl(date)) === 3000);
  await prisma.$executeRawUnsafe(`DELETE FROM auto_quote_snapshots WHERE tradeId = ?`, tradeId);
  await prisma.$executeRawUnsafe(`DELETE FROM auto_trades WHERE date = ?`, date);
  check('store: cleanup', (await countEntriesToday(date)) === 0);

  // ── 4b. Approval re-snapshot + ask-based exposure (PR#18 re-review) ─────────
  // A pending_approval row carries a PROPOSAL-time ceiling (₹2,500) and ask
  // (₹42) while the mark is ₹40. Exposure must reserve off the ask; approval
  // must atomically re-snapshot the APPROVAL-time ceiling/ask; a second click
  // must not re-win or overwrite.
  const apDate = '2099-03-03';
  await prisma.$executeRawUnsafe(`DELETE FROM auto_trades WHERE date = ?`, apDate);
  const apId = await insertTrade({
    date: apDate,
    symbol: 'APSYM',
    direction: 'bullish',
    optionType: 'CE',
    strike: 100,
    expiryDate: '2099-03-27',
    lotSize: 200,
    lots: 1,
    optSecurityId: '888888',
    mode: 'approval',
    broker: 'fyers',
    status: 'pending_approval',
    entrySpot: 1000,
    slSpot: 990,
    targetSpot: 1020,
    entryPremium: 40, // ltp/mid mark
    slPremium: 30,
    targetPremium: 45.5,
    approvedMaxRiskPerLotRupees: 2500, // proposal-time ceiling
    approvedEntryAskPremium: 42, // proposal-time ask (above the mark)
    aiReasonEntry: 'approval bench',
  });
  if (apId == null) throw new Error('approval bench insert unexpectedly failed');
  const apExpo = await getExposure(apDate);
  check(
    'exposure: a pending row reserves off the approved ASK (₹42×200), not the ₹40 mark',
    apExpo.deployedRupees === 42 * 200,
    String(apExpo.deployedRupees)
  );
  const claimedAp = await claimApprovalForPlacement(apId, {
    maxRiskPerLotRupees: 3000,
    entryAskPremium: 44,
    maxCapitalRupees: 60_000, // ₹44×200 = ₹8,800, well within — this test is about the snapshot refresh, not the cap
    date: apDate,
  });
  check('approval claim: the first caller wins the pending→placing transition', claimedAp === true);
  const apTrade = await getTrade(apId);
  check('approval claim: status advanced to placing', apTrade?.status === 'placing');
  check(
    'approval claim: ceiling re-snapshotted to the APPROVAL-time value (₹3,000, not the proposal ₹2,500)',
    apTrade?.approvedMaxRiskPerLotRupees === 3000,
    String(apTrade?.approvedMaxRiskPerLotRupees)
  );
  check(
    'approval claim: ask re-snapshotted to the fresh approval-time ask (₹44)',
    apTrade?.approvedEntryAskPremium === 44,
    String(apTrade?.approvedEntryAskPremium)
  );
  const claimedAp2 = await claimApprovalForPlacement(apId, {
    maxRiskPerLotRupees: 9999,
    entryAskPremium: 99,
    maxCapitalRupees: 60_000,
    date: apDate,
  });
  check('approval claim: a second click cannot re-win (row already placing)', claimedAp2 === false);
  const apTrade2 = await getTrade(apId);
  check(
    'approval claim: the losing second click did NOT overwrite the snapshot',
    apTrade2?.approvedMaxRiskPerLotRupees === 3000 && apTrade2?.approvedEntryAskPremium === 44
  );
  await prisma.$executeRawUnsafe(`DELETE FROM auto_trades WHERE date = ?`, apDate);

  // ── 4c. Aggregate capital cap is atomic across DIFFERENT trades (PR#18 re-review) ─
  // Two pending proposals each fit the ₹60k cap against the OTHER's proposal-time
  // reservation, but their two FRESH asks together exceed it. Approving both
  // concurrently must let exactly ONE through; total reserved must stay ≤ cap.
  const capDate = '2099-04-04';
  await prisma.$executeRawUnsafe(`DELETE FROM auto_trades WHERE date = ?`, capDate);
  const mkPending = (symbol: string, sec: string) =>
    insertTrade({
      date: capDate,
      symbol,
      direction: 'bullish',
      optionType: 'CE',
      strike: 100,
      expiryDate: '2099-04-24',
      lotSize: 1000,
      lots: 1,
      optSecurityId: sec,
      mode: 'approval',
      broker: 'fyers',
      status: 'pending_approval',
      entrySpot: 1000,
      slSpot: 990,
      targetSpot: 1020,
      entryPremium: 25,
      slPremium: 19,
      targetPremium: 30,
      approvedEntryAskPremium: 25, // proposal ask → reserves ₹25,000 each
      maxCapitalRupees: 60_000,
      aiReasonEntry: 'cap race bench',
    });
  const capAId = await mkPending('CAPA', '770001');
  const capBId = await mkPending('CAPB', '770002');
  check('cap race: both proposals insert (₹25k + ₹25k = ₹50k ≤ ₹60k)', capAId != null && capBId != null, `${capAId},${capBId}`);
  if (capAId == null || capBId == null) throw new Error('cap race bench insert unexpectedly failed');
  // Fresh asks rise to ₹31 each (₹31k/lot). Approve both AT ONCE.
  const claimCap = (id: number) =>
    claimApprovalForPlacement(id, {
      maxRiskPerLotRupees: 2500,
      entryAskPremium: 31,
      maxCapitalRupees: 60_000,
      date: capDate,
    });
  const capResults = await Promise.all([claimCap(capAId), claimCap(capBId)]);
  check(
    'cap race: exactly ONE of two concurrent approvals wins (the other would push ₹62k > ₹60k)',
    capResults.filter(Boolean).length === 1,
    `winners=${capResults.filter(Boolean).length}`
  );
  const capExpo = await getExposure(capDate);
  check(
    'cap race: total reserved stays within the ₹60k cap',
    capExpo.deployedRupees <= 60_000,
    `₹${capExpo.deployedRupees}`
  );
  // insertTrade also refuses a single row that alone would breach the cap.
  const soloOverCap = await insertTrade({
    date: capDate,
    symbol: 'CAPC',
    direction: 'bullish',
    optionType: 'CE',
    strike: 100,
    expiryDate: '2099-04-24',
    lotSize: 1000,
    lots: 1,
    optSecurityId: '770003',
    mode: 'paper',
    broker: 'paper',
    status: 'placing',
    entrySpot: 1000,
    slSpot: 990,
    targetSpot: 1020,
    entryPremium: 68,
    slPremium: 51,
    targetPremium: 73,
    approvedEntryAskPremium: 70, // ₹70 × 1000 = ₹70,000 alone > ₹60k
    maxCapitalRupees: 60_000,
    aiReasonEntry: 'cap solo bench',
  });
  check('cap: a single lot whose ask cost alone exceeds the cap is refused at insert', soloOverCap == null);
  await prisma.$executeRawUnsafe(`DELETE FROM auto_trades WHERE date = ?`, capDate);

  const guards = await Promise.all([runPositionGuard(date), runPositionGuard(date)]);
  check('guard: concurrent callers coalesce', guards.filter((guard) => guard.coalesced).length === 1);

  // ── 5. One engine pass in paper mode (market closed → quiet pass) ─────────
  const outcome = await runAutoTradePass(null);
  check('engine: pass ran', outcome.ran, JSON.stringify(outcome));
  check('engine: no guard actions on empty book', outcome.guardActions.length === 0);

  // Leave the system exactly as found.
  await restoreOriginalMode();
  check('settings: original mode restored', (await getAutoTradeSettings()).mode === originalMode);

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch(async (err) => {
  if (modeToRestore) {
    try {
      await restoreOriginalMode();
    } catch {
      // Preserve the original verification error below.
    }
  }
  console.error(err);
  process.exit(1);
});
