/**
 * TF-breakout detector BACKTEST over the real TradeFinder trade book.
 *
 * Data (all real, already in project-r.db — the /trade-viewer and
 * /data-downloader pages' tables):
 *   • trades  — data/tradefinder_platform_trades.json (319 taken trades with
 *               full trade-day bars) + the 20 curated TF_TRADES
 *   • bars    — backtest_equity 5-min bars (trade day, point-in-time walk)
 *   • levels  — bhavcopy_days prior sessions (prev-day/5d/20d high-low);
 *               when bhavcopy doesn't reach back far enough, daily aggregates
 *               of prior backtest_equity days (both official/recorded data)
 *   • options — backtest_options 5-min premium bars (P&L simulation)
 *   • lots    — trade_contracts.fut_lot_size (preserved at download) else
 *               master_contracts; a trade with no real lot size is SKIPPED
 *               from P&L (never guessed)
 *
 * Walk-forward, NO LOOKAHEAD: at bar i the detector sees bars[0..i] only —
 * exactly what the live quote route sees intra-day. R-Factor is passed as
 * null (live OI/depth isn't reproducible here), so the best reachable grade
 * is 'confirmed' — the price-structure checks are what's under test.
 *
 * What is scored:
 *   1. Direction  — first confirmed breakout's side vs TF's CE/PE.
 *   2. Separation — TF win-rate when we graded confirmed vs fakeout vs none.
 *   3. Edge       — equity forward move (signal bar close → day close) after
 *                   confirmed vs fakeout-risk signals, both directions.
 *   4. P&L        — simulated option trade entered on the detector's signal
 *                   (real premiums, real lot sizes, real Indian charges).
 *
 * Run from the project root:  npx tsx scripts/backtest-breakout.ts [--csv]
 */
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { deriveBreakoutContext, evaluateBreakout, MORNING_BREAK_TOLERANCE_PCT, type BreakoutSignal, type LevelInputs } from '../lib/breakout';
import { calculateOptionCharges } from '../lib/ai-trading/commissions';

const db = new Database('./data/project-r.db', { readonly: true });
const CSV = process.argv.includes('--csv');

// ─── Trade book ──────────────────────────────────────────────────────────────
interface Trade {
  date: string;
  symbol: string;
  optionType: 'CE' | 'PE';
  strike: number;
  pnl: number;
  entryTime: string | null; // "10:17:46 AM" when broker-verified
}
const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

function loadTrades(): Trade[] {
  const seen = new Set<string>();
  const out: Trade[] = [];
  const add = (t: Trade) => {
    const k = `${t.symbol}|${t.date}|${t.optionType}|${t.strike}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  };
  const j = JSON.parse(readFileSync(new URL('../data/tradefinder_platform_trades.json', import.meta.url), 'utf8')) as {
    trades: {
      trade_date: string; stock_name: string; instrument_type: 'CE' | 'PE'; strike_price: number;
      total_pnl: number; trade_status: string; entry_time: string | null;
    }[];
  };
  for (const t of j.trades) {
    if (t.trade_status !== 'Trade Taken') continue;
    const m = t.trade_date.match(/(\d{1,2}) (\w{3}) (\d{4})/);
    if (!m || !MONTHS[m[2]]) continue;
    add({
      date: `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, '0')}`,
      symbol: t.stock_name,
      optionType: t.instrument_type,
      strike: Number(t.strike_price),
      pnl: Number(t.total_pnl),
      entryTime: t.entry_time,
    });
  }
  // Curated 20 (lib/backtest/data-downloader.ts TF_TRADES) — mostly a subset;
  // add any not already present. Kept inline to keep this script dependency-light.
  const curated: [string, string, 'CE' | 'PE', number, number][] = [
    ['2026-03-17', 'NATIONALUM', 'CE', 390, 20250], ['2026-03-16', 'BANDHANBNK', 'PE', 170, 15120],
    ['2026-03-13', 'JINDALSTEL', 'PE', 1150, 18750], ['2026-03-11', 'COLPAL', 'PE', 2000, -2936],
    ['2026-03-10', 'HAVELLS', 'CE', 1400, 16500], ['2026-03-09', 'ONGC', 'PE', 280, 16425],
    ['2026-03-05', 'MAZDOCK', 'CE', 2300, 21930], ['2026-03-04', 'TATASTEEL', 'PE', 190, 17160],
    ['2026-02-27', 'HDFCLIFE', 'PE', 720, 18920], ['2026-02-26', 'LAURUSLABS', 'CE', 1100, -2550],
    ['2026-02-24', 'PERSISTENT', 'PE', 4600, 20050], ['2026-02-23', 'KPITTECH', 'PE', 800, 14110],
    ['2026-02-20', 'ABB', 'CE', 6000, 23875], ['2026-02-19', 'PERSISTENT', 'PE', 5400, 17400],
    ['2026-02-18', 'DIXON', 'PE', 11200, -2465], ['2026-02-17', 'BANKBARODA', 'CE', 300, 19013],
    ['2026-02-16', 'POWERGRID', 'CE', 295, 17100], ['2026-02-13', 'ADANIGREEN', 'PE', 960, 16410],
    ['2026-02-12', 'KPITTECH', 'PE', 920, 15725], ['2026-02-11', 'LAURUSLABS', 'CE', 1100, 18785],
  ];
  for (const [date, symbol, optionType, strike, pnl] of curated) add({ date, symbol, optionType, strike, pnl, entryTime: null });
  return out;
}

// ─── Data access ─────────────────────────────────────────────────────────────
interface EqBar { bucketTs: number; open: number; high: number; low: number; close: number }

const eqBarsStmt = db.prepare(
  `SELECT timestamp AS bucketTs, open, high, low, close FROM backtest_equity WHERE symbol=? AND date=? ORDER BY timestamp ASC`,
);
const getEqBars = (symbol: string, date: string): EqBar[] =>
  (eqBarsStmt.all(symbol, date) as EqBar[]).map((r) => ({
    bucketTs: Number(r.bucketTs), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
  }));

const bhavStmt = db.prepare(
  `SELECT eqHigh, eqLow FROM bhavcopy_days WHERE symbol=? AND date<? AND eqHigh>0 AND eqLow>0 ORDER BY date DESC LIMIT 20`,
);
const eqDailyStmt = db.prepare(
  `SELECT date, MAX(high) h, MIN(low) l FROM backtest_equity WHERE symbol=? AND date<? GROUP BY date ORDER BY date DESC LIMIT 20`,
);

/** Prev-day/5d/20d extremes from bhavcopy (live-path parity); fall back to
 *  daily aggregates of the downloaded prior equity bars. Null when neither
 *  source has enough history (trade then runs without those levels). */
function loadLevels(symbol: string, date: string): { prevHigh: number | null; prevLow: number | null; h5: number | null; l5: number | null; h20: number | null; l20: number | null; source: 'bhavcopy' | 'eq-bars' | 'none' } {
  let rows = (bhavStmt.all(symbol, date) as { eqHigh: number; eqLow: number }[]).map((r) => ({ h: Number(r.eqHigh), l: Number(r.eqLow) }));
  let source: 'bhavcopy' | 'eq-bars' | 'none' = 'bhavcopy';
  if (rows.length < 1) {
    rows = (eqDailyStmt.all(symbol, date) as { h: number; l: number }[]).map((r) => ({ h: Number(r.h), l: Number(r.l) })).filter((r) => r.h > 0 && r.l > 0);
    source = rows.length >= 1 ? 'eq-bars' : 'none';
  }
  const hi = (n: number) => (rows.length ? Math.max(...rows.slice(0, n).map((r) => r.h)) : null);
  const lo = (n: number) => (rows.length ? Math.min(...rows.slice(0, n).map((r) => r.l)) : null);
  return { prevHigh: rows[0]?.h ?? null, prevLow: rows[0]?.l ?? null, h5: hi(5), l5: lo(5), h20: hi(20), l20: lo(20), source };
}

const optBarsStmt = db.prepare(
  `SELECT timestamp, open, high, low, close FROM backtest_options
   WHERE symbol=? AND option_type=? AND CAST(strike AS REAL)=? AND date=? ORDER BY timestamp ASC`,
);
const lotPreservedStmt = db.prepare(
  `SELECT fut_lot_size FROM trade_contracts WHERE symbol=? AND date=? AND option_type=? AND CAST(strike AS REAL)=?`,
);
const lotMasterStmt = db.prepare(
  `SELECT lotSize FROM master_contracts WHERE underlying=? AND instrument='FUTSTK' AND lotSize>0 ORDER BY expiryDate ASC LIMIT 1`,
);
function resolveLot(symbol: string, date: string, optionType: string, strike: number): number | null {
  const p = lotPreservedStmt.get(symbol, date, optionType, strike) as { fut_lot_size: number | null } | undefined;
  if (p?.fut_lot_size && p.fut_lot_size > 0) return Number(p.fut_lot_size);
  const m = lotMasterStmt.get(symbol) as { lotSize: number | null } | undefined;
  return m?.lotSize && m.lotSize > 0 ? Number(m.lotSize) : null;
}

// ─── Walk-forward evaluation ─────────────────────────────────────────────────
const istMin = (ts: number) => Math.floor(((((ts + 5.5 * 3600) % 86400) + 86400) % 86400) / 60);
const fmtIST = (ts: number) => { const m = istMin(ts); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
/** "10:17:46 AM" → IST minute-of-day (broker-verified entry times). */
function parseEntryMin(s: string | null): number | null {
  const m = s?.match(/(\d+):(\d+)(?::\d+)?\s*(AM|PM)/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'PM') h += 12;
  return h * 60 + Number(m[2]);
}

interface WalkResult {
  /** First bar whose signal graded 'confirmed' (any side). */
  firstConfirmed: { barIdx: number; time: string; direction: 'bullish' | 'bearish'; levels: number } | null;
  /** First 'confirmed' in the TRADE's direction (entry trigger for the P&L sim). */
  firstConfirmedTfDir: { barIdx: number; time: string } | null;
  /** Signal state at TF's entry time (verified) or 10:30 fallback. */
  atEntry: BreakoutSignal | null;
  /** Signal state on the last bar of the day. */
  atClose: BreakoutSignal | null;
  /** Did a fakeout-risk grade ever appear in the trade's direction? */
  fakeoutSeenTfDir: boolean;
}

// ─── Option P&L simulation ───────────────────────────────────────────────────
// exit = 'trail': prev-candle-low trailing stop + ₹5k target (the lib/backtest
//        evaluator's mechanical rules — tight, exit-dominated).
// exit = 'hold':  ₹5k target else hold to the last bar — isolates the SIGNAL's
//        value in premium terms from any exit rule.
function simulateOption(symbol: string, t: Trade, entryBarTs: number, exitStyle: 'trail' | 'hold' | 'capped'): { net: number; exitReason: string } | null {
  const bars = (optBarsStmt.all(symbol, t.optionType, t.strike, t.date) as { timestamp: number; open: number; high: number; low: number; close: number }[]).map(
    (r) => ({ ts: Number(r.timestamp), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) }),
  );
  const entryIdx = bars.findIndex((b) => b.ts === entryBarTs);
  if (entryIdx < 0 || entryIdx >= bars.length - 1) return null;
  const lot = resolveLot(symbol, t.date, t.optionType, t.strike);
  if (lot == null) return null; // no real lot size → no P&L (never guessed)
  const entry = bars[entryIdx].close;
  if (!(entry > 0)) return null;
  const PROFIT_TARGET = 5000; // the app's ₹5k/day goal (trade-suggest config)
  const MAX_LOSS = 1500; // the app's ₹1.5k/lot max-loss cap (trade-suggest config)
  const target = entry + PROFIT_TARGET / lot;
  const hardStop = entry - MAX_LOSS / lot; // 'capped' style only
  let trail = bars[entryIdx].low;
  let exit = entry;
  let reason = 'time-exit';
  for (let i = entryIdx + 1; i < bars.length; i++) {
    const b = bars[i];
    if (exitStyle === 'trail') {
      trail = Math.max(trail, bars[i - 1].low);
      if (b.low <= trail) { exit = Math.min(trail, b.open); reason = 'stop-loss'; break; }
    }
    if (exitStyle === 'capped' && b.low <= hardStop) { exit = Math.min(hardStop, b.open); reason = 'stop-loss'; break; }
    if (b.high >= target) { exit = target; reason = 'profit-target'; break; }
    if (i === bars.length - 1) { exit = b.close; reason = 'time-exit'; }
  }
  const gross = (exit - entry) * lot;
  const charges = calculateOptionCharges({ numOrders: 2, buyTurnover: entry * lot, sellTurnover: exit * lot }).total;
  return { net: Math.round(gross - charges), exitReason: reason };
}

// ─── Run ─────────────────────────────────────────────────────────────────────
const trades = loadTrades();
interface Row {
  t: Trade; dir: 'bullish' | 'bearish'; res: WalkResult; levelSource: string;
  fwdMovePct: number | null; // equity move from first-confirmed close → day close, signed toward signal dir
  sim: { net: number; exitReason: string } | null;
  simHold: { net: number; exitReason: string } | null; // ₹5k-target-or-EOD (no stop) — isolates signal quality from exit rules
  simCapped: { net: number; exitReason: string } | null; // app-aligned: ₹5k target / −₹1.5k max-loss stop / EOD
}

function evaluateBook(tolerancePct: number, withSim: boolean): { rows: Row[]; skippedNoBars: number; skippedNoLevels: number } {
  const rows: Row[] = [];
  let skippedNoBars = 0;
  let skippedNoLevels = 0;

  for (const t of trades) {
    const bars = getEqBars(t.symbol, t.date);
    if (bars.length < 70) { skippedNoBars++; continue; } // partial day → not a fair test
    const lv = loadLevels(t.symbol, t.date);
    if (lv.source === 'none') { skippedNoLevels++; continue; }
    const dir: 'bullish' | 'bearish' = t.optionType === 'CE' ? 'bullish' : 'bearish';
    // Level inputs: OR fields are re-derived per bar from the growing slice
    // (exactly the live path's session-context math); EOD anchors are fixed.
    const mkLevels = (slice: EqBar[]): LevelInputs => {
      let orH: number | null = null; let orL: number | null = null; let lastMin = -1;
      for (const b of slice) {
        if (!(b.high > 0) || !(b.low > 0)) continue;
        const m = istMin(b.bucketTs);
        if (m >= 555 && m < 585) { orH = orH == null ? b.high : Math.max(orH, b.high); orL = orL == null ? b.low : Math.min(orL, b.low); }
        if (m > lastMin) lastMin = m;
      }
      return {
        openRangeHigh: orH, openRangeLow: orL, openRangeComplete: lastMin >= 580 && orH != null,
        priorDayHigh: lv.prevHigh, priorDayLow: lv.prevLow, high5d: lv.h5, low5d: lv.l5, high20d: lv.h20, low20d: lv.l20,
      };
    };
    const entryMin = parseEntryMin(t.entryTime) ?? 10 * 60 + 30; // TF's typical ~10:30 entry
    const res: WalkResult = { firstConfirmed: null, firstConfirmedTfDir: null, atEntry: null, atClose: null, fakeoutSeenTfDir: false };
    const dayOpen = bars[0].open;
    for (let i = 0; i < bars.length; i++) {
      const slice = bars.slice(0, i + 1);
      const ctx = deriveBreakoutContext(slice, mkLevels(slice), { breakTolerancePct: tolerancePct });
      const ltp = bars[i].close;
      const chg = dayOpen > 0 ? ((ltp - dayOpen) / dayOpen) * 100 : null;
      const sig = evaluateBreakout(ctx, ltp, null, chg);
      if (!sig) continue;
      if (sig.grade === 'confirmed' && res.firstConfirmed === null)
        res.firstConfirmed = { barIdx: i, time: fmtIST(bars[i].bucketTs), direction: sig.direction as 'bullish' | 'bearish', levels: sig.levelsCleared };
      if (sig.grade === 'confirmed' && sig.direction === dir && res.firstConfirmedTfDir === null)
        res.firstConfirmedTfDir = { barIdx: i, time: fmtIST(bars[i].bucketTs) };
      if (sig.grade === 'fakeout-risk' && sig.direction === dir) res.fakeoutSeenTfDir = true;
      if (istMin(bars[i].bucketTs) <= entryMin - 5) res.atEntry = sig;
      res.atClose = sig;
    }

    // Equity forward move after the FIRST confirmed signal (either side), signed
    // toward the signal's direction: positive = the signal was right.
    let fwdMovePct: number | null = null;
    if (res.firstConfirmed) {
      const c0 = bars[res.firstConfirmed.barIdx].close;
      const c1 = bars[bars.length - 1].close;
      const raw = c0 > 0 ? ((c1 - c0) / c0) * 100 : null;
      fwdMovePct = raw == null ? null : res.firstConfirmed.direction === 'bullish' ? raw : -raw;
    }

    // Option P&L: enter on the detector's confirmed signal in the trade's direction.
    let sim: Row['sim'] = null;
    let simHold: Row['simHold'] = null;
    let simCapped: Row['simCapped'] = null;
    if (withSim && res.firstConfirmedTfDir) {
      const ts = bars[res.firstConfirmedTfDir.barIdx].bucketTs;
      sim = simulateOption(t.symbol, t, ts, 'trail');
      simHold = simulateOption(t.symbol, t, ts, 'hold');
      simCapped = simulateOption(t.symbol, t, ts, 'capped');
    }

    rows.push({ t, dir, res, levelSource: lv.source, fwdMovePct, sim, simHold, simCapped });
  }
  return { rows, skippedNoBars, skippedNoLevels };
}

// ─── Report ──────────────────────────────────────────────────────────────────
const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// Tolerance sweep first: how does the morning-break tolerance change the read?
console.log(`\n═══ Morning-break tolerance sweep (entry-time checkpoint, in TF direction) ═══`);
for (const tol of [0, 0.1, 0.2]) {
  const { rows } = evaluateBook(tol, false);
  const at = (g: string) => rows.filter((r) => r.res.atEntry != null && r.res.atEntry.direction === r.dir && r.res.atEntry.grade === g);
  const conf = at('confirmed');
  const fake = at('fakeout-risk');
  const losses = rows.filter((r) => r.t.pnl <= 0);
  const lossNotConfirmed = losses.filter((r) => !(r.res.atEntry?.direction === r.dir && r.res.atEntry?.grade === 'confirmed'));
  const ws = rows.filter((r) => r.res.firstConfirmed);
  const dm = ws.filter((r) => r.res.firstConfirmed!.direction === r.dir);
  console.log(
    `tol ${tol.toFixed(1)}%: confirmed n=${conf.length} (TF-wr ${pct(conf.filter((r) => r.t.pnl > 0).length, conf.length)}) · ` +
    `fakeout n=${fake.length} (TF-wr ${pct(fake.filter((r) => r.t.pnl > 0).length, fake.length)}) · ` +
    `losses not-confirmed ${lossNotConfirmed.length}/${losses.length} · dir-match ${pct(dm.length, ws.length)}`,
  );
}

// Detailed report at the shipped default tolerance.
const { rows, skippedNoBars, skippedNoLevels } = evaluateBook(MORNING_BREAK_TOLERANCE_PCT, true);

console.log(`\n═══ TF-breakout backtest over the TradeFinder book (tolerance ${MORNING_BREAK_TOLERANCE_PCT}%) ═══`);
console.log(`Trades loaded ${trades.length} · evaluated ${rows.length} · skipped ${skippedNoBars} (no/partial bars) + ${skippedNoLevels} (no prior levels)`);
console.log(`Level source: ${rows.filter((r) => r.levelSource === 'bhavcopy').length} bhavcopy · ${rows.filter((r) => r.levelSource === 'eq-bars').length} prior-equity-bars`);
console.log(`NOTE: R-Factor unavailable historically → grades tested are confirmed/watch/fakeout-risk ('strong' needs live R-Factor).`);

// 1 · Direction agreement
const withSignal = rows.filter((r) => r.res.firstConfirmed);
const dirMatch = withSignal.filter((r) => r.res.firstConfirmed!.direction === r.dir);
console.log(`\n1 · DIRECTION — first confirmed breakout vs TF's traded side`);
console.log(`   signal fired on ${withSignal.length}/${rows.length} trade-days (${pct(withSignal.length, rows.length)})`);
console.log(`   direction matched TF: ${dirMatch.length}/${withSignal.length} (${pct(dirMatch.length, withSignal.length)})`);
const before1030 = withSignal.filter((r) => r.res.firstConfirmed!.time <= '10:30');
console.log(`   fired at/before 10:30 (TF's entry zone): ${before1030.length}/${withSignal.length} (${pct(before1030.length, withSignal.length)})`);

// 2 · Win/loss separation by the day's CLOSING grade in the TF direction
console.log(`\n2 · SEPARATION — TF outcome vs our grade (in TF's direction, at entry-time checkpoint)`);
const buckets = new Map<string, { w: number; l: number; pnl: number }>();
for (const r of rows) {
  const s = r.res.atEntry;
  const g = s == null ? 'no-signal' : s.direction === r.dir ? s.grade : s.grade === 'none' ? 'none' : `opposite-${s.grade}`;
  const b = buckets.get(g) ?? { w: 0, l: 0, pnl: 0 };
  if (r.t.pnl > 0) b.w++; else b.l++;
  b.pnl += r.t.pnl;
  buckets.set(g, b);
}
for (const [g, b] of [...buckets.entries()].sort((a, b2) => b2[1].w + b2[1].l - (a[1].w + a[1].l)))
  console.log(`   ${g.padEnd(22)} n=${String(b.w + b.l).padStart(3)} · TF wins ${b.w} / losses ${b.l} (win-rate ${pct(b.w, b.w + b.l)}) · ΣTF P&L ₹${Math.round(b.pnl).toLocaleString('en-IN')}`);

// TF's 25 losses specifically — did the detector warn?
const losses = rows.filter((r) => r.t.pnl <= 0);
const warned = losses.filter((r) => {
  const s = r.res.atEntry;
  // Warning = anything except a clean confirmed/strong in the trade's direction.
  return s == null || s.grade === 'none' || s.grade === 'watch' || s.grade === 'fakeout-risk' || s.direction !== r.dir;
});
console.log(`   TF LOSING trades: ${losses.length} — detector was NOT 'confirmed-in-direction' at entry on ${warned.length} (${pct(warned.length, losses.length)})`);

// 3 · Equity edge after the signal
console.log(`\n3 · EDGE — equity move from first-confirmed close → day close (signed toward signal)`);
const conf = rows.filter((r) => r.fwdMovePct != null).map((r) => r.fwdMovePct!) ;
console.log(`   after confirmed: n=${conf.length} · median ${median(conf)?.toFixed(2)}% · positive ${pct(conf.filter((x) => x > 0).length, conf.length)}`);
const fakeRows = rows.filter((r) => r.res.fakeoutSeenTfDir && r.res.firstConfirmedTfDir == null);
console.log(`   fakeout-risk-only days (TF dir, never cleanly confirmed): n=${fakeRows.length} · TF win-rate there ${pct(fakeRows.filter((r) => r.t.pnl > 0).length, fakeRows.length)}`);

// 4 · Option P&L on the detector's own entries
console.log(`\n4 · P&L — buy TF's contract when the detector confirms in that direction (real premiums/lots/charges)`);
const sims = rows.filter((r) => r.sim != null);
console.log(`   simulated ${sims.length} trades (option bars + real lot size required)`);
if (sims.length > 0) {
  for (const [label, pick] of [
    ['trail-stop exit', (r: Row) => r.sim],
    ['₹5k-target-or-EOD', (r: Row) => r.simHold],
    ['₹5k tgt / −₹1.5k SL', (r: Row) => r.simCapped],
  ] as const) {
    const xs = rows.filter((r) => pick(r) != null);
    const wins = xs.filter((r) => pick(r)!.net > 0);
    const total = xs.reduce((s, r) => s + pick(r)!.net, 0);
    const byReason = new Map<string, number>();
    for (const r of xs) byReason.set(pick(r)!.exitReason, (byReason.get(pick(r)!.exitReason) ?? 0) + 1);
    console.log(
      `   ${label.padEnd(18)} wins ${wins.length}/${xs.length} (${pct(wins.length, xs.length)}) · net ₹${total.toLocaleString('en-IN')} · avg ₹${Math.round(total / Math.max(1, xs.length)).toLocaleString('en-IN')}/trade · exits: ${[...byReason.entries()].map(([k, v]) => `${k} ${v}`).join(' · ')}`,
    );
  }
  const tfOnSame = sims.reduce((s, r) => s + r.t.pnl, 0);
  console.log(`   TF's actual P&L on those same trades: ₹${tfOnSame.toLocaleString('en-IN')} (their exits are discretionary)`);
}

if (CSV) {
  console.log(`\ndate,symbol,type,strike,tfPnl,levelSource,firstConfirmed,dir,dirMatch,atEntryGrade,fwdMovePct,simNet,simExit`);
  for (const r of rows) {
    const fc = r.res.firstConfirmed;
    console.log([
      r.t.date, r.t.symbol, r.t.optionType, r.t.strike, r.t.pnl, r.levelSource,
      fc?.time ?? '', fc?.direction ?? '', fc ? String(fc.direction === r.dir) : '',
      r.res.atEntry ? `${r.res.atEntry.grade}${r.res.atEntry.direction === r.dir ? '' : ' (opp)'}` : '',
      r.fwdMovePct?.toFixed(2) ?? '', r.sim?.net ?? '', r.sim?.exitReason ?? '',
    ].join(','));
  }
}
db.close();
