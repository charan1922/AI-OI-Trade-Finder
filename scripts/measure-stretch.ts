/**
 * Option P&L by how STRETCHED the stock was at entry — the measurement that
 * decides whether a "room left" gate is ever added (operator, 2026-10-09).
 *
 *   npx tsx scripts/measure-stretch.ts            # all recorded trades
 *   npx tsx scripts/measure-stretch.ts --mode=paper
 *
 * Why it exists: on 2026-10-09 COLPAL, TCS and EICHERMOT calls were bought after
 * the stocks had already used 2.99× / 2.32× / 1.55× a normal day's range; the
 * stocks then went sideways and every option bled 4–10%. A spot-only study of
 * 1,458 breakouts could NOT confirm a cutoff (the extremes won 3 of 4 on spot,
 * and 2026-10-08's good trend trades sat at 1.41–1.73×). The missing evidence is
 * OPTION P&L, which only forward trades supply — so every entry stores its
 * stretch (auto_trades.entryRangeUsedAdr / entryFirstCandleAdr /
 * entryFromPrevClosePct) and this report reads closed trades by bucket.
 *
 * Read the counts before the averages: a bucket under MIN_BUCKET trades is
 * printed but flagged, and no verdict is offered from it.
 */
process.loadEnvFile('.env.local');

import { prisma } from '@/lib/db';
import { ensureTables } from '@/lib/auto-trade/store';

const MIN_BUCKET = 10;

interface Row {
  date: string;
  symbol: string;
  optionType: string;
  mode: string;
  entryFillPremium: number;
  exitFillPremium: number;
  realizedPnlRupees: number | null;
  rangeUsed: number | null;
  firstCandle: number | null;
  fromPrev: number | null;
}

function bucketTable(title: string, rows: Row[], pick: (r: Row) => number | null, edges: number[]): void {
  console.log(`\n${title}`);
  const known = rows.filter((r) => pick(r) != null);
  console.log(`  (${rows.length - known.length} trade(s) without this measurement are excluded)`);
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i];
    const hi = edges[i + 1];
    const b = known.filter((r) => pick(r)! >= lo && pick(r)! < hi);
    if (b.length === 0) {
      console.log(`  ${String(lo).padStart(4)}–${String(hi).padEnd(4)} n=0`);
      continue;
    }
    const ret = b.map((r) => ((r.exitFillPremium - r.entryFillPremium) / r.entryFillPremium) * 100);
    const pnl = b.map((r) => r.realizedPnlRupees ?? 0);
    const avg = ret.reduce((a, v) => a + v, 0) / ret.length;
    const wins = ret.filter((v) => v > 0).length;
    console.log(
      `  ${String(lo).padStart(4)}–${String(hi).padEnd(4)} n=${String(b.length).padStart(3)} ` +
        `win ${((wins / b.length) * 100).toFixed(0).padStart(3)}%  avg option return ${avg >= 0 ? '+' : ''}${avg.toFixed(1)}%  ` +
        `P&L ₹${Math.round(pnl.reduce((a, v) => a + v, 0)).toLocaleString('en-IN')}` +
        (b.length < MIN_BUCKET ? `  ← fewer than ${MIN_BUCKET} trades: no conclusion` : '')
    );
  }
}

async function main(): Promise<void> {
  // Adds the stretch columns on a DB that has not seen an entry since they were introduced.
  await ensureTables();
  const modeArg = process.argv.find((a) => a.startsWith('--mode='))?.slice('--mode='.length) ?? null;
  const raw = (await prisma.$queryRawUnsafe(
    `SELECT date, symbol, optionType, mode, entryFillPremium, exitFillPremium, realizedPnlRupees,
            entryRangeUsedAdr AS rangeUsed, entryFirstCandleAdr AS firstCandle, entryFromPrevClosePct AS fromPrev
       FROM auto_trades
      WHERE status = 'closed' AND entryFillPremium > 0 AND exitFillPremium IS NOT NULL
        ${modeArg ? 'AND mode = ?' : ''}
      ORDER BY date, id`,
    ...(modeArg ? [modeArg] : [])
  )) as Record<string, unknown>[];
  const num = (v: unknown) => (v == null ? null : Number(v));
  const rows: Row[] = raw.map((r) => ({
    date: String(r.date),
    symbol: String(r.symbol),
    optionType: String(r.optionType),
    mode: String(r.mode),
    entryFillPremium: Number(r.entryFillPremium),
    exitFillPremium: Number(r.exitFillPremium),
    realizedPnlRupees: num(r.realizedPnlRupees),
    rangeUsed: num(r.rangeUsed),
    firstCandle: num(r.firstCandle),
    fromPrev: num(r.fromPrev),
  }));
  const measured = rows.filter((r) => r.rangeUsed != null);
  console.log(
    `Closed trades${modeArg ? ` (mode=${modeArg})` : ''}: ${rows.length}; with a stretch measurement: ${measured.length}` +
      (measured.length > 0 ? ` (${measured[0].date} → ${measured.at(-1)!.date})` : '')
  );
  if (measured.length === 0) {
    console.log('Nothing to measure yet — stretch is recorded on entries from 2026-10-09 onward.');
    return;
  }
  bucketTable('RANGE USED at entry (× normal daily range)', rows, (r) => r.rangeUsed, [0, 1, 1.5, 2, 2.5, 99]);
  bucketTable('FIRST 09:15 CANDLE (× normal daily range)', rows, (r) => r.firstCandle, [0, 0.5, 1, 1.5, 99]);
  bucketTable('MOVE FROM PREV CLOSE in the trade direction (%)', rows, (r) => r.fromPrev, [-99, 0, 2, 4, 6, 99]);
  console.log(
    '\nCaveats: in-sample, one lot per trade, paper fills at live quotes. Option return includes theta and IV' +
      ' changes by construction — that is the point. Promote nothing to a gate from a bucket under ' +
      `${MIN_BUCKET} trades.`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
