/**
 * PURE checks for lib/fyers/universe-plan.ts — the daily fno_stocks ↔ exchange
 * sync. DB-free, so it runs in CI.
 *
 * Fixtures are shaped on the real 2026-10-29 drift: ICICIPRULI renamed ICICILIFE
 * (lot 925 both sides), DALBHARAT left F&O, ANANDRATHI joined with no known
 * sector, ABCAPITAL's lot halved 3100 → 1550 (avoid → extended), RECLTD-style
 * manual override.
 */
import { planFnoUniverseSync, SYMBOL_RENAMES, type FnoStockRow, type LiveFuture } from '@/lib/fyers/universe-plan';

let failures = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`PASS  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const row = (symbol: string, lotSize: number, tradeBand: string, sector = 'FIN SERVICE', isIndex = false): FnoStockRow => ({
  symbol,
  name: symbol,
  isIndex,
  lotSize,
  lotSizeNext: lotSize,
  lotSizeFar: lotSize,
  lotMonths: 'Nov 2026 / Dec 2026 / Jan 2027',
  sector,
  tradeBand,
});
const futs = (underlying: string, lots: [number, number, number]): LiveFuture[] =>
  ['2026-11-23T10:10:00.000Z', '2026-12-29T10:10:00.000Z', '2027-01-25T10:10:00.000Z'].map((expiryDate, i) => ({
    underlying,
    expiryDate,
    lotSize: lots[i],
  }));

const stocks = [
  row('ICICIPRULI', 925, 'core'),
  row('DALBHARAT', 325, 'core', 'CEMENT'),
  row('ABCAPITAL', 3100, 'avoid'),
  row('RELIANCE', 500, 'core', 'ENERGY'),
  row('RECLTD', 1400, 'core'),
  row('NIFTY', 75, 'extended', 'INDEX', true),
];
const plan = planFnoUniverseSync({
  stocks,
  liveFutures: [
    ...futs('ICICILIFE', [925, 925, 925]),
    ...futs('ANANDRATHI', [250, 250, 250]),
    ...futs('ABCAPITAL', [1550, 1550, 1550]),
    ...futs('RELIANCE', [500, 500, 500]),
    ...futs('RECLTD', [1575, 1575, 1575]),
    // Futures arrive unsorted from SQL; the planner must take the NEAREST expiry.
    { underlying: 'ZEEL', expiryDate: '2027-01-25T10:10:00.000Z', lotSize: 3000 },
    { underlying: 'ZEEL', expiryDate: '2026-11-23T10:10:00.000Z', lotSize: 1000 },
  ],
  bandOverrides: new Map([['RECLTD', 'avoid']]),
  sectorMap: { ZEEL: 'MEDIA' },
  equityNames: new Map([['ICICILIFE', 'ICICI LIFE INSURANCE LTD']]),
});

const added = (s: string) => plan.additions.find((a) => a.symbol === s);
const updated = (s: string) => plan.updates.find((u) => u.symbol === s);

check('rename: the 2026-10-23 rename is on record', SYMBOL_RENAMES.ICICIPRULI?.to === 'ICICILIFE');
check('rename: ICICILIFE is added, carrying its predecessor\'s sector', added('ICICILIFE')?.sector === 'FIN SERVICE');
check('rename: the provenance says where the sector came from', added('ICICILIFE')?.sectorSource === 'renamed:ICICIPRULI');
check('rename: the company name comes from the exchange master', added('ICICILIFE')?.name === 'ICICI LIFE INSURANCE LTD');
check('rename: band from its lot (925 → core)', added('ICICILIFE')?.tradeBand === 'core');
check(
  'rename: ICICIPRULI is reported as renamed, not deleted',
  plan.exited.some((e) => e.symbol === 'ICICIPRULI' && e.renamedTo === 'ICICILIFE')
);
check('exit: DALBHARAT (no live future) is reported, not deleted', plan.exited.some((e) => e.symbol === 'DALBHARAT' && e.renamedTo == null));
check('exit: an index row is never reported as exited', !plan.exited.some((e) => e.symbol === 'NIFTY'));
check('unclassified: ANANDRATHI (no known sector) is NOT added on a guess', !added('ANANDRATHI'));
check('unclassified: … and is reported with its lot', plan.unclassified.some((u) => u.symbol === 'ANANDRATHI' && u.lotSize === 250));
check('known sector: a new name in the TF sector map IS added', added('ZEEL')?.sector === 'MEDIA' && added('ZEEL')?.sectorSource === 'tf-map');
check(
  'nearest expiry wins even when rows arrive unsorted (two live expiries → no far lot)',
  added('ZEEL')?.lotSize === 1000 && added('ZEEL')?.lotSizeNext === 3000 && added('ZEEL')?.lotSizeFar === 0
);
check('lot months list only the live expiries', added('ZEEL')?.lotMonths === 'Nov 2026 / Jan 2027', added('ZEEL')?.lotMonths);
check('lot months use the seed format', added('ICICILIFE')?.lotMonths === 'Nov 2026 / Dec 2026 / Jan 2027', added('ICICILIFE')?.lotMonths);
check('lot change: ABCAPITAL 3100 → 1550 moves avoid → extended', updated('ABCAPITAL')?.tradeBand === 'extended' && updated('ABCAPITAL')?.bandFrom === 'avoid');
check('override wins: RECLTD stays avoid whatever its lot says', updated('RECLTD')?.tradeBand === 'avoid' && updated('RECLTD')?.lotSize === 1575);
check('no change → no write: RELIANCE is untouched', !updated('RELIANCE'));
check('idempotent: an already-synced universe plans nothing', (() => {
  const synced = planFnoUniverseSync({
    stocks: [row('RELIANCE', 500, 'core', 'ENERGY')],
    liveFutures: futs('RELIANCE', [500, 500, 500]),
    bandOverrides: new Map(),
    sectorMap: {},
    equityNames: new Map(),
  });
  return synced.updates.length + synced.additions.length + synced.unclassified.length + synced.exited.length === 0;
})());
check('an empty master plans no writes (everything only REPORTED as exited)', (() => {
  const empty = planFnoUniverseSync({ stocks, liveFutures: [], bandOverrides: new Map(), sectorMap: {}, equityNames: new Map() });
  return empty.updates.length === 0 && empty.additions.length === 0;
})());

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
