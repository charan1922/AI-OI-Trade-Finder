/**
 * Pure checks for the order-block detector (lib/order-blocks/engine.ts).
 * Every candle below is SYNTHETIC — hand-built to exercise one rule — never
 * market data. Run in CI via verify-quant-shadow.ts.
 */
import {
  createObEngine,
  OB_DEFAULT_CONFIG,
  processClosedBar,
  replayOrderBlocks,
  type ObBar,
  type ObConfig,
} from '../lib/order-blocks/engine';
import { summarizeOrderBlocks } from '../lib/order-blocks/read';

export type CheckFn = (name: string, ok: boolean, detail?: string) => void;

const SESSION_START = Date.parse('2026-11-18T09:15:00+05:30');
const NEXT_SESSION_START = Date.parse('2026-11-19T09:15:00+05:30');
const FIVE_MIN = 300_000;

function bar(i: number, o: number, h: number, l: number, c: number, start = SESSION_START): ObBar {
  return { startMs: start + i * FIVE_MIN, endMs: start + (i + 1) * FIVE_MIN, open: o, high: h, low: l, close: c, volume: 1000 };
}

/**
 * SYNTHETIC base fixture (bullish case):
 *  0..15  quiet bullish warm-up candles, equal highs/lows (ties → no pivots), TR 1.0
 *  16     swing high 101.5 (strictly above 3 left / 3 right) — knowable at bar 19's close
 *  17..19 lower highs
 *  20     bearish ORIGIN candle [99.8, 100.7]
 *  21     strong bullish BOS: closes 102.5 > 101.5
 *  22     moves away (no overlap)
 *  23     wicks into the zone → retest
 *  24     wicks below the zone, closes inside → NOT invalidated
 *  25     closes below the zone → invalidated
 */
function baseBars(): ObBar[] {
  const bars: ObBar[] = [];
  for (let i = 0; i <= 15; i++) bars.push(bar(i, 100, 100.6, 99.6, 100.4));
  bars.push(bar(16, 100, 101.5, 99.6, 100.4));
  for (let i = 17; i <= 19; i++) bars.push(bar(i, 100, 100.8, 99.6, 100.4));
  bars.push(bar(20, 100.6, 100.7, 99.8, 100.0));
  bars.push(bar(21, 100.1, 102.6, 100.0, 102.5));
  bars.push(bar(22, 102.5, 103.0, 102.3, 102.8));
  bars.push(bar(23, 102.0, 102.0, 100.5, 101.5));
  bars.push(bar(24, 101.5, 101.6, 99.5, 100.2));
  bars.push(bar(25, 100.2, 100.3, 99.4, 99.5));
  return bars;
}

/** Mirror prices around 200: bullish ↔ bearish, every rule must hold symmetrically. */
function mirror(bars: ObBar[]): ObBar[] {
  const m = (p: number) => Math.round((200 - p) * 100) / 100;
  return bars.map((b) => ({ ...b, open: m(b.open), close: m(b.close), high: m(b.low), low: m(b.high) }));
}

/** Independent Wilder ATR, straight from the spec's formula. */
function referenceAtr(bars: ObBar[], period: number): (number | null)[] {
  const out: (number | null)[] = [null];
  const trs: number[] = [];
  let atr: number | null = null;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const pc = bars[i - 1].close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    if (atr === null) {
      trs.push(tr);
      if (trs.length === period) atr = trs.reduce((a, v) => a + v, 0) / period;
    } else {
      atr = (atr * (period - 1) + tr) / period;
    }
    out.push(atr);
  }
  return out;
}

const close = (a: number | null | undefined, b: number | null | undefined) =>
  a != null && b != null && Math.abs(a - b) < 1e-9;

export function runOrderBlockChecks(check: CheckFn): void {
  const bars = baseBars();
  const cfg: ObConfig = OB_DEFAULT_CONFIG;

  // ── ATR seed + recurrence ──
  const s = replayOrderBlocks('SYN', 'synthetic', bars, cfg);
  const ref = referenceAtr(bars, cfg.atrPeriod);
  check('ob: ATR is null before 14 true ranges exist', s.atr[13] === null);
  check('ob: ATR seed = mean of the first 14 TRs (bar 0 has none)', close(s.atr[14], ref[14]) && close(s.atr[14], 1.0), String(s.atr[14]));
  check('ob: ATR follows the Wilder recurrence', s.atr.every((v, i) => (v === null ? ref[i] === null : close(v, ref[i]))));

  // ── Pivot causality ──
  const upTo18 = replayOrderBlocks('SYN', 'synthetic', bars.slice(0, 19), cfg);
  check('ob: a swing high is not known before its 3 right-side bars close', upTo18.highs.length === 0);
  const upTo19 = replayOrderBlocks('SYN', 'synthetic', bars.slice(0, 20), cfg);
  check(
    'ob: the swing high is known at the close of bar p+3, priced from bar p',
    upTo19.highs.length === 1 && upTo19.highs[0].barIndex === 16 && upTo19.highs[0].price === 101.5 &&
      upTo19.highs[0].knownAtMs === bars[19].endMs
  );
  check(
    'ob: equal highs/lows never form a pivot',
    s.highs.filter((p) => p.barIndex < 20).map((p) => p.barIndex).join() === '16' && s.lows.every((p) => p.barIndex >= 20)
  );

  // ── No signal at the origin; signal at the BOS close ──
  const stream = createObEngine('SYN', 'synthetic', cfg);
  const perBar = bars.map((b) => processClosedBar(stream, b));
  check('ob: nothing is emitted at the origin candle', !perBar[20].some((e) => e.type === 'ob_confirmed'));
  const conf = perBar[21].find((e) => e.type === 'ob_confirmed');
  check('ob: the block is emitted at the BOS candle close', conf !== undefined && conf.atMs === bars[21].endMs);
  const ob = stream.blocks[0];
  check('ob: exactly one bullish block', stream.blocks.length === 1 && ob.side === 'bullish');
  check('ob: zone = origin candle full wick', ob.zoneLow === 99.8 && ob.zoneHigh === 100.7 && ob.originBarIndex === 20);
  check('ob: confirmedAt is the BOS bar end, after the origin', ob.confirmedAtMs === bars[21].endMs && ob.confirmedAtMs > ob.originStartMs);
  check('ob: records the broken pivot and when it was known', ob.brokenPivotPrice === 101.5 && ob.brokenPivotKnownAtMs === bars[19].endMs);
  check('ob: displacement uses ATR of the bar BEFORE the BOS', close(ob.priorAtr, ref[20]) && close(ob.bodyAtrRatio, 2.4 / (ref[20] as number)));

  // ── Lifecycle ──
  check('ob: the BOS bar overlapping its own zone is not a retest', !perBar[21].some((e) => e.type === 'ob_retested'));
  check('ob: first overlap after confirmation is the retest', perBar[23].some((e) => e.type === 'ob_retested') && ob.firstRetestAtMs === bars[23].endMs);
  check('ob: a wick through the far edge does not invalidate', !perBar[24].some((e) => e.type === 'ob_invalidated'));
  check('ob: a close beyond the far edge invalidates', perBar[25].some((e) => e.type === 'ob_invalidated') && ob.state === 'invalidated' && ob.invalidatedAtMs === bars[25].endMs);

  const sameBar = [...bars.slice(0, 22), bar(22, 102.5, 102.6, 99.4, 99.5)];
  const sb = createObEngine('SYN', 'synthetic', cfg);
  const sbEvents = sameBar.map((b) => processClosedBar(sb, b))[22].map((e) => e.type);
  check(
    'ob: one bar that retests AND closes through emits both, final invalidated',
    sbEvents.join(',') === 'ob_retested,ob_invalidated' && sb.blocks[0].state === 'invalidated'
  );

  // ── Bearish symmetry ──
  const mir = replayOrderBlocks('SYN', 'synthetic', mirror(bars), cfg);
  const mob = mir.blocks[0];
  check(
    'ob: mirrored prices give the symmetric bearish block',
    mir.blocks.length === 1 && mob.side === 'bearish' && mob.zoneLow === 99.3 && mob.zoneHigh === 100.2 &&
      mob.confirmedAtMs === bars[21].endMs && mob.state === 'invalidated' && mob.invalidatedAtMs === bars[25].endMs
  );

  // ── BOS rules ──
  const wickOnly = [...bars.slice(0, 21), bar(21, 100.1, 102.6, 100.0, 101.5)];
  const wo = replayOrderBlocks('SYN', 'synthetic', wickOnly, { ...cfg, minBodyAtr: 1.0 });
  check('ob: a wick above the pivot with a close AT it is not a BOS', wo.blocks.length === 0 && !wo.highs[0].used);

  const twice = [...bars.slice(0, 22), bar(22, 102.5, 102.6, 100.9, 101.0), bar(23, 101.0, 103.6, 100.95, 103.5)];
  const tw = replayOrderBlocks('SYN', 'synthetic', twice, cfg);
  check('ob: a pivot breaks once — a second strong close through it adds nothing', tw.blocks.length === 1);

  const noWarm = replayOrderBlocks('SYN', 'synthetic', bars, { ...cfg, atrPeriod: 30 });
  check('ob: a strong bar without ATR warm-up never qualifies', noWarm.blocks.length === 0);

  const allBull = bars.slice(0, 21).map((b, i) => (i === 20 ? bar(20, 100.0, 100.7, 99.8, 100.4) : b));
  allBull.push(bars[21]);
  const nb = replayOrderBlocks('SYN', 'synthetic', allBull, cfg);
  check(
    'ob: no opposing candle in the lookback → no block, pivot still consumed',
    nb.blocks.length === 0 && nb.events.some((e) => e.type === 'bos_no_origin') && nb.highs[0].used
  );

  const tie = bars.map((b, i) => (i === 17 ? bar(17, 100, 101.5, 99.6, 100.4) : b));
  check('ob: an equal-high tie is not a pivot, so no block', replayOrderBlocks('SYN', 'synthetic', tie, cfg).blocks.length === 0);

  // ── Session policy ──
  const nextDay = [...bars.slice(0, 24), bar(0, 101.0, 101.2, 100.9, 101.1, NEXT_SESSION_START)];
  const nd = createObEngine('SYN', 'synthetic', cfg);
  const ndEvents = nextDay.map((b) => processClosedBar(nd, b));
  check(
    'ob: live zones expire at the last close of their session',
    nd.blocks[0].state === 'expired' && nd.blocks[0].expiredAtMs === bars[23].endMs &&
      ndEvents[24].some((e) => e.type === 'ob_expired')
  );

  const gapOpen = [...bars.slice(0, 21), bar(0, 100.1, 102.6, 100.0, 102.5, NEXT_SESSION_START)];
  const go = replayOrderBlocks('SYN', 'synthetic', gapOpen, cfg);
  const goAcross = replayOrderBlocks('SYN', 'synthetic', gapOpen, { ...cfg, originSameSession: false });
  check(
    "ob: a first-bar BOS never takes yesterday's candle as its origin (same-session rule)",
    go.blocks.length === 0 && go.events.some((e) => e.type === 'bos_no_origin') && goAcross.blocks.length === 1
  );

  // ── Idempotency + ordering ──
  const idem = createObEngine('SYN', 'synthetic', cfg);
  for (const b of bars.slice(0, 22)) processClosedBar(idem, b);
  const again = processClosedBar(idem, bars[21]);
  check('ob: re-delivering the same bar is ignored', again.length === 0 && idem.blocks.length === 1 && idem.bars.length === 22);
  let threw = false;
  try {
    processClosedBar(idem, { ...bars[21], close: 102.4 });
  } catch {
    threw = true;
  }
  check('ob: a revised or out-of-order bar is refused, never absorbed', threw);
  let badBar = false;
  try {
    processClosedBar(createObEngine('SYN', 'synthetic', cfg), { ...bars[0], low: 101 });
  } catch {
    badBar = true;
  }
  check('ob: an OHLC-inconsistent bar is refused', badBar);
  let badCfg = false;
  try {
    createObEngine('SYN', 'synthetic', { ...cfg, left: 0 });
  } catch {
    badCfg = true;
  }
  check('ob: an invalid configuration is refused', badCfg);

  // ── The AI's read (summarizeOrderBlocks) ──
  const live = replayOrderBlocks('SYN', 'synthetic', bars.slice(0, 23), cfg).blocks; // zone [99.8,100.7] active
  const ce = summarizeOrderBlocks(live, 'bullish', 102.8, true);
  check(
    'ob read: for a CE, a bullish zone under price is WITH the trade',
    ce.withTrade?.zoneLow === 99.8 && ce.against === null && ce.insideZone === null && /with this trade/.test(ce.read)
  );
  check('ob read: distance is to the nearest edge', ce.withTrade?.distancePct === Math.round(((102.8 - 100.7) / 102.8) * 10000) / 100);
  const pe = summarizeOrderBlocks(live, 'bearish', 102.8, true);
  check(
    "ob read: for a PE, the same bullish zone under price is AGAINST it (in its path)",
    pe.against?.zoneHigh === 100.7 && pe.withTrade === null && /in this trade's path/.test(pe.read)
  );
  check('ob read: price inside a zone is flagged', summarizeOrderBlocks(live, 'bullish', 100.2, true).insideZone === 'with');
  const broken = summarizeOrderBlocks(s.blocks, 'bullish', 99.5, true);
  check(
    'ob read: a with-trade zone broken by a close is reported, with its time',
    broken.brokenWithTrade?.zoneLow === 99.8 && broken.withTrade === null && /broken by a 5-min close/.test(broken.read)
  );
  check('ob read: no ATR yet → says so, claims nothing', summarizeOrderBlocks(live, 'bullish', 102.8, false).withTrade === null);

  // ── Streaming = batch, and replay at t shows nothing confirmed after t ──
  check(
    'ob: streaming bar-by-bar equals batch replay (blocks + events)',
    JSON.stringify(stream.blocks) === JSON.stringify(s.blocks) && JSON.stringify(stream.events) === JSON.stringify(s.events)
  );
  let prefixOk = true;
  for (let k = 1; k <= bars.length; k++) {
    const t = bars[k - 1].endMs;
    const pre = replayOrderBlocks('SYN', 'synthetic', bars.slice(0, k), cfg);
    const ids = pre.blocks.map((b) => b.id).join('|');
    const expected = s.blocks.filter((b) => b.confirmedAtMs <= t).map((b) => b.id).join('|');
    if (pre.blocks.some((b) => b.confirmedAtMs > t) || ids !== expected) prefixOk = false;
  }
  check('ob: replay at every bar shows exactly the blocks confirmed by then', prefixOk);
}
