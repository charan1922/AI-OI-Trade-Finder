/**
 * Named-variant grid over the point-in-time replay benchmark — the human-
 * readable view of scripts/replay-lib.ts. For the autonomous experiment loop
 * (autoresearch-style mutate → evaluate → accept/reject), use
 * scripts/autoresearch.ts.
 *
 * Run:  npx tsx scripts/replay-window.ts [date=2026-07-03]
 */
import { evaluateDay, loadDay, SHIPPED_VARIANT, type Variant } from './replay-lib';

const DATE = process.argv[2] ?? '2026-07-03';

const VARIANTS: Variant[] = [
  SHIPPED_VARIANT,
  { ...SHIPPED_VARIANT, name: 'penalty-only (pre-ban)', banExtended: false },
  { ...SHIPPED_VARIANT, name: 'atr-floor-1.0', atrMult: 1.0 },
  { ...SHIPPED_VARIANT, name: 'atr-floor-1.5', atrMult: 1.5 },
  {
    ...SHIPPED_VARIANT,
    name: 'oi-heavy-weights',
    weights: {
      rFactor: 0.15,
      confidence: 0.05,
      oiUrgency: 0.25,
      oiLevel: 0.2,
      orBreakout: 0.2,
      imbalanceAlign: 0.05,
      sectorBreadth: 0.05,
      setupStrong: 0.05,
    },
  },
  {
    ...SHIPPED_VARIANT,
    name: 'breakout-heavy-weights',
    weights: {
      rFactor: 0.15,
      confidence: 0.05,
      oiUrgency: 0.15,
      oiLevel: 0.1,
      orBreakout: 0.35,
      imbalanceAlign: 0.05,
      sectorBreadth: 0.1,
      setupStrong: 0.05,
    },
  },
  // Candidate feature under evaluation: the price/base-breakout bypass of the OI
  // gate (breakout-bypass.ts, gated OFF in prod by USE_BREAKOUT_BYPASS). Tracks
  // shipped + this path every recorded day. Accept only after several days show
  // ΣR and target/SL both improve vs shipped (2026-07-07, N=1: +3.00 vs +1.00,
  // caught the NAUKRI breakout the OI gate blocked, no junk added).
  {
    ...SHIPPED_VARIANT,
    name: 'breakout-bypass (R>=3.6)',
    breakoutBypass: true,
    breakoutMinRFactor: 3.6,
  },
  // Candidate feature: the pure MOMENTUM-BREAKOUT path (momentum-breakout.ts,
  // gated OFF in prod by USE_MOMENTUM_BREAKOUT). Clears R/confidence/OI/quiet
  // on confirmed OR breakout + BOTH Supertrend & VWAP agreeing + move ≥1.5%.
  // Built for the short-covering class every accumulation factor rejects by
  // design (ADANIGREEN 2026-07-14: R 1.7–2.3, conf 0%, OI 0.97×, NSE ~+1%, TF
  // +₹15,930). Accept only after several recorded days show it catches these
  // without admitting fakeout junk (candle retention added 2026-07-15 makes
  // multi-day benchmarking possible — before that only today was replayable).
  { ...SHIPPED_VARIANT, name: 'momentum-breakout', momentumBreakout: true },
  {
    ...SHIPPED_VARIANT,
    name: 'momentum-breakout 2%',
    momentumBreakout: true,
    momentumMinChangePct: 2,
  },
  // Candidate feature: require the options-led OI path (NSE combined ≥5%) to be
  // ACTIVELY building — combined-OI slope over the trailing ~30 min (from the
  // per-5-min nseOiPct series) — instead of accepting a stale morning print.
  // Live carries the slope as display evidence only until this earns its place.
  { ...SHIPPED_VARIANT, name: 'oi-slope>=0', minNseOiSlope: 0 },
  { ...SHIPPED_VARIANT, name: 'oi-slope>=1', minNseOiSlope: 1 },
  // Candidate feature: drop candidates fighting their sector's turnover-weighted
  // move (the heatmap aggregation; flat sectors pass). Display-only in prod.
  { ...SHIPPED_VARIANT, name: 'sector-align-gate', requireSectorAlign: true },
  // Candidate feature under evaluation: the trend-aligned bypass of the extended
  // ban (extended-bypass.ts, gated OFF in prod by USE_EXTENDED_TREND_BYPASS).
  // Re-admits a genuine trend-day continuation (breakout + VWAP + Supertrend) that
  // EXCLUDE_EXTENDED throws away — e.g. KALYANKJIL 2026-07-09 (+4.5%→+17.5%).
  // Accept only after several days show ΣR improves vs shipped WITHOUT re-admitting
  // the 0-for-5 chase losers (2026-07-03 must stay flat/better).
  {
    ...SHIPPED_VARIANT,
    name: 'extended-trend-bypass',
    extendedTrendBypass: true,
  },
];

const day = loadDay(DATE);
if (!day) {
  console.error(`No recorded intraday data for ${DATE} (oi_intraday is empty for that date).`);
  process.exit(1);
}
console.log(
  `Replay ${DATE} · universe ${day.symbols.length} tracked names · ticks ${day.ticks.length} (09:40–11:00 IST, 5-min)`
);
console.log(
  `Coverage: candidate ranks ${day.coverage.rankSnapshots ? 'point-in-time' : 'MISSING (falls back to recorded end-of-day universe)'}; scan mode ${day.coverage.scanModeRecorded ? 'point-in-time' : 'MISSING (assumes movers-only when ranks exist)'}; options-led fields ${day.coverage.optionsLedFields ? 'point-in-time' : 'MISSING (options-led OI path cannot qualify)'}.`
);
console.log(
  'Daily trade cap: 2. Remaining fidelity gap: option-contract premiums are not recorded, so affordability cannot be replayed. Days with missing coverage are exploratory, not production-fidelity evidence.\n'
);

for (const v of VARIANTS) {
  const r = evaluateDay(day, v);
  console.log(
    `── ${v.name.padEnd(24)} picks ${String(r.picks.length).padStart(2)} · target ${r.targets} / SL ${r.stops} / open ${r.picks.length - r.targets - r.stops} · ΣR ${r.totalR >= 0 ? '+' : ''}${r.totalR.toFixed(2)} · ≥1% fav ${r.hits1pct}/${r.picks.length}`
  );
  for (const { p, o } of r.picks) {
    console.log(
      `     ${p.asOfIST} ${p.symbol.padEnd(12)} ${p.side} @${String(p.entry).padStart(8)} SL ${String(p.sl ?? '—').padStart(8)} (${p.slBasis}) → ${o.hit.toUpperCase().padEnd(6)} R ${o.rMultiple >= 0 ? '+' : ''}${o.rMultiple.toFixed(2)} · fav ${o.maxFavPct.toFixed(2)}% adv ${o.maxAdvPct.toFixed(2)}%${p.extended ? ' · EXT' : ''}${p.orBreakout ? ' · ORB' : ''}`
    );
    // Self-consistent reasons — every number is as-of p.asOfIST, from the tick.
    for (const reason of p.reasons) console.log(`        · ${reason}`);
  }
}
console.log(
  '\nDone. Accept a variant only if ΣR and target/SL both improve — and re-verify on the next recorded day before trusting it.'
);
