/**
 * Named-variant grid over the point-in-time replay benchmark — the human-
 * readable view of scripts/replay-lib.ts. For the autonomous experiment loop
 * (autoresearch-style mutate → evaluate → accept/reject), use
 * scripts/autoresearch.ts.
 *
 * Run:  npx tsx scripts/replay-window.ts [date=2026-07-03]
 */
import {
  evaluateDay,
  loadDay,
  SHIPPED_VARIANT,
  type Variant,
} from './replay-lib';

const DATE = process.argv[2] ?? '2026-07-03';

const VARIANTS: Variant[] = [
  SHIPPED_VARIANT,
  { ...SHIPPED_VARIANT, name: 'penalty-only (pre-ban)', banExtended: false },
  { ...SHIPPED_VARIANT, name: 'atr-floor-1.0', atrMult: 1.0 },
  { ...SHIPPED_VARIANT, name: 'atr-floor-1.5', atrMult: 1.5 },
  {
    ...SHIPPED_VARIANT,
    name: 'oi-heavy-weights',
    weights: { rFactor: 0.15, confidence: 0.05, oiUrgency: 0.25, oiLevel: 0.2, orBreakout: 0.2, imbalanceAlign: 0.05, sectorBreadth: 0.05, setupStrong: 0.05 },
  },
  {
    ...SHIPPED_VARIANT,
    name: 'breakout-heavy-weights',
    weights: { rFactor: 0.15, confidence: 0.05, oiUrgency: 0.15, oiLevel: 0.1, orBreakout: 0.35, imbalanceAlign: 0.05, sectorBreadth: 0.1, setupStrong: 0.05 },
  },
];

const day = loadDay(DATE);
if (!day) {
  console.error(`No recorded intraday data for ${DATE} (oi_intraday is empty for that date).`);
  process.exit(1);
}
console.log(`Replay ${DATE} · universe ${day.symbols.length} tracked names · ticks ${day.ticks.length} (09:40–11:00 IST, 5-min)`);
console.log(
  'Fidelity gaps vs live: bid/ask not recorded (spread R-factor unavailable), option premiums not recorded (affordability gate skipped).\n',
);

for (const v of VARIANTS) {
  const r = evaluateDay(day, v);
  console.log(
    `── ${v.name.padEnd(24)} picks ${String(r.picks.length).padStart(2)} · target ${r.targets} / SL ${r.stops} / open ${r.picks.length - r.targets - r.stops} · ΣR ${r.totalR >= 0 ? '+' : ''}${r.totalR.toFixed(2)} · ≥1% fav ${r.hits1pct}/${r.picks.length}`,
  );
  for (const { p, o } of r.picks) {
    console.log(
      `     ${p.asOfIST} ${p.symbol.padEnd(12)} ${p.side} @${String(p.entry).padStart(8)} SL ${String(p.sl ?? '—').padStart(8)} (${p.slBasis}) → ${o.hit.toUpperCase().padEnd(6)} R ${o.rMultiple >= 0 ? '+' : ''}${o.rMultiple.toFixed(2)} · fav ${o.maxFavPct.toFixed(2)}% adv ${o.maxAdvPct.toFixed(2)}%${p.extended ? ' · EXT' : ''}${p.orBreakout ? ' · ORB' : ''}`,
    );
    // Self-consistent reasons — every number is as-of p.asOfIST, from the tick.
    for (const reason of p.reasons) console.log(`        · ${reason}`);
  }
}
console.log('\nDone. Accept a variant only if ΣR and target/SL both improve — and re-verify on the next recorded day before trusting it.');
