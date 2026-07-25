/**
 * Real Prisma/SQLite boundary checks for stock-option contract resolution.
 *
 * The pure expiry-policy bench cannot prove DateTime serialization, SQL side /
 * month filters, nearest-strike identity, or the syncDate fail-closed gate.
 * This script creates an isolated throwaway database, inserts realistic rows
 * through Prisma, and invokes the production resolver unchanged.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalCwd = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), 'option-resolver-'));
mkdirSync(join(tmp, 'data'), { recursive: true });
process.chdir(tmp);

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function teardown(): void {
  process.chdir(originalCwd);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows can hold the SQLite file briefly after disconnect.
  }
}

async function main(): Promise<void> {
  const { prisma } = await import('../lib/db');
  const { resolveStockOptionFromMaster } = await import('../lib/options/stock-option-resolver');

  await prisma.$executeRawUnsafe(`
    CREATE TABLE master_contracts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      securityId  TEXT NOT NULL,
      symbol      TEXT NOT NULL,
      exchange    TEXT NOT NULL,
      segment     TEXT NOT NULL,
      instrument  TEXT NOT NULL,
      name        TEXT NOT NULL DEFAULT '',
      underlying  TEXT,
      expiryDate  DATETIME,
      lotSize     REAL NOT NULL DEFAULT 1,
      strikePrice REAL,
      optionType  TEXT,
      syncDate    TEXT NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX master_contract_identity ON master_contracts(securityId, segment)`
  );

  const syncDate = '2026-07-24';
  const row = (
    securityId: string,
    symbol: string,
    underlying: string,
    expiryDate: string,
    strikePrice: number,
    optionType: 'CE' | 'PE',
    lotSize: number
  ) => ({
    securityId,
    symbol,
    exchange: 'NSE',
    segment: 'NSE_FNO',
    instrument: 'OPTSTK',
    name: 'OPTSTK',
    underlying,
    expiryDate: new Date(`${expiryDate}T00:00:00.000Z`),
    lotSize,
    strikePrice,
    optionType,
    syncDate,
  });

  await prisma.masterContract.createMany({
    data: [
      row('REL-JUL-2900-CE', 'RELIANCE-Jul2026-2900-CE', 'RELIANCE', '2026-07-28', 2900, 'CE', 250),
      row('REL-JUL-3000-CE', 'RELIANCE-Jul2026-3000-CE', 'RELIANCE', '2026-07-28', 3000, 'CE', 250),
      row('REL-AUG-2950-CE', 'RELIANCE-Aug2026-2950-CE', 'RELIANCE', '2026-08-25', 2950, 'CE', 500),
      row('REL-AUG-3050-CE', 'RELIANCE-Aug2026-3050-CE', 'RELIANCE', '2026-08-25', 3050, 'CE', 250),
      row('REL-SEP-3000-CE', 'RELIANCE-Sep2026-3000-CE', 'RELIANCE', '2026-09-29', 3000, 'CE', 125),
      row('REL-AUG-3000-PE', 'RELIANCE-Aug2026-3000-PE', 'RELIANCE', '2026-08-25', 3000, 'PE', 375),
      row('TCS-JUL-3500-CE', 'TCS-Jul2026-3500-CE', 'TCS', '2026-07-28', 3500, 'CE', 175),
    ],
  });

  const prismaDate = await prisma.masterContract.findFirstOrThrow({
    where: { securityId: 'REL-JUL-3000-CE' },
    select: { expiryDate: true },
  });
  check(
    'Prisma DateTime round-trips as the exact expiry instant',
    prismaDate.expiryDate instanceof Date && prismaDate.expiryDate.toISOString() === '2026-07-28T00:00:00.000Z',
    prismaDate.expiryDate?.toISOString() ?? 'null'
  );

  const beforeWeek = await resolveStockOptionFromMaster(prisma, {
    symbol: 'RELIANCE',
    side: 'CE',
    spot: 2980,
    tradeDate: syncDate,
  });
  check(
    'Friday before expiry week selects the July contract',
    beforeWeek.plan?.expiryDate === '2026-07-28' && beforeWeek.resolution.rolled === false,
    JSON.stringify(beforeWeek.resolution)
  );
  check(
    'nearest strike and identity fields come from one July row',
    beforeWeek.plan?.strike === 3000 &&
      beforeWeek.plan.optSecurityId === 'REL-JUL-3000-CE' &&
      beforeWeek.plan.optSymbol === 'RELIANCE-Jul2026-3000-CE' &&
      beforeWeek.plan.lotSize === 250,
    JSON.stringify(beforeWeek.plan)
  );

  await prisma.masterContract.updateMany({ data: { syncDate: '2026-07-27' } });
  const expiryWeek = await resolveStockOptionFromMaster(prisma, {
    symbol: 'RELIANCE',
    side: 'CE',
    spot: 3000,
    tradeDate: '2026-07-27',
  });
  check(
    'Monday of July expiry week rolls to August',
    expiryWeek.plan?.expiryDate === '2026-08-25' &&
      expiryWeek.resolution.nearestListedExpiry === '2026-07-28' &&
      expiryWeek.resolution.rolled === true &&
      expiryWeek.resolution.rollReason === 'EXPIRY_WEEK' &&
      expiryWeek.resolution.calendarDte === 29,
    JSON.stringify(expiryWeek.resolution)
  );
  check(
    'deterministic nearest-strike tie keeps all fields from the chosen August row',
    expiryWeek.plan?.strike === 2950 &&
      expiryWeek.plan.optSecurityId === 'REL-AUG-2950-CE' &&
      expiryWeek.plan.lotSize === 500,
    JSON.stringify(expiryWeek.plan)
  );

  if (expiryWeek.plan == null) throw new Error('expiry-week fixture did not resolve a plan');
  // Production already has this table. Start from its pre-rollover shape so the
  // test exercises the additive ALTER path, not only CREATE on a clean install.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE trade_suggestions (
      date TEXT NOT NULL, symbol TEXT NOT NULL, optionType TEXT NOT NULL,
      strike REAL DEFAULT 0, expiryDate TEXT DEFAULT '', spotAtSuggest REAL DEFAULT 0,
      slSpot REAL, targetSpot REAL, lotSize INTEGER DEFAULT 0, optSecurityId TEXT DEFAULT '',
      sector TEXT DEFAULT '', rFactor REAL DEFAULT 0, confidence REAL DEFAULT 0,
      oiLevel REAL DEFAULT 0, oiUrgency REAL, score REAL DEFAULT 0, rank INTEGER DEFAULT 0,
      reasons TEXT DEFAULT '[]', premiumAtSuggest REAL, premiumSl REAL, premiumTarget REAL,
      suggestedAt TEXT NOT NULL, lastSeenAt TEXT NOT NULL, timesSeen INTEGER DEFAULT 1,
      maxUpPct REAL, maxDownPct REAL, closePct REAL, outcomeAt TEXT,
      PRIMARY KEY (date, symbol, optionType)
    )
  `);
  const suggestionStore = await import('../lib/trade-suggest/store');
  await suggestionStore.upsertSuggestions('2026-07-27', [
    {
      rank: 1,
      symbol: 'RELIANCE',
      sector: 'Energy',
      direction: 'bullish',
      score: 0.8,
      option: expiryWeek.plan,
      optionResolution: expiryWeek.resolution,
      plan: {
        entrySpot: 3000,
        slSpot: 2970,
        targetSpot: 3060,
        slBasis: 'last-candle',
      },
      rFactor: 5,
      rFactorConfidence: 0.8,
      oiLevel: 1.2,
      oiUrgency: 2,
      changePctOpen: 1,
      spreadPct: 0.2,
      imbalance: 0.1,
      orBreakout: true,
      tfBreakout: null,
      setupLevel: 'active',
      extended: false,
      factors: null,
      reasons: ['option expiry policy: rolled July to August'],
    },
  ]);
  const storedSuggestion = (await suggestionStore.getSuggestions('2026-07-27'))[0];
  check(
    'suggestion persistence round-trips structured rollover metadata',
    storedSuggestion?.nearestListedExpiry === '2026-07-28' &&
      storedSuggestion.expiryRolled === true &&
      storedSuggestion.expiryRollReason === 'EXPIRY_WEEK' &&
      storedSuggestion.expiryCalendarDte === 29 &&
      storedSuggestion.masterSyncDate === '2026-07-27',
    JSON.stringify(storedSuggestion)
  );
  const expiryStats = await suggestionStore.getStats(3650);
  const rolloverBucket = expiryStats.byExpiryBucket.find((bucket) => bucket.bucket === 'expiry-week-roll');
  check(
    'stats expose rollover trades as a separate quant bucket',
    rolloverBucket?.suggestions === 1 && rolloverBucket.honestReviewed === 0,
    JSON.stringify(expiryStats.byExpiryBucket)
  );

  // Same upgrade proof for auto_trades: the runtime store must add every audit
  // column to the pre-existing lifecycle table before inserting the proposal.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE auto_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, symbol TEXT NOT NULL,
      direction TEXT NOT NULL, optionType TEXT NOT NULL, strike REAL NOT NULL,
      expiryDate TEXT NOT NULL, lotSize INTEGER NOT NULL, lots INTEGER NOT NULL,
      optSecurityId TEXT NOT NULL, mode TEXT NOT NULL, broker TEXT NOT NULL,
      status TEXT NOT NULL, entrySpot REAL NOT NULL, slSpot REAL, targetSpot REAL,
      entryPremium REAL NOT NULL, slPremium REAL NOT NULL, targetPremium REAL NOT NULL,
      entryFillPremium REAL, exitFillPremium REAL, exitReason TEXT,
      aiReasonEntry TEXT NOT NULL, aiReasonExit TEXT, realizedPnlRupees REAL,
      proposedAt TEXT NOT NULL, openedAt TEXT, closedAt TEXT, updatedAt TEXT NOT NULL
    )
  `);
  const tradeStore = await import('../lib/auto-trade/store');
  const tradeId = await tradeStore.insertTrade({
    date: '2026-07-27',
    symbol: 'RELIANCE',
    direction: 'bullish',
    optionType: 'CE',
    strike: expiryWeek.plan.strike,
    expiryDate: expiryWeek.plan.expiryDate,
    lotSize: expiryWeek.plan.lotSize,
    lots: 1,
    optSecurityId: expiryWeek.plan.optSecurityId,
    nearestListedExpiry: expiryWeek.resolution.nearestListedExpiry,
    expiryRolled: expiryWeek.resolution.rolled,
    expiryRollReason: expiryWeek.resolution.rollReason,
    expiryCalendarDte: expiryWeek.resolution.calendarDte,
    masterSyncDate: expiryWeek.resolution.masterSyncDate,
    mode: 'paper',
    broker: 'paper',
    status: 'open',
    entrySpot: 3000,
    slSpot: 2970,
    targetSpot: 3060,
    entryPremium: 100,
    slPremium: 80,
    targetPremium: 120,
    aiReasonEntry: 'integration fixture',
  });
  const storedTrade = tradeId == null ? null : await tradeStore.getTrade(tradeId);
  check(
    'auto-trade persistence round-trips the same rollover bucket',
    storedTrade?.nearestListedExpiry === '2026-07-28' &&
      storedTrade.expiryRolled === true &&
      storedTrade.expiryRollReason === 'EXPIRY_WEEK' &&
      storedTrade.expiryCalendarDte === 29 &&
      storedTrade.masterSyncDate === '2026-07-27',
    JSON.stringify(storedTrade)
  );

  const put = await resolveStockOptionFromMaster(prisma, {
    symbol: 'RELIANCE',
    side: 'PE',
    spot: 3000,
    tradeDate: '2026-07-27',
  });
  check(
    'PE resolution never crosses into a CE row',
    put.plan?.optionType === 'PE' && put.plan.optSecurityId === 'REL-AUG-3000-PE',
    JSON.stringify(put.plan)
  );

  const noNextMonth = await resolveStockOptionFromMaster(prisma, {
    symbol: 'TCS',
    side: 'CE',
    spot: 3500,
    tradeDate: '2026-07-27',
  });
  check(
    'missing next month fails closed without falling back to July',
    noNextMonth.plan === null &&
      noNextMonth.resolution.status === 'no-eligible-expiry' &&
      noNextMonth.resolution.nearestListedExpiry === '2026-07-28',
    JSON.stringify(noNextMonth.resolution)
  );

  await prisma.masterContract.updateMany({ data: { syncDate: '2026-08-24' } });
  const augustWeek = await resolveStockOptionFromMaster(prisma, {
    symbol: 'RELIANCE',
    side: 'CE',
    spot: 3000,
    tradeDate: '2026-08-24',
  });
  check(
    'August expiry week rolls to September using listed dates',
    augustWeek.plan?.expiryDate === '2026-09-29' && augustWeek.resolution.rolled === true,
    JSON.stringify(augustWeek.resolution)
  );

  await prisma.masterContract.updateMany({ data: { syncDate: '2026-08-23' } });
  const stale = await resolveStockOptionFromMaster(prisma, {
    symbol: 'RELIANCE',
    side: 'CE',
    spot: 3000,
    tradeDate: '2026-08-24',
  });
  check(
    'a stale master is rejected before contract selection',
    stale.plan === null &&
      stale.resolution.status === 'master-stale' &&
      stale.resolution.masterSyncDate === '2026-08-23',
    JSON.stringify(stale.resolution)
  );

  await prisma.masterContract.updateMany({ data: { syncDate: '2026-08-24' } });
  await prisma.masterContract.update({
    where: {
      securityId_segment: { securityId: 'REL-SEP-3000-CE', segment: 'NSE_FNO' },
    },
    data: { syncDate: '2026-08-23' },
  });
  const mixed = await resolveStockOptionFromMaster(prisma, {
    symbol: 'RELIANCE',
    side: 'CE',
    spot: 3000,
    tradeDate: '2026-08-24',
  });
  check(
    'mixed snapshot dates are rejected as a partial/corrupt master',
    mixed.plan === null && mixed.resolution.status === 'master-stale',
    JSON.stringify(mixed.resolution)
  );

  await prisma.$disconnect();
}

console.log('=== Stock-option resolver Prisma/SQLite boundary ===\n');
main()
  .then(() => {
    teardown();
    console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((error) => {
    teardown();
    console.error('FAILED:', error);
    process.exit(1);
  });
