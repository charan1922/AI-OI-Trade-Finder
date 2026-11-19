/**
 * Order blocks on REAL recorded candles: is it better to enter on the BREAKOUT
 * (the confirming close) or on the FIRST RETEST of the zone (order-block.com's
 * preferred entry)? Both use the same zone and the same stop just past its far
 * edge, so the only difference is WHEN you get in.
 *
 * Strictly causal: zones come from the streaming engine (lib/order-blocks), so a
 * zone exists only from its BOS close; a retest is the first LATER bar that
 * trades into it. Entries only 09:45–11:00 IST (the auto-trade window), exits at
 * the stop, a 2R target (variant) or the 15:10 bar's close (≈ 15:12 square-off).
 *
 * SPOT PATH ONLY — option decay, spreads and costs are not modelled, so every R
 * here is optimistic for an option buyer. Within a bar, the stop is assumed hit
 * BEFORE the target (conservative); a bar that opens through the stop exits at
 * its open (gap). Run: pnpm exec tsx scripts/measure-order-block-entries.ts
 */
import Database from 'better-sqlite3';
import { OB_DEFAULT_CONFIG, replayOrderBlocks, type ObBar, type OrderBlock } from '../lib/order-blocks/engine';

const db = new Database('data/project-r.db', { readonly: true });
const IST = 19_800_000;
const minuteOf = (ms: number) => {
  const d = new Date(ms + IST);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const dateOf = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);
// The auto-trade entry window in force over the replayed sessions (settings entryStartMin / entryEndMin).
const ENTRY_START = 9 * 60 + 45;
const ENTRY_END = 11 * 60;
const EXIT_BAR_START = 15 * 60 + 10;

const sessions = (
  db
    .prepare(
      `SELECT date, COUNT(*) * 1.0 / COUNT(DISTINCT symbol) AS perSym FROM fyers_candles
        WHERE instrument = 'EQ' AND open > 0 GROUP BY date ORDER BY date`
    )
    .all() as { date: string; perSym: number }[]
);
const fullSessions = new Set(sessions.filter((s) => s.perSym >= 70).map((s) => s.date));
const symbols = (db.prepare(`SELECT DISTINCT symbol FROM fyers_candles WHERE instrument = 'EQ'`).all() as { symbol: string }[]).map(
  (r) => r.symbol
);

interface Trade {
  date: string;
  symbol: string;
  side: 'bullish' | 'bearish';
  r: number;
}
type Variant = 'time' | 'target2R';
const results: Record<'breakout' | 'retest', Record<Variant, Trade[]>> = {
  breakout: { time: [], target2R: [] },
  retest: { time: [], target2R: [] },
};
let zonesInWindow = 0;
let retestNoFill = 0;

/** Walk forward from `fromIdx` (inclusive) and return R for one exit variant. */
function walk(bars: ObBar[], fromIdx: number, d: 1 | -1, entry: number, stop: number, variant: Variant): number | null {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  const target = entry + d * 2 * risk;
  for (let k = fromIdx; k < bars.length; k++) {
    const b = bars[k];
    const hitStop = d === 1 ? b.low <= stop : b.high >= stop;
    if (hitStop) {
      const px = d === 1 ? Math.min(b.open, stop) : Math.max(b.open, stop);
      return (d * (px - entry)) / risk;
    }
    if (variant === 'target2R') {
      const hitTarget = d === 1 ? b.high >= target : b.low <= target;
      if (hitTarget) return 2;
    }
    if (minuteOf(b.startMs) >= EXIT_BAR_START) return (d * (b.close - entry)) / risk;
  }
  const last = bars.at(-1);
  return last ? (d * (last.close - entry)) / risk : null;
}

for (const symbol of symbols) {
  const rows = db
    .prepare(
      `SELECT bucketTs, open, high, low, close, volume FROM fyers_candles
        WHERE symbol = ? AND instrument = 'EQ' AND open > 0 ORDER BY bucketTs`
    )
    .all(symbol) as { bucketTs: number; open: number; high: number; low: number; close: number; volume: number }[];
  const all: ObBar[] = rows.map((r) => ({
    startMs: r.bucketTs * 1000,
    endMs: r.bucketTs * 1000 + 300_000,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
  let state;
  try {
    state = replayOrderBlocks(symbol, 'local', all, OB_DEFAULT_CONFIG);
  } catch {
    continue; // out-of-order / revised rows for this symbol — skip, never patch
  }
  const blocks: OrderBlock[] = state.blocks;
  for (const ob of blocks) {
    const date = dateOf(ob.confirmedAtMs - 1);
    if (!fullSessions.has(date)) continue;
    const confMin = minuteOf(ob.confirmedAtMs);
    if (confMin < ENTRY_START || confMin > ENTRY_END) continue;
    zonesInWindow++;
    const day = all.filter((b) => dateOf(b.startMs) === date);
    const confIdx = day.findIndex((b) => b.endMs === ob.confirmedAtMs);
    if (confIdx < 0) continue;
    const d: 1 | -1 = ob.side === 'bullish' ? 1 : -1;
    // Same stop as the live retest plan (lib/order-blocks/retest.ts): the zone's far edge.
    const stop = d === 1 ? ob.zoneLow : ob.zoneHigh;

    // A) breakout: buy the confirming close.
    for (const v of ['time', 'target2R'] as Variant[]) {
      const r = walk(day, confIdx + 1, d, day[confIdx].close, stop, v);
      if (r !== null) results.breakout[v].push({ date, symbol, side: ob.side, r });
    }

    // B) first retest inside the entry window, filled at the zone edge (or the open if it opened inside).
    let j = -1;
    for (let k = confIdx + 1; k < day.length; k++) {
      if (minuteOf(day[k].startMs) >= ENTRY_END) break;
      const touches = d === 1 ? day[k].low <= ob.zoneHigh : day[k].high >= ob.zoneLow;
      if (touches) {
        j = k;
        break;
      }
    }
    if (j < 0) {
      retestNoFill++;
      continue;
    }
    const b = day[j];
    if (d === 1 ? b.open <= stop : b.open >= stop) continue; // opened through the stop: no valid fill
    const entry = d === 1 ? Math.min(b.open, ob.zoneHigh) : Math.max(b.open, ob.zoneLow);
    for (const v of ['time', 'target2R'] as Variant[]) {
      const r = walk(day, j, d, entry, stop, v); // the entry bar itself can stop us out
      if (r !== null) results.retest[v].push({ date, symbol, side: ob.side, r });
    }
  }
}

function stats(ts: Trade[]) {
  if (ts.length === 0) return 'n=0';
  const rs = ts.map((t) => t.r);
  const n = rs.length;
  const mean = rs.reduce((a, v) => a + v, 0) / n;
  const sd = Math.sqrt(rs.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, n - 1));
  const se = sd / Math.sqrt(n);
  const sorted = [...rs].sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)];
  const win = rs.filter((v) => v > 0).length / n;
  const byDay = new Map<string, number[]>();
  for (const t of ts) byDay.set(t.date, [...(byDay.get(t.date) ?? []), t.r]);
  const dayMeans = [...byDay.values()].map((v) => v.reduce((a, x) => a + x, 0) / v.length);
  const posDays = dayMeans.filter((m) => m > 0).length;
  return `n=${n}  mean ${mean >= 0 ? '+' : ''}${mean.toFixed(3)}R ±${se.toFixed(3)}  median ${median.toFixed(2)}R  win ${(win * 100).toFixed(0)}%  days positive ${posDays}/${dayMeans.length}`;
}

const dates = [...fullSessions].sort();
const half = dates[Math.floor(dates.length / 2)];
console.log(`Sessions (full): ${dates.length}  ${dates[0]} → ${dates.at(-1)}  · zones confirmed 09:45–11:00: ${zonesInWindow}`);
console.log(`Retest never came before 11:00: ${retestNoFill}\n`);
for (const method of ['breakout', 'retest'] as const) {
  for (const v of ['time', 'target2R'] as Variant[]) {
    const ts = results[method][v];
    console.log(`${method.padEnd(8)} exit=${v.padEnd(8)} ALL     ${stats(ts)}`);
    console.log(`${' '.repeat(8)}               1st half ${stats(ts.filter((t) => t.date < half))}`);
    console.log(`${' '.repeat(8)}               2nd half ${stats(ts.filter((t) => t.date >= half))}`);
  }
}
