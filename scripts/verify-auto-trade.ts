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
import { executeAutoTradeTool, newPassPolicyState, type ToolRuntime } from '../lib/auto-trade/tools/execute';
import { DEFAULT_SETTINGS } from '../lib/auto-trade/config';
import { getAutoTradeSettings, setAutoTradeSetting } from '../lib/auto-trade/settings';
import {
  countEntriesToday,
  claimExitOrder,
  dailyRealizedPnl,
  getExposure,
  getOpenTrades,
  getTrade,
  insertTrade,
  updateOrder,
  updateTrade,
} from '../lib/auto-trade/store';
import { runAutoTradePass } from '../lib/auto-trade/engine';
import { approveTrade } from '../lib/auto-trade/approval';
import { runPositionGuard } from '../lib/auto-trade/risk/position-guard';
import { correlationIdForOrder } from '../lib/auto-trade/execution';
import { chunkForTelegram, isNearDuplicateRead, markdownToTelegramHtml } from '../lib/telegram/commentary';
import { isAdminOnlyPage, requiredPermission, roleForGoogleEmail } from '../lib/auth/rbac';
import { computeGex } from '../lib/signals/gex';
import { runQuantShadowChecks } from './quant-shadow-checks';
import { runConfigDriftChecks } from './config-drift-checks';
import { todayIST } from '../lib/dhan/market-feed';
import { hasRequiredEqBar } from '../lib/fyers/poller';

let failures = 0;
let modeToRestore: 'off' | 'paper' | 'approval' | 'live' | null = null;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const originalMode = (await getAutoTradeSettings()).mode;
  modeToRestore = originalMode;
  const realOpen = await getOpenTrades();
  if (realOpen.length > 0) throw new Error(`verification refuses to run with ${realOpen.length} real open trade(s)`);
  // ── 1. Pure gates ──────────────────────────────────────────────────────────
  const base = {
    settings: { ...DEFAULT_SETTINGS, mode: 'paper' as const },
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
    slippagePct: 1,
    spreadPct: 2,
    hasSlSpot: true,
    brokerFundsAvailable: null,
  };
  check('gates: clean entry allowed', checkEntryGates(base).allow);
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
  check('gates: loss halt blocked', !checkEntryGates({ ...base, dailyRealizedPnl: -3_000 }).allow);
  check('gates: slippage blocked', !checkEntryGates({ ...base, slippagePct: 6 }).allow);
  check('gates: no premium blocked', !checkEntryGates({ ...base, perLotCost: null }).allow);
  check('gates: no stop blocked', !checkEntryGates({ ...base, hasSlSpot: false }).allow);
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
    !checkEntryGates({ ...base, riskLatchReasons: ['orphan-position:NSE:TEST26JUL100CE (unmanaged venue position)'] }).allow
  );
  check('stop: bullish tighten up allowed', checkStopMove('bullish', 100, 105).allow);
  check('stop: bullish loosen down blocked', !checkStopMove('bullish', 100, 95).allow);
  check('stop: bearish tighten down allowed', checkStopMove('bearish', 100, 95).allow);
  check('stop: bearish loosen up blocked', !checkStopMove('bearish', 100, 105).allow);

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
  runConfigDriftChecks(check);

  // ── 3. Settings CRUD ───────────────────────────────────────────────────────
  const defaults = await getAutoTradeSettings();
  check('settings: default mode off', defaults.mode === 'off', defaults.mode);
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
  await prisma.$executeRawUnsafe(`DELETE FROM auto_trades WHERE date = ?`, date);
  check('store: cleanup', (await countEntriesToday(date)) === 0);

  const guards = await Promise.all([runPositionGuard(date), runPositionGuard(date)]);
  check('guard: concurrent callers coalesce', guards.filter((guard) => guard.coalesced).length === 1);

  // ── 5. One engine pass in paper mode (market closed → quiet pass) ─────────
  const outcome = await runAutoTradePass(null);
  check('engine: pass ran', outcome.ran, JSON.stringify(outcome));
  check('engine: no guard actions on empty book', outcome.guardActions.length === 0);

  // Leave the system exactly as found.
  await setAutoTradeSetting('mode', originalMode);
  check('settings: original mode restored', (await getAutoTradeSettings()).mode === originalMode);

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch(async (err) => {
  if (modeToRestore) {
    try {
      await setAutoTradeSetting('mode', modeToRestore);
    } catch {
      // Preserve the original verification error below.
    }
  }
  console.error(err);
  process.exit(1);
});
