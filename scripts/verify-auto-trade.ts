/**
 * Auto-trade verification bench — exercises the pure risk gates, Fyers option
 * symbology, settings CRUD, store lifecycle math, and one quiet engine pass
 * in paper mode. No broker orders, no AI calls. Uses a synthetic 2099 date,
 * deletes its own rows, and restores mode to 'off'. Run before trusting a
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
import { toFyersOptionSymbol } from '../lib/auto-trade/brokers/fyers-adapter';
import { checkEntryGates, checkStopMove } from '../lib/auto-trade/risk/gates';
import { DEFAULT_SETTINGS } from '../lib/auto-trade/config';
import { getAutoTradeSettings, setAutoTradeSetting } from '../lib/auto-trade/settings';
import {
  countEntriesToday,
  dailyRealizedPnl,
  getExposure,
  getTrade,
  insertTrade,
  updateTrade,
} from '../lib/auto-trade/store';
import { runAutoTradePass } from '../lib/auto-trade/engine';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  // ── 1. Pure gates ──────────────────────────────────────────────────────────
  const base = {
    settings: { ...DEFAULT_SETTINGS, mode: 'paper' as const },
    liveEnvEnabled: false,
    marketOpen: true,
    minuteIST: 10 * 60, // 10:00 — inside the window
    entriesToday: 0,
    openLots: 0,
    deployedRupees: 0,
    dailyRealizedPnl: 0,
    symbolTradedToday: false,
    lots: 1,
    perLotCost: 30_000,
    slippagePct: 1,
    hasSlSpot: true,
    brokerFundsAvailable: null,
  };
  check('gates: clean entry allowed', checkEntryGates(base).allow);
  check('gates: off mode blocked', !checkEntryGates({ ...base, settings: { ...base.settings, mode: 'off' } }).allow);
  check('gates: kill switch blocked', !checkEntryGates({ ...base, settings: { ...base.settings, killSwitch: true } }).allow);
  check('gates: outside window blocked', !checkEntryGates({ ...base, minuteIST: 11 * 60 + 5 }).allow);
  check('gates: before 09:45 blocked', !checkEntryGates({ ...base, minuteIST: 9 * 60 + 40 }).allow);
  check('gates: daily cap blocked', !checkEntryGates({ ...base, entriesToday: 2 }).allow);
  check('gates: lot cap blocked', !checkEntryGates({ ...base, openLots: 2 }).allow);
  check('gates: capital cap blocked', !checkEntryGates({ ...base, deployedRupees: 40_000 }).allow, 'deployed 40k + 30k > 60k');
  check('gates: re-entry blocked', !checkEntryGates({ ...base, symbolTradedToday: true }).allow);
  check('gates: loss halt blocked', !checkEntryGates({ ...base, dailyRealizedPnl: -3_000 }).allow);
  check('gates: slippage blocked', !checkEntryGates({ ...base, slippagePct: 6 }).allow);
  check('gates: no premium blocked', !checkEntryGates({ ...base, perLotCost: null }).allow);
  check('gates: no stop blocked', !checkEntryGates({ ...base, hasSlSpot: false }).allow);
  check('gates: live without env key blocked', !checkEntryGates({ ...base, settings: { ...base.settings, mode: 'live' } }).allow);
  check('gates: broker funds short blocked', !checkEntryGates({ ...base, brokerFundsAvailable: 10_000 }).allow);
  check('stop: bullish tighten up allowed', checkStopMove('bullish', 100, 105).allow);
  check('stop: bullish loosen down blocked', !checkStopMove('bullish', 100, 95).allow);
  check('stop: bearish tighten down allowed', checkStopMove('bearish', 100, 95).allow);
  check('stop: bearish loosen up blocked', !checkStopMove('bearish', 100, 105).allow);

  // ── 2. Fyers option symbology ──────────────────────────────────────────────
  const sym = toFyersOptionSymbol({ symbol: 'RELIANCE', optionType: 'CE', strike: 3000, expiryDate: '2026-07-28' });
  check('fyers symbol format', sym === 'NSE:RELIANCE26JUL3000CE', sym);

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

  // ── 4. Store lifecycle ─────────────────────────────────────────────────────
  const date = '2099-01-01'; // synthetic test date — can't collide with real rows
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
  check('store: insert returns id', tradeId > 0, String(tradeId));
  check('store: entry counted', (await countEntriesToday(date)) === 1);
  const exposure = await getExposure(date);
  check('store: exposure lots', exposure.openLots === 1);
  check('store: exposure rupees = premium×lot', exposure.deployedRupees === 20 * 500, String(exposure.deployedRupees));
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

  // ── 5. One engine pass in paper mode (market closed → quiet pass) ─────────
  const outcome = await runAutoTradePass(null);
  check('engine: pass ran', outcome.ran, JSON.stringify(outcome));
  check('engine: no guard actions on empty book', outcome.guardActions.length === 0);

  // Leave the system exactly as found: mode back to off.
  await setAutoTradeSetting('mode', 'off');
  check('settings: mode restored to off', (await getAutoTradeSettings()).mode === 'off');

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
