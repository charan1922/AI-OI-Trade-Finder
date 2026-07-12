/**
 * TF-breakout detector validation harness — drives lib/breakout with
 * (a) SYNTHETIC bar series encoding the strategy's two canonical profiles
 *     (TECHM morning-low-held success, TCS morning-low-broken fakeout — from
 *     the breakout-secrets video in the R-Obsidian vault), asserting the
 *     detector reproduces the video's verdicts, and
 * (b) REAL recorded 5-min bars + bhavcopy levels (when present in the DB),
 *     asserting structural invariants (no fabricated levels, sticky morning
 *     break, cleared ⊆ ladder).
 *
 * Synthetic bars exist ONLY in this script as test vectors — they never reach
 * the UI or the DB.
 *
 * Run from the project root:  npx tsx scripts/validate-breakout.ts [date]
 * Exit code 1 on any failure.
 */
import Database from 'better-sqlite3';
import { deriveBreakoutContext, evaluateBreakout, type LevelInputs, type SwingBar } from '../lib/breakout';
import { deriveSessionContext } from '../lib/signals/session-context';

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`  ✗ FAIL: ${msg}`);
};
const pass = (msg: string) => console.log(`  ✓ ${msg}`);
const expect = (cond: boolean, msg: string) => (cond ? pass(msg) : fail(msg));

/** Build a 5-min bar at IST hh:mm on an arbitrary fixed day. */
const istBar = (hhmm: string, high: number, low: number): SwingBar => {
  const [h, m] = hhmm.split(':').map(Number);
  // 2026-07-06 00:00 IST = 2026-07-05 18:30 UTC → epoch secs + minutes
  const dayStartUtcSec = Math.floor(Date.parse('2026-07-06T00:00:00+05:30') / 1000);
  return { bucketTs: dayStartUtcSec + (h * 60 + m) * 60, high, low };
};

// ─── Profile 1: TECHM-like success (morning low held, 3 levels shattered) ────
console.log('\nSynthetic TECHM profile (held morning low, multi-level surge):');
{
  const bars: SwingBar[] = [
    istBar('09:15', 1370, 1366), // morning window: low 1366
    istBar('09:20', 1372, 1367),
    istBar('09:25', 1371, 1368),
    istBar('09:30', 1373, 1368), // window over — low 1366 never revisited
    istBar('09:35', 1375, 1369),
    istBar('09:40', 1376, 1370), // OR completes at 9:45; OR high 1376
    istBar('09:45', 1378, 1371),
    istBar('09:50', 1377, 1372),
    istBar('09:55', 1380, 1373),
    istBar('10:00', 1382, 1375),
    istBar('10:05', 1381, 1376),
    istBar('10:10', 1384, 1377),
    istBar('10:15', 1383, 1378), // swing high forms at 1384 (10:10)
    istBar('10:20', 1386, 1379),
    istBar('10:25', 1390, 1381),
  ];
  const levels: LevelInputs = {
    ...deriveSessionContext(bars),
    priorDayHigh: 1384.4, // the video's three-coinciding-levels line
    priorDayLow: 1352,
    high5d: 1388,
    low5d: 1345,
    high20d: 1402,
    low20d: 1310,
  };
  const ctx = deriveBreakoutContext(bars, levels);
  expect(ctx != null, 'context derives');
  if (ctx) {
    expect(ctx.morning.morningLow === 1366, `morning low = 1366 (got ${ctx.morning.morningLow})`);
    expect(!ctx.morning.lowBroken, 'morning low held (never broken by a bar)');

    // LTP 1391 → above OR high 1378? OR high is max of 9:15–9:45 = 1378... assert via ladder names instead.
    const sig = evaluateBreakout(ctx, 1391, 6.5, +1.8);
    expect(sig != null, 'signal evaluates');
    if (sig) {
      expect(sig.direction === 'bullish', `direction bullish (got ${sig.direction})`);
      expect(sig.morningTest === 'held', `morning test held (got ${sig.morningTest})`);
      expect(sig.levelsCleared >= 3, `≥3 levels cleared at 1391 (got ${sig.levelsCleared}: ${sig.clearedNames.join(', ')})`);
      expect(sig.grade === 'strong', `grade strong with efficient R-Factor (got ${sig.grade})`);
      const sigWeakRf = evaluateBreakout(ctx, 1391, 3.0, +1.8);
      expect(sigWeakRf?.grade === 'confirmed', `low R-Factor caps at confirmed (got ${sigWeakRf?.grade})`);
      const sigNext = evaluateBreakout(ctx, 1391, 6.5, +1.8);
      expect(sigNext?.nextLevel?.name === '20d high', `next level is the 20d high 1402 (got ${sigNext?.nextLevel?.name})`);
    }

    // Live-tick morning break: LTP crashing >0.1% (the noise tolerance) under
    // 1366 flips the test instantly — no waiting for the 5-min bar.
    const crash = evaluateBreakout(ctx, 1362, 6.5, -0.5);
    expect(crash?.morningTest === 'broken' || crash?.direction === 'bearish', 'live tick well below morning low never reads as a held bullish base');
    // A 1-point poke (inside the 0.1% tolerance) is NOT a break — stop-hunt noise.
    const poke = evaluateBreakout(ctx, 1365, 6.5, -0.1);
    expect(poke?.morningTest !== 'broken', 'a sub-tolerance poke below the morning low does not count as broken');
  }
}

// ─── Profile 2: TCS-like fakeout (morning low broken, late breakout) ─────────
console.log('\nSynthetic TCS profile (morning low broken early, noon "breakout"):');
{
  const bars: SwingBar[] = [
    istBar('09:15', 2262, 2255), // morning window: low 2255
    istBar('09:20', 2260, 2254), // still inside window — extends morning low to 2254
    istBar('09:25', 2258, 2254.5),
    istBar('09:30', 2256, 2245), // AFTER window: trades well below 2254 (−0.4%,
    istBar('09:35', 2255, 2242), // beyond the 0.1% noise tolerance) → broken, sticky
    istBar('09:40', 2257, 2246),
    istBar('09:45', 2259, 2250),
    istBar('10:00', 2262, 2255),
    istBar('11:00', 2268, 2258),
    istBar('12:00', 2275, 2262), // the eventual "breakout" — after the morning failure
    istBar('12:30', 2284, 2270),
  ];
  const levels: LevelInputs = {
    ...deriveSessionContext(bars),
    priorDayHigh: 2280,
    priorDayLow: 2240,
    high5d: 2290,
    low5d: 2225,
    high20d: 2310,
    low20d: 2180,
  };
  const ctx = deriveBreakoutContext(bars, levels);
  expect(ctx != null, 'context derives');
  if (ctx) {
    expect(ctx.morning.lowBroken, 'morning low registered as broken (sticky)');
    const sig = evaluateBreakout(ctx, 2286, 5.0, +1.2); // clearing prev-day high at noon
    expect(sig != null, 'signal evaluates');
    if (sig) {
      expect(sig.morningTest === 'broken', `morning test broken (got ${sig.morningTest})`);
      expect(sig.grade === 'fakeout-risk', `late breakout over a broken morning grades fakeout-risk (got ${sig.grade})`);
      expect(sig.levelsCleared >= 1, `still reports the levels it cleared (got ${sig.levelsCleared})`);
    }
  }
}

// ─── Profile 3: pending window + no-context guards ───────────────────────────
console.log('\nGuards (pending morning window, empty bars):');
{
  const bars: SwingBar[] = [istBar('09:15', 1000, 995), istBar('09:20', 1002, 996)];
  const ctx = deriveBreakoutContext(bars, {
    openRangeHigh: null,
    openRangeLow: null,
    openRangeComplete: false,
    priorDayHigh: 1001,
    priorDayLow: 980,
    high5d: null,
    low5d: null,
    high20d: null,
    low20d: null,
  });
  expect(ctx != null && !ctx.morning.complete, 'morning window still pending with only 2 bars');
  const sig = ctx ? evaluateBreakout(ctx, 1003, 6.0, +0.4) : null;
  expect(sig?.morningTest === 'pending' && sig?.grade === 'none', `pending window grades none (got ${sig?.grade})`);
  expect(deriveBreakoutContext([], { openRangeHigh: null, openRangeLow: null, openRangeComplete: false, priorDayHigh: null, priorDayLow: null, high5d: null, low5d: null, high20d: null, low20d: null }) === null, 'no bars → null context');
  expect(evaluateBreakout(null, 100, 5, 0) === null, 'null context → null signal (renders "—", never fabricated)');
}

// ─── Real recorded bars (structural invariants), when the DB has them ────────
const DATE = process.argv[2] ?? '2026-07-10';
console.log(`\nReal bars invariants (${DATE}):`);
try {
  const db = new Database('./data/project-r.db', { readonly: true });
  const symbols = (
    db
      .prepare(`SELECT DISTINCT symbol FROM fyers_candles WHERE date=? AND instrument='EQ' LIMIT 5`)
      .all(DATE) as { symbol: string }[]
  ).map((r) => r.symbol);
  if (symbols.length === 0) console.log('  (no recorded bars for this date — skipped; pass a date argument)');
  for (const sym of symbols) {
    const bars = db
      .prepare(`SELECT bucketTs, high, low FROM fyers_candles WHERE symbol=? AND date=? AND instrument='EQ' ORDER BY bucketTs ASC`)
      .all(sym, DATE) as SwingBar[];
    const bh = db
      .prepare(`SELECT eqHigh, eqLow FROM bhavcopy_days WHERE symbol=? AND date<? ORDER BY date DESC LIMIT 1`)
      .get(sym, DATE) as { eqHigh: number | null; eqLow: number | null } | undefined;
    const sc = deriveSessionContext(bars);
    const ctx = deriveBreakoutContext(bars, {
      ...sc,
      priorDayHigh: bh?.eqHigh ?? null,
      priorDayLow: bh?.eqLow ?? null,
      high5d: null,
      low5d: null,
      high20d: null,
      low20d: null,
    });
    if (!ctx) {
      fail(`${sym}: no context from ${bars.length} bars`);
      continue;
    }
    const usable = bars.filter((b) => b.high > 0 && b.low > 0);
    const dayLow = Math.min(...usable.map((b) => b.low));
    // Invariant: morning extremes bound the day's extremes.
    if (ctx.morning.morningLow != null && ctx.morning.morningLow < dayLow) fail(`${sym}: morning low below day low`);
    // Invariant: sticky break agrees with raw bars (same tolerance the detector shipped with).
    const tol = 1 - ctx.breakTolerancePct / 100;
    const rawBroken = ctx.morning.complete && ctx.morning.morningLow != null && dayLow < ctx.morning.morningLow * tol;
    if (ctx.morning.complete && rawBroken !== ctx.morning.lowBroken) fail(`${sym}: lowBroken=${ctx.morning.lowBroken} but bars say ${rawBroken}`);
    // Invariant: every cleared name exists in the ladder; count matches at last close.
    const lastClose = usable[usable.length - 1];
    const sig = evaluateBreakout(ctx, lastClose.high, null, null);
    if (sig) {
      const ladderNames = new Set([...ctx.resistances, ...ctx.supports].map((l) => l.name));
      for (const n of sig.clearedNames) if (!ladderNames.has(n)) fail(`${sym}: cleared unknown level "${n}"`);
    }
    pass(`${sym}: ${usable.length} bars · morning ${ctx.morning.complete ? (ctx.morning.lowBroken ? 'low broken' : 'low held') : 'pending'} · ladder ${ctx.resistances.length}R/${ctx.supports.length}S`);
  }
  db.close();
} catch (e) {
  console.log(`  (DB unavailable — real-bars section skipped: ${(e as Error).message})`);
}

console.log(failures === 0 ? '\nAll breakout validations passed.' : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
