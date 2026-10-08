/**
 * Pure checks for lib/fyers/master.ts — Fyers' public symbol master → master_contracts rows.
 *
 * Fixtures are copied from the REAL public masters (public.fyers.in/sym_details,
 * fetched 2026-10-08). The bug they pin: the parser mapped exInstType 10 to
 * FUTSTK, but in Fyers' cash master 10 is an INDEX (NSE:NIFTYBANK-INDEX, lot size
 * 0), while stock futures are 13 in the F&O master. The index failed validation
 * and threw, so every nightly catch-up aborted ("Master-contract catch-up failed
 * … Invalid Fyers contract NSE:NIFTYBANK-INDEX", 2026-10-08) and blocked new
 * option entries — and even without the throw, no real stock future would ever
 * have been imported while 109 indices posed as FUTSTK.
 */
import { parseFyersMaster } from '../lib/fyers/master';
import { checkStableDrop, providerOfSourceHash } from '../lib/historify/master-guards';

export type CheckFn = (name: string, ok: boolean, detail?: string) => void;

const NIFTYBANK_INDEX = {
  exInstType: 10, exSeries: 'XX', exToken: 26009, underSym: 'BANKNIFTY', exSymbol: 'BANKNIFTY',
  minLotSize: 0, expiryDate: '', optType: 'XX', strikePrice: -1.0, exSymName: 'BANKNIFTY',
};
const RELIANCE_EQ = {
  exInstType: 0, exSeries: 'EQ', exToken: 2885, underSym: 'RELIANCE', exSymbol: 'RELIANCE',
  minLotSize: 1, expiryDate: '', optType: 'XX', strikePrice: -1.0, exSymName: 'RELIANCE INDUSTRIES LTD',
};
const RELIANCE_FUT = {
  exInstType: 13, exSeries: 'XX', exToken: 48987, underSym: 'RELIANCE', exSymbol: 'RELIANCE',
  minLotSize: 500, expiryDate: '1793095800', optType: 'XX', strikePrice: -1.0, exSymName: 'RELIANCE26OCTFUT',
};
const NIFTY_FUT = {
  exInstType: 11, exSeries: 'XX', exToken: 48704, underSym: 'NIFTY', exSymbol: 'NIFTY',
  minLotSize: 65, expiryDate: '1793095800', optType: 'XX', strikePrice: -1.0, exSymName: 'NIFTY26OCTFUT',
};

export function runFyersMasterChecks(check: CheckFn): void {
  let cm: ReturnType<typeof parseFyersMaster> = [];
  let error = '';
  try {
    cm = parseFyersMaster({ 'NSE:NIFTYBANK-INDEX': NIFTYBANK_INDEX, 'NSE:RELIANCE-EQ': RELIANCE_EQ }, '2026-10-08');
  } catch (e) {
    error = (e as Error).message;
  }
  check('fyers master: an index row (exInstType 10) does not abort the import', error === '', error);
  check('fyers master: an index is not imported at all', !cm.some((r) => r.fyersSymbol === 'NSE:NIFTYBANK-INDEX'));
  check('fyers master: the equity still imports', cm.some((r) => r.symbol === 'RELIANCE' && r.instrument === 'EQUITY'));

  const fo = parseFyersMaster({ 'NSE:RELIANCE26OCTFUT': RELIANCE_FUT, 'NSE:NIFTY26OCTFUT': NIFTY_FUT }, '2026-10-08');
  const stockFut = fo.find((r) => r.fyersSymbol === 'NSE:RELIANCE26OCTFUT');
  check(
    'fyers master: a stock future (exInstType 13) imports as FUTSTK with its lot size',
    stockFut?.instrument === 'FUTSTK' && stockFut.underlying === 'RELIANCE' && stockFut.lotSize === 500,
    JSON.stringify(stockFut ?? null),
  );
  check(
    'fyers master: an index future (exInstType 11) imports as FUTIDX',
    fo.find((r) => r.fyersSymbol === 'NSE:NIFTY26OCTFUT')?.instrument === 'FUTIDX',
  );

  // A genuinely broken TRADEABLE row must still stop the import — fail closed.
  let broken = '';
  try {
    parseFyersMaster({ 'NSE:RELIANCE26OCTFUT': { ...RELIANCE_FUT, minLotSize: 0 } }, '2026-10-08');
  } catch (e) {
    broken = (e as Error).message;
  }
  check('fyers master: a stock future with lot size 0 still fails closed', broken.includes('Invalid Fyers contract'), broken);
}

/**
 * The relative "stable rows dropped >10%" guard, across a PROVIDER SWITCH.
 * Numbers are prod's real ones (2026-10-08): the stored snapshot is the old Dhan
 * import (10,635 stable rows — 9,964 equities of every series + 653 FUTSTK + 18
 * FUTIDX); Fyers' EQ-series master gives 2,333 + 635 + 18 = 2,986. Comparing
 * those blocked the first Fyers sync for a reason that is not truncation.
 */
/** Shape of a pre-migration manifest hash: a bare SHA-256 (prod's real 3cc441aa1407…). */
const LEGACY_DHAN_HASH = '3cc441aa1407' + 'f'.repeat(52);

export function runStableDropChecks(check: CheckFn): void {
  const switchCase = { existingStable: 10_635, parsedStable: 2_986, existingFutures: 671, parsedFutures: 653 };
  check(
    'stable guard: a Dhan → Fyers switch compares futures only, so it passes',
    checkStableDrop({ ...switchCase, existingProvider: providerOfSourceHash(LEGACY_DHAN_HASH), provider: 'fyers' }).ok,
  );
  check(
    'stable guard: the same drop from the SAME provider still aborts',
    !checkStableDrop({ ...switchCase, existingProvider: 'fyers', provider: 'fyers' }).ok,
  );
  check(
    'stable guard: a provider switch with truncated futures still aborts',
    !checkStableDrop({ existingStable: 10_635, parsedStable: 2_500, existingFutures: 671, parsedFutures: 300, existingProvider: 'dhan', provider: 'fyers' }).ok,
  );
  check('stable guard: an empty table never blocks', checkStableDrop({ existingStable: 0, parsedStable: 2_986, existingFutures: 0, parsedFutures: 653, existingProvider: null, provider: 'fyers' }).ok);
  check('source hash: an unprefixed (pre-migration) hash is the old Dhan import', providerOfSourceHash(LEGACY_DHAN_HASH) === 'dhan');
  check('source hash: fyers: prefix is fyers', providerOfSourceHash('fyers:abc') === 'fyers');
  check('source hash: none stored is unknown', providerOfSourceHash(null) === null);
  check('source hash: dhan: prefix is dhan', providerOfSourceHash('dhan:abc') === 'dhan');
  // Anything else is UNKNOWN, which takes the strict same-provider comparison.
  check('source hash: a fixture tag is unknown, not dhan', providerOfSourceHash('fixture-x') === null);
  check(
    'stable guard: an unknown stored source compares strictly (the big equity drop aborts)',
    !checkStableDrop({ existingStable: 10_635, parsedStable: 2_986, existingFutures: 671, parsedFutures: 653, existingProvider: providerOfSourceHash('fixture-x'), provider: 'fyers' }).ok,
  );
}
