/**
 * Does MiMo's "market regime" gate (2026-10-29) separate losing days from the rest?
 *
 * The proposal: at the moment the scanner decides, the market is STUCK (→ no trade) when ALL three:
 *   1. NIFTY is inside its 30-min opening range (09:15–09:45) AND that range is narrow (< 0.4% of the index);
 *   2. F&O breadth is split — gainers vs losers (vs yesterday's close) between 40% and 60%;
 *   3. chop — more than 65% of F&O stocks are still inside their OWN 30-min opening range.
 *
 * Outcome per day, with NO lookahead: at each decision minute, every F&O stock that has already
 * broken its own 30-min range is entered at the next bar's open in the break's direction, with a
 * MIN_RISK_PCT spot stop and a 2R reference target, timing out at the close — graded by the app's own
 * path-dependent gradeSpotPath (the scorer real suggestions get). Then stuck vs not-stuck is compared.
 *
 * Needs the local DB (fyers_candles) and a Fyers token (NIFTY index bars come from Fyers history —
 * they are not recorded). Not a CI script. Run: pnpm exec tsx scripts/measure-market-regime.ts
 */
process.loadEnvFile('.env.local');

import { fetchHistory5m } from '../lib/fyers/client';
import { prisma } from '../lib/db';
import { gradeSpotPath } from '../lib/trade-suggest/grade';
import { MIN_RISK_PCT } from '../lib/trade-suggest/config';
import { classifyMarketRegime, DEFAULT_MARKET_REGIME_RULE, type RegimeStock } from '../lib/tf-live/market-regime';

const NIFTY = 'NSE:NIFTY50-INDEX';
const DECISION_MINUTES = (process.env.REGIME_MINUTES ?? '600,630')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n)); // 10:00, 10:30 IST
const LAST_BUCKET_MIN = 15 * 60 + 25;
const SKIP_NIFTY = process.env.REGIME_SKIP_NIFTY === '1';

interface Bar {
  bucketTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const istMin = (sec: number) => Math.floor(((sec + 19800) % 86400) / 60);
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function orOf(bars: Bar[]): { high: number; low: number } | null {
  const or = bars.filter((b) => istMin(b.bucketTs) >= 9 * 60 + 15 && istMin(b.bucketTs) < 9 * 60 + 45 && b.high > 0);
  if (or.length < 6) return null; // the whole 30-min range, or nothing
  return { high: Math.max(...or.map((b) => b.high)), low: Math.min(...or.map((b) => b.low)) };
}

function stat(xs: number[]): string {
  if (xs.length === 0) return 'n=0';
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
  return `n=${String(xs.length).padStart(4)}  avg ${m >= 0 ? '+' : ''}${m.toFixed(3)}R  ±${(sd / Math.sqrt(xs.length)).toFixed(3)} SE`;
}

async function main(): Promise<void> {
  const dates = (
    (await prisma.$queryRawUnsafe(
      `SELECT DISTINCT date FROM fyers_candles WHERE instrument = 'EQ' ORDER BY date`
    )) as { date: string }[]
  ).map((r) => r.date);
  console.log(`\nMarket-regime gate (MiMo, 2026-10-29) — ${dates.length} sessions ${dates[0]}..${dates[dates.length - 1]}`);
  console.log(`rule: ${JSON.stringify(DEFAULT_MARKET_REGIME_RULE)}  decision minutes: ${DECISION_MINUTES.map(hhmm).join(', ')}\n`);

  const stuckR: number[] = [];
  const freeR: number[] = [];
  let prevClose = new Map<string, number>();

  for (const date of dates) {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT symbol, bucketTs, open, high, low, close FROM fyers_candles WHERE date = ? AND instrument = 'EQ' ORDER BY symbol, bucketTs`,
      date
    )) as (Bar & { symbol: string; bucketTs: number | bigint })[];
    const bySym = new Map<string, Bar[]>();
    for (const r of rows) {
      const list = bySym.get(r.symbol) ?? [];
      list.push({ ...r, bucketTs: Number(r.bucketTs) });
      bySym.set(r.symbol, list);
    }
    let nifty: Bar[] = [];
    try {
      nifty = (await fetchHistory5m(NIFTY, date)).map((b) => ({ ...b, bucketTs: Number(b.bucketTs) }));
    } catch (e) {
      console.log(`${date}: NIFTY history unavailable (${(e as Error).message}) — day skipped`);
    }

    for (const M of DECISION_MINUTES) {
      // No NIFTY bars (e.g. a network that blocks the broker API): REGIME_SKIP_NIFTY=1 measures conditions
      // 2+3 only. The full gate ALSO needs NIFTY stuck, so it blocks a SUBSET of these days — if 2+3 show
      // no edge, the full gate cannot either.
      if (prevClose.size === 0) break;
      if (nifty.length === 0 && !SKIP_NIFTY) break;
      const before = (bars: Bar[]) => bars.filter((b) => istMin(b.bucketTs) + 5 <= M); // COMPLETED before M
      const nPrior = before(nifty);
      const nOr = orOf(nPrior);
      const stocks: RegimeStock[] = [];
      for (const [sym, bars] of bySym) {
        const prior = before(bars);
        const or = orOf(prior);
        const last = prior[prior.length - 1]?.close ?? null;
        const pc = prevClose.get(sym) ?? null;
        stocks.push({
          insideOwnRange: or == null || last == null ? null : last <= or.high && last >= or.low,
          dayChangePct: pc == null || last == null ? null : ((last - pc) / pc) * 100,
        });
      }
      const regime = classifyMarketRegime({
        niftyRange: nOr,
        niftyLast: nPrior[nPrior.length - 1]?.close ?? null,
        stocks,
      });

      // Outcome: every stock already broken out of its own range at M, entered at the next bar's open.
      const dayR: number[] = [];
      for (const bars of bySym.values()) {
        const prior = before(bars);
        const or = orOf(prior);
        const last = prior[prior.length - 1]?.close;
        const entryBar = bars.find((b) => istMin(b.bucketTs) === M);
        if (!or || last == null || !entryBar) continue;
        const side = last > or.high ? 'CE' : last < or.low ? 'PE' : null;
        if (!side) continue;
        const entry = entryBar.open;
        const risk = (entry * MIN_RISK_PCT) / 100;
        const stop = side === 'CE' ? entry - risk : entry + risk;
        const target = side === 'CE' ? entry + 2 * risk : entry - 2 * risk;
        const g = gradeSpotPath(
          side,
          entry,
          stop,
          target,
          bars,
          entryBar.bucketTs,
          entryBar.bucketTs - (M - LAST_BUCKET_MIN) * 60
        );
        if (g?.outcomeR != null) dayR.push(g.outcomeR);
      }
      const r = DEFAULT_MARKET_REGIME_RULE;
      const stuckHere = SKIP_NIFTY
        ? regime.gainerShare != null &&
          regime.insideShare != null &&
          regime.gainerShare >= r.breadthLow &&
          regime.gainerShare <= r.breadthHigh &&
          regime.insideShare > r.minInsideShare
        : regime.stuck === true;
      (stuckHere ? stuckR : freeR).push(...dayR);
      const avg = dayR.length ? dayR.reduce((a, b) => a + b, 0) / dayR.length : NaN;
      console.log(
        `${date} ${hhmm(M)}  ${stuckHere ? 'STUCK ' : 'free  '}  ` +
          `nifty ${regime.niftyRangePct == null ? '  —  ' : `${regime.niftyRangePct.toFixed(2)}%`} ${regime.niftyInside ? 'in ' : 'out'}  ` +
          `breadth ${regime.gainerShare == null ? '—' : `${Math.round(regime.gainerShare * 100)}%`}  ` +
          `inside-own ${regime.insideShare == null ? '—' : `${Math.round(regime.insideShare * 100)}%`}   ` +
          `breakouts n=${dayR.length} avg ${Number.isNaN(avg) ? '—' : `${avg >= 0 ? '+' : ''}${avg.toFixed(2)}R`}`
      );
    }

    // Tomorrow's "previous close" = today's last recorded close.
    prevClose = new Map([...bySym].map(([s, bars]) => [s, bars[bars.length - 1].close]));
  }

  console.log('\n────────────────────────────────────────────────────────────────');
  console.log(`STUCK (gate would block)   ${stat(stuckR)}`);
  console.log(`not stuck (gate passes)    ${stat(freeR)}`);
  console.log('────────────────────────────────────────────────────────────────');
  console.log('Caveats: spot R only (no theta, no bid-ask); every breakout counted, not the TF selector’s picks;');
  console.log('one regime per decision minute; ~20 sessions — read the gap against its SE, not as proof.\n');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
