import Database from 'better-sqlite3';
import { gradeSpotPath } from '../lib/trade-suggest/grade';

const db = new Database('./data/project-r.db', { readonly: true });
const days = ['2026-07-15', '2026-07-16', '2026-07-17', '2026-07-20'];

interface Row { symbol: string; optionType: 'CE' | 'PE'; spotAtSuggest: number; slSpot: number; targetSpot: number; suggestedAt: string; score: number; rank: number; sector: string; rFactor: number; oiUrgency: number | null; reasons: string; }
interface Rec { sym: string; out: string; r: number | null; chgOpen: number | null; score: number; rank: number; sector: string; maxFavR: number | null; flags: string[] }

const recs: Rec[] = [];
for (const date of days) {
  const expectedLast = Math.floor(Date.parse(`${date}T15:25:00+05:30`) / 1000);
  const rows = db.prepare(`SELECT symbol,optionType,spotAtSuggest,slSpot,targetSpot,suggestedAt,score,rank,sector,rFactor,oiUrgency,reasons FROM trade_suggestions WHERE date=? AND slSpot IS NOT NULL AND targetSpot IS NOT NULL`).all(date) as Row[];
  for (const s of rows) {
    const sinceSec = Math.floor(Date.parse(s.suggestedAt) / 1000);
    const bars = db.prepare(`SELECT bucketTs,open,high,low,close FROM fyers_candles WHERE symbol=? AND instrument='EQ' AND date=? AND high>0 ORDER BY bucketTs`).all(s.symbol, date) as { bucketTs: number; open: number; high: number; low: number; close: number }[];
    const g = gradeSpotPath(s.optionType, s.spotAtSuggest, s.slSpot, s.targetSpot, bars, sinceSec, expectedLast);
    if (!g || !['target', 'stop', 'timeout'].includes(g.outcome)) continue; // resolved only
    const dayOpen = bars.find((b) => b.open > 0)?.open ?? null;
    const chgOpen = dayOpen ? Math.round(((s.spotAtSuggest - dayOpen) / dayOpen) * 1000) / 10 : null;
    // Max FAVORABLE R reached after entry (before the day ended) — did it ever work?
    const risk = Math.abs(s.spotAtSuggest - s.slSpot);
    const dir = s.optionType === 'CE' ? 1 : -1;
    const entryBucket = Math.floor(sinceSec / 300) * 300;
    const post = bars.filter((b) => b.bucketTs > entryBucket);
    let maxFavR: number | null = null;
    if (post.length && risk > 0) {
      const favSpot = s.optionType === 'CE' ? Math.max(...post.map((b) => b.high)) : Math.min(...post.map((b) => b.low));
      maxFavR = Math.round((dir * (favSpot - s.spotAtSuggest) / risk) * 100) / 100;
    }
    const reasons = JSON.parse(s.reasons || '[]') as string[];
    const flags: string[] = [];
    const rj = reasons.join(' ');
    if (rj.includes('⚡')) flags.push('momentum-breakout');
    if (rj.includes('🪜')) flags.push('rank-climb');
    if (/extended/i.test(rj)) flags.push('extended');
    if (/breakout/i.test(rj) && !flags.includes('momentum-breakout')) flags.push('breakout');
    recs.push({ sym: s.symbol, out: g.outcome, r: g.outcomeR, chgOpen, score: s.score, rank: s.rank, sector: s.sector, maxFavR, flags });
  }
}
db.close();

const n = recs.length;
const wins = recs.filter((r) => r.out === 'target');
const losses = recs.filter((r) => r.out !== 'target');
const avg = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x != null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null; };

console.log(`\n=== WHY the entries lose — ${n} honestly-graded trades (${wins.length} win / ${losses.length} not) ===\n`);

console.log('— Winners vs losers (averages) —');
console.log(`  chg-from-open @entry:  win ${avg(wins.map(r => r.chgOpen))}%   loss ${avg(losses.map(r => r.chgOpen))}%`);
console.log(`  score:                 win ${avg(wins.map(r => r.score))}     loss ${avg(losses.map(r => r.score))}`);
console.log(`  rank:                  win ${avg(wins.map(r => r.rank))}      loss ${avg(losses.map(r => r.rank))}`);
console.log(`  max favorable R:       win ${avg(wins.map(r => r.maxFavR))}R   loss ${avg(losses.map(r => r.maxFavR))}R`);

console.log('\n— Entry vs exit problem (did losers ever work?) —');
const neverWorked = losses.filter((r) => (r.maxFavR ?? 0) < 0.5).length;
const gaveBack = losses.filter((r) => (r.maxFavR ?? 0) >= 1).length;
console.log(`  losers that NEVER reached +0.5R (entry problem):   ${neverWorked}/${losses.length}`);
console.log(`  losers that reached ≥+1R then lost (exit problem): ${gaveBack}/${losses.length}`);

console.log('\n— Win rate by chg-from-open bucket —');
for (const [lbl, f] of [['calm <1.5%', (r: Rec) => Math.abs(r.chgOpen ?? 0) < 1.5], ['1.5–3%', (r: Rec) => Math.abs(r.chgOpen ?? 0) >= 1.5 && Math.abs(r.chgOpen ?? 0) < 3], ['extended ≥3%', (r: Rec) => Math.abs(r.chgOpen ?? 0) >= 3]] as const) {
  const sub = recs.filter(f); const w = sub.filter((r) => r.out === 'target').length;
  console.log(`  ${String(lbl).padEnd(14)} n=${sub.length}  wins ${w}  = ${sub.length ? Math.round(w / sub.length * 100) : 0}%`);
}

console.log('\n— Win rate by score bucket —');
for (const [lbl, f] of [['score ≥0.55', (r: Rec) => r.score >= 0.55], ['0.45–0.55', (r: Rec) => r.score >= 0.45 && r.score < 0.55], ['<0.45', (r: Rec) => r.score < 0.45]] as const) {
  const sub = recs.filter(f); const w = sub.filter((r) => r.out === 'target').length;
  console.log(`  ${String(lbl).padEnd(12)} n=${sub.length}  wins ${w}  = ${sub.length ? Math.round(w / sub.length * 100) : 0}%`);
}

console.log('\n— Admission flags among LOSERS —');
const flagCount: Record<string, number> = {};
for (const r of losses) for (const f of r.flags) flagCount[f] = (flagCount[f] ?? 0) + 1;
console.log(' ', JSON.stringify(flagCount), `(of ${losses.length} losers; no-flag = clean OI path)`);
const noFlagLoss = losses.filter((r) => r.flags.length === 0).length;
console.log(`  losers with NO special flag (plain accumulation path): ${noFlagLoss}/${losses.length}`);

console.log('\n— The 3 winners —');
for (const r of wins) console.log(`  ${r.sym} score ${r.score} rank ${r.rank} chgOpen ${r.chgOpen}% maxFav ${r.maxFavR}R sector ${r.sector}`);
