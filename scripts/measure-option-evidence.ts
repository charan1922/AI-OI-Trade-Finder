/**
 * PHASE 1 — does the option chain's directional read actually predict anything?
 *
 * The option-chain evidence (lib/option-chain/evidence.ts) has been
 * RECORDED for every strong scanner name since 2026-07-23 and displayed on
 * /live as "R V2 Shadow", but it has never influenced a single decision: grep
 * lib/trade-suggest, lib/auto-trade and lib/ai-commentary and it appears
 * nowhere. Before wiring it into anything that places an order, it has to earn
 * that on recorded evidence.
 *
 * THE QUESTION: when the chain's direction AGREED with the side the scanner
 * suggested (CE↔bullish, PE↔bearish), did those suggestions do better than the
 * ones it CONTRADICTED?
 *
 * NO LOOKAHEAD. A snapshot may only be used if it was captured at or before
 * `suggestedAt`. This is the single assumption the whole study rests on: pairing
 * a suggestion with a chain read taken even a minute later would leak the
 * future into the "prediction" and manufacture an edge that cannot be traded.
 * Suggestions with no prior snapshot are reported as unmatched, never
 * back-filled with the nearest later one.
 *
 * Run: npx tsx scripts/measure-option-evidence.ts
 */
// Node's built-in, NOT `dotenv` — that package is not a dependency of this repo.
// It resolves locally only because pnpm hoists it transitively, so `pnpm
// typecheck:scripts` passes on a dev machine and fails on CI's clean
// --frozen-lockfile install (TS2307, caught 2026-08-11). Every other bench here
// uses process.loadEnvFile for the same reason.
process.loadEnvFile('.env.local');

import { prisma } from '@/lib/db';

interface Row {
  date: string;
  symbol: string;
  optionType: string;
  suggestedAt: string;
  spotOutcome: string;
  spotOutcomeR: number;
  reasons: string | null;
}
interface Snap {
  date: string;
  symbol: string;
  capturedAt: string;
  direction: string;
  directionScore: number;
  directionConfidence: number;
  activityScore: number;
}

/** Mean, win-rate and expectancy for one bucket of outcomes. */
function summarize(label: string, rs: number[]): string {
  if (rs.length === 0) return `${label.padEnd(26)} n=0`;
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const wins = rs.filter((r) => r > 0).length;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rs.length - 1));
  // Standard error of the mean — the honest band on `mean` at this sample size.
  const se = sd / Math.sqrt(rs.length);
  return (
    `${label.padEnd(26)} n=${String(rs.length).padEnd(5)} ` +
    `meanR=${mean >= 0 ? '+' : ''}${mean.toFixed(3)} ±${se.toFixed(3)}  ` +
    `win=${((wins / rs.length) * 100).toFixed(1)}%`
  );
}

async function main(): Promise<void> {
  const suggestions = (await prisma.$queryRawUnsafe(`
    SELECT date, symbol, optionType, suggestedAt, spotOutcome, spotOutcomeR, reasons
    FROM trade_suggestions
    WHERE spotOutcomeR IS NOT NULL AND suggestedAt IS NOT NULL
    ORDER BY date, suggestedAt
  `)) as Row[];

  const snaps = (await prisma.$queryRawUnsafe(`
    SELECT date, symbol, capturedAt, direction, directionScore, directionConfidence, activityScore
    FROM option_chain_snapshots
    ORDER BY symbol, capturedAt
  `)) as Snap[];

  const byKey = new Map<string, Snap[]>();
  for (const s of snaps) {
    const k = `${s.date}|${s.symbol}`;
    const arr = byKey.get(k) ?? [];
    arr.push(s);
    byKey.set(k, arr);
  }

  const paired: { row: Row; snap: Snap; agree: boolean; contradict: boolean; ageMin: number }[] = [];
  let unmatchedNoSymbol = 0;
  let unmatchedOnlyLater = 0;

  for (const row of suggestions) {
    const series = byKey.get(`${row.date}|${row.symbol}`);
    if (!series) {
      unmatchedNoSymbol += 1;
      continue;
    }
    const cutoff = Date.parse(row.suggestedAt);
    // Latest snapshot AT OR BEFORE the suggestion — never after (see header).
    let best: Snap | null = null;
    for (const s of series) {
      const t = Date.parse(s.capturedAt);
      if (t <= cutoff && (best == null || t > Date.parse(best.capturedAt))) best = s;
    }
    if (best == null) {
      unmatchedOnlyLater += 1;
      continue;
    }
    const wantBullish = row.optionType === 'CE';
    const agree = best.direction === (wantBullish ? 'bullish' : 'bearish');
    const contradict = best.direction === (wantBullish ? 'bearish' : 'bullish');
    paired.push({
      row,
      snap: best,
      agree,
      contradict,
      ageMin: Math.round((cutoff - Date.parse(best.capturedAt)) / 60_000),
    });
  }

  console.log('════ PHASE 1 — option-chain direction vs realised outcome ════\n');
  console.log(`graded suggestions            : ${suggestions.length}`);
  console.log(`  no option snapshot at all   : ${unmatchedNoSymbol}`);
  console.log(`  snapshot exists but only AFTER the suggestion (excluded, no lookahead): ${unmatchedOnlyLater}`);
  console.log(`  USABLE PAIRS                : ${paired.length}`);
  if (paired.length === 0) {
    console.log('\nNothing to measure.');
    return;
  }
  const ages = paired.map((p) => p.ageMin).sort((a, b) => a - b);
  console.log(`  snapshot age at suggest (min): median ${ages[Math.floor(ages.length / 2)]}, max ${ages[ages.length - 1]}\n`);

  const all = paired.map((p) => p.row.spotOutcomeR);
  const agree = paired.filter((p) => p.agree).map((p) => p.row.spotOutcomeR);
  const contra = paired.filter((p) => p.contradict).map((p) => p.row.spotOutcomeR);
  const neutral = paired.filter((p) => !p.agree && !p.contradict).map((p) => p.row.spotOutcomeR);

  console.log('── Baseline vs agreement ──');
  console.log(summarize('ALL paired', all));
  console.log(summarize('chain AGREES', agree));
  console.log(summarize('chain CONTRADICTS', contra));
  console.log(summarize('chain NEUTRAL', neutral));

  console.log('\n── If we had VETOED the contradicted ones ──');
  const kept = paired.filter((p) => !p.contradict).map((p) => p.row.spotOutcomeR);
  console.log(summarize('kept (agree+neutral)', kept));
  const baseMean = all.reduce((a, b) => a + b, 0) / all.length;
  const keptMean = kept.length ? kept.reduce((a, b) => a + b, 0) / kept.length : 0;
  console.log(
    `  delta vs baseline          : ${keptMean - baseMean >= 0 ? '+' : ''}${(keptMean - baseMean).toFixed(3)}R per trade, ` +
      `dropping ${contra.length} of ${paired.length} (${((contra.length / paired.length) * 100).toFixed(0)}%)`,
  );

  console.log('\n── Does confidence sharpen it? (agree-only, by directionConfidence) ──');
  for (const min of [0, 0.3, 0.5, 0.7]) {
    const bucket = paired.filter((p) => p.agree && p.snap.directionConfidence >= min).map((p) => p.row.spotOutcomeR);
    console.log(summarize(`  agree & conf >= ${min}`, bucket));
  }
  console.log('\n── Contradiction strength (veto candidates) ──');
  for (const min of [0, 0.3, 0.5, 0.7]) {
    const bucket = paired.filter((p) => p.contradict && p.snap.directionConfidence >= min).map((p) => p.row.spotOutcomeR);
    console.log(summarize(`  contradict & conf >= ${min}`, bucket));
  }

  console.log('\n── Per-session sanity (is any single day carrying the result?) ──');
  const byDate = new Map<string, { a: number[]; c: number[] }>();
  for (const p of paired) {
    const e = byDate.get(p.row.date) ?? { a: [], c: [] };
    if (p.agree) e.a.push(p.row.spotOutcomeR);
    if (p.contradict) e.c.push(p.row.spotOutcomeR);
    byDate.set(p.row.date, e);
  }
  for (const [d, e] of [...byDate.entries()].sort()) {
    const m = (x: number[]) => (x.length ? (x.reduce((s, v) => s + v, 0) / x.length).toFixed(2) : '  —');
    console.log(`  ${d}  agree n=${String(e.a.length).padStart(2)} meanR=${m(e.a).padStart(6)}   contradict n=${String(e.c.length).padStart(2)} meanR=${m(e.c).padStart(6)}`);
  }

  console.log(`
──────────────────────────────────────────────────────────────────────
CAVEATS — read before acting on any number above.
  * IN-SAMPLE. These are the same sessions the current scanner config was
    tuned on. A separating result here is necessary, not sufficient.
  * SMALL. ${paired.length} pairs across ${byDate.size} sessions. At this size a
    difference smaller than roughly twice the ± band is noise.
  * spotOutcomeR is the SPOT plan's result (stop -1R / target +2R / timeout
    as graded), not option P&L. It answers "was the directional call right",
    which is exactly what the chain claims to predict — but a trade can be
    directionally right and still lose on premium decay.
  * SURVIVORSHIP: only names strong enough to enter the shadow queue
    (MAX_TRACKED=12 by priority) ever get a snapshot, so this measures the
    chain's value ON ALREADY-SHORTLISTED NAMES, not across the universe.
──────────────────────────────────────────────────────────────────────`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
