/**
 * Indicator validation harness — cross-checks lib/signals/indicators.ts
 * against REAL recorded 5-min bars with an independent second computation +
 * invariants. Part of the fixed-benchmark loop (see scripts/replay-window.ts).
 *
 * Run from the project root:  npx tsx scripts/validate-indicators.ts [date]
 * Exit code 1 on any failure.
 */
import Database from 'better-sqlite3';
import { atr, sessionVwap, supertrend, type IndicatorBar } from '../lib/signals/indicators';

const db = new Database('./data/project-r.db', { readonly: true });
const SYMBOLS = ['RELIANCE', 'DMART', 'HDFCBANK', 'POWERINDIA', 'MARICO'];
const DATE = process.argv[2] ?? '2026-07-03';
let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`  ✗ FAIL: ${msg}`);
};
const pass = (msg: string) => console.log(`  ✓ ${msg}`);

for (const sym of SYMBOLS) {
  const bars = db
    .prepare(
      `SELECT bucketTs, open, high, low, close, volume FROM fyers_candles
       WHERE symbol=? AND date=? AND instrument='EQ' ORDER BY bucketTs ASC`,
    )
    .all(sym, DATE) as IndicatorBar[];
  console.log(`\n${sym}: ${bars.length} bars`);
  const usable = bars.filter((b) => b.high > 0 && b.low > 0 && b.close > 0);
  if (usable.length < 20) {
    fail(`only ${usable.length} usable bars`);
    continue;
  }
  const dayHigh = Math.max(...usable.map((b) => b.high));
  const dayLow = Math.min(...usable.map((b) => b.low));
  const lastClose = usable[usable.length - 1].close;

  // ── ATR(14): independent recomputation (plain loop, no shared code path) ──
  const a = atr(bars, 14);
  let ref: number | null = null;
  {
    const trs: number[] = [];
    for (let i = 1; i < usable.length; i++) {
      const b = usable[i];
      const pc = usable[i - 1].close;
      trs.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
    }
    let v = trs.slice(0, 14).reduce((x, y) => x + y, 0) / 14;
    for (let i = 14; i < trs.length; i++) v = (v * 13 + trs[i]) / 14;
    ref = v;
  }
  if (a == null) fail('ATR null despite enough bars');
  else if (Math.abs(a - (ref as number)) > 1e-9) fail(`ATR mismatch: ${a} vs ref ${ref}`);
  else if (a <= 0 || a > dayHigh - dayLow + 1e-9) fail(`ATR ${a} outside (0, dayRange=${(dayHigh - dayLow).toFixed(2)}]`);
  else pass(`ATR14 = ${a.toFixed(2)} (${((a / lastClose) * 100).toFixed(2)}% of close; day range ${(dayHigh - dayLow).toFixed(2)})`);

  // ── VWAP: independent recomputation + must sit inside [dayLow, dayHigh] ──
  const vw = sessionVwap(bars);
  let vwRef = 0;
  {
    let pv = 0,
      vol = 0;
    for (const b of usable) {
      if (b.volume <= 0) continue;
      pv += ((b.high + b.low + b.close) / 3) * b.volume;
      vol += b.volume;
    }
    vwRef = vol > 0 ? pv / vol : NaN;
  }
  if (vw == null || Math.abs(vw - vwRef) > 1e-9) fail(`VWAP mismatch: ${vw} vs ${vwRef}`);
  else if (vw < dayLow || vw > dayHigh) fail(`VWAP ${vw} outside day range [${dayLow}, ${dayHigh}]`);
  else pass(`VWAP = ${vw.toFixed(2)} (close ${lastClose} is ${lastClose >= vw ? 'ABOVE' : 'BELOW'})`);

  // ── Supertrend(10,3): invariants on every prefix (line side + flip sanity) ──
  const st = supertrend(bars, 10, 3);
  if (!st) {
    fail('Supertrend null despite enough bars');
    continue;
  }
  let prefixViolations = 0;
  let flips = 0;
  let prevDir: string | null = null;
  for (let n = 13; n <= usable.length; n++) {
    const s = supertrend(usable.slice(0, n), 10, 3);
    if (!s) continue;
    const c = usable[n - 1].close;
    // While in an uptrend the close must sit on/above the line (flip rule
    // guarantees it); mirrored for downtrend.
    if (s.direction === 'up' && c < s.line - 1e-9) prefixViolations++;
    if (s.direction === 'down' && c > s.line + 1e-9) prefixViolations++;
    if (prevDir !== null && s.direction !== prevDir) flips++;
    prevDir = s.direction;
  }
  if (prefixViolations > 0) fail(`Supertrend line-side violated on ${prefixViolations} prefixes`);
  else if (flips > 15) fail(`Supertrend flipped ${flips}× in one day — implausible`);
  else pass(`Supertrend(10,3) = ${st.direction.toUpperCase()} @ ${st.line.toFixed(2)} (${st.barsInTrend} bars in trend, ${flips} flips today)`);
}

console.log(failures === 0 ? '\nALL INDICATOR CHECKS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
