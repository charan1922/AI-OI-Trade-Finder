/**
 * Quant SHADOW report — reads the entry/exit measurement columns that the
 * auto-trader and position guard now record on every real trade, and prints
 * them so the anti-chase / R-target / sector-strength thresholds can be
 * calibrated on recorded days BEFORE any of them becomes a live gate.
 *
 * Nothing here changes trading — it is a read-only view of already-recorded
 * SHADOW data (the auto_trades entry/shadow columns + trade_suggestions reasons).
 *
 * Run:  npx tsx scripts/quant-shadow-report.ts [--since YYYY-MM-DD] [--db path]
 * On the box:  docker exec projectr npx tsx scripts/quant-shadow-report.ts
 */
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const argVal = (flag: string): string | null => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const dbPath = argVal('--db') ?? './data/project-r.db';
const since = argVal('--since') ?? '0000-00-00';

// Per-lot cash risk budget (₹) — MAX_LOSS_PER_LOT_RUPEES in
// lib/trade-suggest/config.ts. Used only to express realized P&L as a rough
// "cash R" for the report; keep in step if that constant changes.
const CASH_RISK_PER_LOT = 1500;

const db = new Database(dbPath, { readonly: true });

const cols = new Set((db.prepare(`PRAGMA table_info(auto_trades)`).all() as { name: string }[]).map((c) => c.name));
const has = (c: string) => cols.has(c);
if (!has('entryChangePctOpen')) {
  console.log(
    'No shadow columns yet on auto_trades — the app must boot the new code once (ensureTables adds them). Nothing to report.'
  );
  process.exit(0);
}

interface Row {
  date: string;
  symbol: string;
  direction: string;
  status: string;
  entryChangePctOpen: number | null;
  entryProgressR: number | null;
  entryRemainingRewardR: number | null;
  entrySectorRank: number | null;
  entrySectorCount: number | null;
  entryForwardRR: number | null;
  shadowMfeR: number | null;
  shadowMaeR: number | null;
  realizedPnlRupees: number | null;
  exitReason: string | null;
}

const rows = db
  .prepare(
    `SELECT date, symbol, direction, status,
            entryChangePctOpen, entryProgressR, entryRemainingRewardR,
            entrySectorRank, entrySectorCount, entryForwardRR, shadowMfeR, shadowMaeR,
            realizedPnlRupees, exitReason
       FROM auto_trades
      WHERE date >= ? AND status IN ('open','closed')
      ORDER BY date, id`
  )
  .all(since) as Row[];

if (rows.length === 0) {
  console.log(`No open/closed auto-trades on or after ${since}.`);
  process.exit(0);
}

const f = (n: number | null, d = 2) => (n == null ? '—' : n.toFixed(d));
const realizedR = (r: Row) => (r.realizedPnlRupees == null ? null : r.realizedPnlRupees / CASH_RISK_PER_LOT);

console.log(`\n=== Quant SHADOW report — ${rows.length} trade(s) since ${since} (db: ${dbPath}) ===\n`);
console.log(
  ['date', 'symbol', 'dir', 'chgOpen%', 'progR', 'remRewR', 'fwdRR', 'sector#', 'mfeR', 'maeR', '₹pnl', 'realR', 'giveback?']
    .map((h) => h.padEnd(10))
    .join('')
);
for (const r of rows) {
  const rr = realizedR(r);
  // "Giveback": reached a real favorable R but still closed at a loss — the
  // exact pattern the R-based profit-protection shadow is measuring.
  const giveback = r.shadowMfeR != null && r.shadowMfeR >= 0.75 && (r.realizedPnlRupees ?? 0) < 0 ? 'YES' : '';
  console.log(
    [
      r.date,
      r.symbol,
      r.direction === 'bullish' ? 'CE' : 'PE',
      f(r.entryChangePctOpen, 1),
      f(r.entryProgressR),
      f(r.entryRemainingRewardR),
      f(r.entryForwardRR),
      r.entrySectorRank == null ? '—' : `${r.entrySectorRank}/${r.entrySectorCount ?? '—'}`,
      f(r.shadowMfeR),
      f(r.shadowMaeR),
      r.realizedPnlRupees == null ? '—' : String(Math.round(r.realizedPnlRupees)),
      f(rr),
      giveback,
    ]
      .map((c) => String(c).padEnd(10))
      .join('')
  );
}

// ── Simple aggregates (sparse until enough trades accrue — read as direction,
//    not proof). ────────────────────────────────────────────────────────────
const closed = rows.filter((r) => r.status === 'closed' && r.realizedPnlRupees != null);
const summarize = (label: string, subset: Row[]) => {
  if (subset.length === 0) return;
  const wins = subset.filter((r) => (r.realizedPnlRupees ?? 0) > 0).length;
  const avgR = subset.reduce((s, r) => s + (realizedR(r) ?? 0), 0) / subset.length;
  console.log(`  ${label.padEnd(34)} n=${subset.length}  win ${wins}/${subset.length}  avg realR ${avgR.toFixed(2)}`);
};

console.log(`\n— Late-chase buckets (by % from open at entry) —`);
summarize('|chgOpen| < 1.5%', closed.filter((r) => Math.abs(r.entryChangePctOpen ?? 0) < 1.5));
summarize('|chgOpen| 1.5–3%', closed.filter((r) => Math.abs(r.entryChangePctOpen ?? 0) >= 1.5 && Math.abs(r.entryChangePctOpen ?? 0) < 3));
summarize('|chgOpen| ≥ 3% (extended)', closed.filter((r) => Math.abs(r.entryChangePctOpen ?? 0) >= 3));

console.log(`\n— Sector-strength buckets (rank at entry) —`);
summarize('sector rank ≤ 3', closed.filter((r) => r.entrySectorRank != null && r.entrySectorRank <= 3));
summarize('sector rank 4–5', closed.filter((r) => r.entrySectorRank != null && r.entrySectorRank >= 4 && r.entrySectorRank <= 5));
summarize('sector rank > 5 (weak)', closed.filter((r) => r.entrySectorRank != null && r.entrySectorRank > 5));

console.log(`\n— Giveback (MFE ≥ 0.75R but closed red) —`);
const gaveBack = closed.filter((r) => r.shadowMfeR != null && r.shadowMfeR >= 0.75 && (r.realizedPnlRupees ?? 0) < 0);
console.log(`  ${gaveBack.length} of ${closed.length} closed trades reached ≥0.75R and still lost`);
for (const r of gaveBack) console.log(`    ${r.date} ${r.symbol}: mfe ${f(r.shadowMfeR)}R → ₹${Math.round(r.realizedPnlRupees ?? 0)}`);

console.log('');
