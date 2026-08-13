/**
 * PROOF HARNESS for the TF Running Race selector — "how much would we have made".
 *
 *   pnpm exec tsx scripts/replay-tf-selector.ts
 *
 * Replays every session that has TradeFinder captures through the SAME pure
 * modules the live engine uses — `raceAtMinute`, `selectTfCandidates`,
 * `buildSpotPlan`, `trailedSpotStop` — so a number printed here and a live pick
 * cannot diverge through code drift. Nothing is re-implemented locally except
 * the bar walk, which is what a live position guard does tick by tick.
 *
 * NO LOOKAHEAD. At each decision minute the board is filtered to captures at or
 * before that minute, the accumulation rate is measured against a board ≥30 min
 * earlier, opening-range checks use only bars strictly before the entry
 * bucket, and the entry price is the entry bar's OPEN. A same-candle tie between
 * stop and target resolves to the STOP — never flatter than reality.
 *
 * ── WHAT THIS CANNOT TELL YOU (read before believing the total) ─────────────
 *
 *  1. THETA IS NOT MODELLED. The walk is on SPOT. Holding an option to the
 *     square-off pays a full day of time decay that a spot path cannot see, and
 *     this exit model holds LONGER than the fixed-target one it replaces. Every
 *     rupee figure below is therefore OPTIMISTIC by an unmeasured amount.
 *  2. Three sessions. TF captures begin 2026-08-08 and cannot be backfilled —
 *     TF is live-capture only, so this sample grows one session per day.
 *  3. ~100 rule variants were tried on this same data. Thresholds are FITTED;
 *     a good t here is partly a multiple-comparisons artefact.
 *  4. Fills are assumed at the bar open with no slippage and no spread.
 *
 * The harness prints these with the results, every run, on purpose.
 */

process.loadEnvFile('.env.local');

import { prisma } from '@/lib/db';
import { getTfBoardsForDate, raceAtMinute, type TfBoardAt } from '@/lib/tf-live/race';
import { selectTfCandidates, type TfSymbolContext } from '@/lib/tf-live/selector';
import { buildSpotPlan } from '@/lib/trade-suggest/scoring';
import { trailedSpotStop } from '@/lib/auto-trade/risk/trailing-stop';
import { deriveSessionContext } from '@/lib/signals/session-context';
import { MIN_RISK_PCT, TF_RACE_MAX_RANK, TRAIL_R } from '@/lib/trade-suggest/config';
import { DEFAULT_SETTINGS } from '@/lib/auto-trade/config';

const q = (sql: string, ...p: unknown[]) =>
  prisma.$queryRawUnsafe(sql, ...p) as Promise<Record<string, unknown>[]>;

/** 1R in rupees — the per-lot risk ceiling the entry gate enforces. */
const RISK_RUPEES = DEFAULT_SETTINGS.maxRiskPerLotRupees;
const SQUARE_OFF_MIN = 15 * 60 + 12;
const ENTRY_MINUTES = [9 * 60 + 45, 10 * 60, 10 * 60 + 15, 10 * 60 + 30, 10 * 60 + 45, 11 * 60];
const MAX_TRADES_PER_DAY = DEFAULT_SETTINGS.maxTradesPerDay;

const istMin = (ms: number): number => {
  const p = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  return Number(p.find((x) => x.type === 'hour')!.value) * 60 + Number(p.find((x) => x.type === 'minute')!.value);
};
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const inr = (n: number) => `${n < 0 ? '-' : '+'}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;

/** Recorded OHLCV shape used by the shared plan and path evaluator. */
interface Bar { bucketTs: number; open: number; high: number; low: number; close: number; volume: number }
interface Trade {
  date: string; symbol: string; side: 'CE' | 'PE'; entryMin: number;
  entry: number; stop: number; r: number; exit: string; tfR: number; deltaR: number; premCr: number;
}

/** Walk the path: stop (with trail) or square-off. Stop wins a same-candle tie. */
function walk(side: 'CE' | 'PE', entry: number, initialStop: number, bars: Bar[], entryTs: number) {
  const bull = side === 'CE';
  const risk = Math.abs(entry - initialStop);
  if (!(risk > 0)) return null;
  const path = bars.filter((b) => b.bucketTs > entryTs && istMin(b.bucketTs * 1000) <= SQUARE_OFF_MIN)
    .sort((a, b) => a.bucketTs - b.bucketTs);
  if (path.length === 0) return null;

  let stop = initialStop;
  let extreme = entry;
  for (const b of path) {
    // Stop is checked FIRST and against the stop as it stood entering this bar —
    // trailing on the same bar that stopped us out would be lookahead.
    if (bull ? b.low <= stop : b.high >= stop) {
      return { r: (bull ? stop - entry : entry - stop) / risk, exit: stop === initialStop ? 'stop' : 'trail' };
    }
    extreme = bull ? Math.max(extreme, b.high) : Math.min(extreme, b.low);
    stop = trailedSpotStop({
      direction: bull ? 'bullish' : 'bearish',
      entrySpot: entry, currentStop: stop, riskPoints: risk, favourableExtreme: extreme, trailR: TRAIL_R,
    });
  }
  const close = path[path.length - 1].close;
  return { r: (bull ? close - entry : entry - close) / risk, exit: 'square-off' };
}

async function main(): Promise<void> {
  const dates = (await q(
    `SELECT DISTINCT date(datetime(capturedAt,'+5 hours','+30 minutes')) d
     FROM tf_live_captures WHERE endpoint='all_sector' AND status='success' ORDER BY d`
  )).map((r) => String(r.d));

  console.log('\n' + '═'.repeat(92));
  console.log('  TF RUNNING RACE SELECTOR — REPLAY');
  console.log(`  ${dates.length} session(s) with TF captures: ${dates.join(', ')}`);
  console.log(`  1R = ₹${RISK_RUPEES.toLocaleString('en-IN')} · stop ${MIN_RISK_PCT}% · trail ${TRAIL_R}R · max ${MAX_TRADES_PER_DAY} trades/day`);
  console.log('═'.repeat(92));

  const trades: Trade[] = [];
  const perDay: { date: string; trades: Trade[]; halted: boolean }[] = [];

  for (const date of dates) {
    let boards: TfBoardAt[] = [];
    try { boards = await getTfBoardsForDate(date); } catch { /* unreadable day */ }
    if (boards.length < 2) { console.log(`\n${date}: fewer than 2 usable boards — skipped`); continue; }

    const bars = await q(
      `SELECT symbol,bucketTs,open,high,low,close,volume FROM fyers_candles WHERE date=? ORDER BY symbol,bucketTs`, date);
    if (bars.length === 0) { console.log(`\n${date}: no candles recorded — skipped`); continue; }
    const bySym = new Map<string, Bar[]>();
    for (const b of bars) {
      const a = bySym.get(String(b.symbol)) ?? [];
      a.push({
        bucketTs: Number(b.bucketTs), open: Number(b.open), high: Number(b.high),
        low: Number(b.low), close: Number(b.close), volume: Number(b.volume ?? 0),
      });
      bySym.set(String(b.symbol), a);
    }
    const oi = await q(`SELECT symbol,bucketTs,premValueCr FROM oi_intraday WHERE date=? ORDER BY symbol,bucketTs`, date);
    const oiBy = new Map<string, { bucketTs: number; premValueCr: number | null }[]>();
    for (const r of oi) {
      const a = oiBy.get(String(r.symbol)) ?? [];
      a.push({ bucketTs: Number(r.bucketTs), premValueCr: r.premValueCr == null ? null : Number(r.premValueCr) });
      oiBy.set(String(r.symbol), a);
    }

    const dayTrades: Trade[] = [];
    const takenToday = new Set<string>();   // one entry per symbol per day
    let dayPnl = 0;
    let halted = false;

    for (const em of ENTRY_MINUTES) {
      if (halted || dayTrades.length >= MAX_TRADES_PER_DAY) break;
      const race = raceAtMinute(boards, em, TF_RACE_MAX_RANK);
      if (!race.available) continue;

      // Per-symbol context, exactly as the live engine assembles it.
      const context = new Map<string, TfSymbolContext>();
      for (const runner of race.runners) {
        const sb = (bySym.get(runner.symbol) ?? []).filter((b) => b.high > 0);
        const entryTs = sb.find((b) => istMin(b.bucketTs * 1000) >= em)?.bucketTs;
        if (entryTs == null) { context.set(runner.symbol, { supertrendAligned: null, breakout: null, premValueCr: null, sinceEntryPct: null }); continue; }
        const prior = sb.filter((b) => b.bucketTs < entryTs);
        const entry = sb.find((b) => b.bucketTs === entryTs)!.open;
        const side: 'CE' | 'PE' = (runner.pctChange ?? 0) > 0 ? 'CE' : 'PE';
        const sc = deriveSessionContext(prior);
        const at945 = sb.find((b) => istMin(b.bucketTs * 1000) >= 9 * 60 + 45);
        const raw = at945 && at945.open > 0 ? ((entry - at945.open) / at945.open) * 100 : null;
        const prem = [...(oiBy.get(runner.symbol) ?? [])].reverse().find((r) => r.bucketTs <= entryTs)?.premValueCr ?? null;
        context.set(runner.symbol, {
          supertrendAligned: null,
          breakout: !sc.openRangeComplete ? null
            : side === 'CE' ? sc.openRangeHigh != null && entry > sc.openRangeHigh
              : sc.openRangeLow != null && entry < sc.openRangeLow,
          premValueCr: prem,
          sinceEntryPct: raw == null ? null : side === 'CE' ? raw : -raw,
        });
      }

      const { candidates } = selectTfCandidates(race.runners, context);
      for (const c of candidates) {
        if (halted || dayTrades.length >= MAX_TRADES_PER_DAY) break;
        if (takenToday.has(c.symbol)) continue;
        const sb = (bySym.get(c.symbol) ?? []).filter((b) => b.high > 0);
        const entryTs = sb.find((b) => istMin(b.bucketTs * 1000) >= em)?.bucketTs;
        if (entryTs == null) continue;
        const prior = sb.filter((b) => b.bucketTs < entryTs);
        if (prior.length < 10) continue;
        const entry = sb.find((b) => b.bucketTs === entryTs)!.open;
        if (!(entry > 0)) continue;
        const plan = buildSpotPlan(c.side, entry, sb, deriveSessionContext(prior), entryTs, { atrMult: 0 });
        if (plan.slSpot == null) continue;
        const res = walk(c.side, entry, plan.slSpot, sb, entryTs);
        if (res == null) continue;

        takenToday.add(c.symbol);
        const t: Trade = {
          date, symbol: c.symbol, side: c.side, entryMin: em, entry, stop: plan.slSpot,
          r: res.r, exit: res.exit, tfR: c.tfRFactor, deltaR: c.deltaR, premCr: c.premValueCr,
        };
        dayTrades.push(t); trades.push(t);
        dayPnl += res.r * RISK_RUPEES;
        // Daily loss halt — one full stop ends the day.
        if (dayPnl <= -DEFAULT_SETTINGS.dailyLossHaltRupees) halted = true;
      }
    }
    perDay.push({ date, trades: dayTrades, halted });
  }

  // ── Per-session detail ────────────────────────────────────────────────────
  for (const d of perDay) {
    const pnl = d.trades.reduce((s, t) => s + t.r * RISK_RUPEES, 0);
    console.log(`\n── ${d.date} ──  ${d.trades.length} trade(s)   ${inr(pnl)}${d.halted ? '   [DAILY LOSS HALT]' : ''}`);
    if (d.trades.length === 0) { console.log('   no qualifying TF race candidate all window'); continue; }
    console.log('   time   symbol        side  TF-R   ΔR30  prem₹Cr   entry      stop    exit         R      ₹');
    for (const t of d.trades) {
      console.log(
        `   ${hhmm(t.entryMin)}  ${t.symbol.padEnd(13)} ${t.side}  ${t.tfR.toFixed(2).padStart(5)} ${t.deltaR.toFixed(2).padStart(6)} ${String(Math.round(t.premCr)).padStart(8)} ` +
        `${t.entry.toFixed(2).padStart(9)} ${t.stop.toFixed(2).padStart(9)}  ${t.exit.padEnd(10)} ${(t.r >= 0 ? '+' : '') + t.r.toFixed(2)}  ${inr(t.r * RISK_RUPEES)}`
      );
    }
  }

  // ── Scorecard ─────────────────────────────────────────────────────────────
  const R = trades.map((t) => t.r);
  const n = R.length;
  console.log('\n' + '═'.repeat(92));
  console.log('  SCORECARD');
  console.log('═'.repeat(92));
  if (n === 0) { console.log('  No trades taken. Nothing to report — and nothing is being claimed.'); await prisma.$disconnect(); return; }

  const mean = R.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(R.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  const se = sd / Math.sqrt(n);
  const wins = R.filter((x) => x > 0);
  const losses = R.filter((x) => x <= 0);
  const totalPnl = mean * RISK_RUPEES * n;
  const dayPnls = perDay.map((d) => d.trades.reduce((s, t) => s + t.r * RISK_RUPEES, 0));
  const winDays = dayPnls.filter((p) => p > 0).length;

  const row = (k: string, v: string) => console.log(`  ${k.padEnd(30)} ${v}`);
  row('sessions replayed', String(perDay.length));
  row('trades', String(n));
  row('win rate', `${Math.round((100 * wins.length) / n)}%  (${wins.length}W / ${losses.length}L)`);
  row('avg R per trade', `${mean >= 0 ? '+' : ''}${mean.toFixed(3)}  ± ${se.toFixed(3)} (t = ${(mean / se).toFixed(2)})`);
  row('avg ₹ per trade', inr(mean * RISK_RUPEES));
  row('best / worst trade', `${Math.max(...R).toFixed(2)}R / ${Math.min(...R).toFixed(2)}R`);
  if (wins.length) row('avg WIN', `${(wins.reduce((a, b) => a + b, 0) / wins.length).toFixed(2)}R`);
  if (losses.length) row('avg LOSS', `${(losses.reduce((a, b) => a + b, 0) / losses.length).toFixed(2)}R`);
  row('winning sessions', `${winDays} / ${perDay.length}`);
  row('avg per session', inr(dayPnls.reduce((a, b) => a + b, 0) / Math.max(1, perDay.length)));
  row('TOTAL', inr(totalPnl));
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  row('profit factor', grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : 'n/a (no losses)');
  const byExit = new Map<string, number>();
  for (const t of trades) byExit.set(t.exit, (byExit.get(t.exit) ?? 0) + 1);
  row('exits', [...byExit].map(([k, v]) => `${k} ${v}`).join(', '));

  console.log('\n' + '─'.repeat(92));
  console.log('  READ THIS BEFORE BELIEVING THE TOTAL');
  console.log('─'.repeat(92));
  console.log(`  1. THETA IS NOT MODELLED. The walk is on SPOT. Holding an option to ${hhmm(SQUARE_OFF_MIN)} pays a`);
  console.log('     full day of decay a spot path cannot see, and this exit model holds LONGER than the');
  console.log('     fixed-target one it replaces. Every rupee above is OPTIMISTIC by an unmeasured amount.');
  console.log(`  2. ${perDay.length} session(s). TF captures start 2026-08-08 and CANNOT be backfilled (live capture only),`);
  console.log('     so this sample grows one session per day and no faster.');
  console.log('  3. ~100 rule variants were tried on this same data. The thresholds are FITTED; a good');
  console.log('     t-statistic here is partly a multiple-comparisons artefact, not an out-of-sample result.');
  console.log('  4. Fills assumed at the bar OPEN — no slippage, no bid-ask, no partial fills.');
  console.log(`  5. Only ~99-109 symbols/session carry an oi_intraday premium reading, so names without one`);
  console.log('     were rejected for missing evidence, not for being bad.');
  console.log('\n  Paper mode measures 1 and 4 against real premiums. Until it has, this is a hypothesis.\n');

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
