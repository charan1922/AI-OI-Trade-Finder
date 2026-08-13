/**
 * Named-variant grid over the point-in-time replay benchmark — the human-
 * readable view of scripts/replay-lib.ts. For the autonomous experiment loop
 * (autoresearch-style mutate → evaluate → accept/reject), use
 * scripts/autoresearch.ts.
 *
 * Run:  npx tsx scripts/replay-window.ts [date=2026-07-03]
 */
import { describeVariantDrift, evaluateDay, loadDay, loadLiveVariant, type Variant } from './replay-lib';

const DATE = process.argv[2] ?? '2026-07-03';

/** Every variant is a delta on BASE — the LIVE baseline (feature_toggles), not
 *  the file defaults. Comparing against stock config graded a system nobody
 *  trades: on 23/24/27 Jul that baseline produced 0 picks vs 38/42/9 live. */
const buildVariants = (BASE: Variant): Variant[] => [
  BASE,
  { ...BASE, name: 'penalty-only (pre-ban)', banExtended: false },
  { ...BASE, name: 'atr-floor-1.0', atrMult: 1.0 },
  { ...BASE, name: 'atr-floor-1.5', atrMult: 1.5 },
  {
    ...BASE,
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
    ...BASE,
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
  // gate (breakout-bypass.ts, retired from production). Tracks
  // shipped + this path every recorded day. Accept only after several days show
  // ΣR and target/SL both improve vs shipped (2026-07-07, N=1: +3.00 vs +1.00,
  // caught the NAUKRI breakout the OI gate blocked, no junk added).
  {
    ...BASE,
    name: 'breakout-bypass (R>=base gate)',
    breakoutBypass: true,
    breakoutMinRFactor: 3.6,
  },
  // Candidate feature: the pure MOMENTUM-BREAKOUT path (momentum-breakout.ts,
  // retired from production). Clears R/confidence/OI/quiet
  // on confirmed OR breakout + BOTH Supertrend & VWAP agreeing + move ≥1.5%.
  // Built for the short-covering class every accumulation factor rejects by
  // design (ADANIGREEN 2026-07-14: R 1.7–2.3, conf 0%, OI 0.97×, NSE ~+1%, TF
  // +₹15,930). Accept only after several recorded days show it catches these
  // without admitting fakeout junk (candle retention added 2026-07-15 makes
  // multi-day benchmarking possible — before that only today was replayable).
  { ...BASE, name: 'momentum-breakout', momentumBreakout: true },
  {
    ...BASE,
    name: 'momentum-breakout 2%',
    momentumBreakout: true,
    momentumMinChangePct: 2,
  },
  // ADANIENSOL/ADANIGREEN class (price-led, OI flat — short-covering). Two
  // candidate catches added 2026-07-17 after ADANIENSOL 16-Jul (TF +₹10.1k) was
  // missed. Both are EVIDENCE-ONLY here; accept only after several recorded days.
  // (a) momentum-EARLY: the built momentum path fires only on Supertrend
  //     confirmation, which for ADANIENSOL was ~10:45 near the top. A 1% move
  //     floor triggers earlier (TF entered ~10:00, +1.1% from open) — but a
  //     lower floor also admits more fakeouts, which is exactly what the grid
  //     must weigh over days.
  {
    ...BASE,
    name: 'momentum-breakout 1%',
    momentumBreakout: true,
    momentumMinChangePct: 1,
  },
  // (b) options-premium-led: ADANIENSOL failed ONLY the NSE-combined-OI% leg
  //     (1–2% vs 5% needed) while its options legs passed (optShare 10–19%,
  //     premium ₹6→99Cr). Dropping the NSE% floor to ~1 lets the options-led
  //     path qualify on options flow alone. CAUTION: a one-day check (16-Jul)
  //     showed this floods ~16 fires at 50% precision — worth tracking across
  //     days, NOT flipping on.
  { ...BASE, name: 'options-led-relaxed (nse>=1)', minNseOiPct: 1 },
  // (c) historical rank-climb CATCH path — retired from production. These variants force it
  //     ON to accrue the A/B: NSE ≥5% unchanged, plus 1–5% builds with
  //     qualifying options legs admit IF climbing the gainers/OI leaderboard ≥N
  //     spots/~30 min (winners climbing 5/8 vs losers 1/7 on 16-Jul; ADANIENSOL
  //     gainers #15→#7). ≥5 is the stricter cut in case ≥1 admits junk over days.
  { ...BASE, name: 'rank-climb catch >=1', rankClimbCatch: true, rankClimbMinSpots: 1 },
  { ...BASE, name: 'rank-climb catch >=5', rankClimbCatch: true, rankClimbMinSpots: 5 },
  //     Refinements from the first live loser on this path (AXISBANK 17-Jul,
  //     −₹1,344: admitted at NSE +2.1% on an OI-board drift 41→35 while
  //     SLIPPING on gainers 18→19; the 16-Jul winner ADANIENSOL led with PRICE,
  //     gainers #15→#7). gainers-only = the climb must be on the price board;
  //     arrive<=15 = the climb must END near the top, not mid-pack. Both keep
  //     ADANIENSOL and reject AXISBANK — but that's fitted to N=2, which is
  //     exactly why they sit in the grid instead of the engine.
  {
    ...BASE,
    name: 'rank-climb gainers-only',
    rankClimbCatch: true,
    rankClimbGainersOnly: true,
  },
  {
    ...BASE,
    name: 'rank-climb arrive<=15',
    rankClimbCatch: true,
    rankClimbMaxRank: 15,
  },
  {
    ...BASE,
    name: 'rank-climb gainers<=15',
    rankClimbCatch: true,
    rankClimbGainersOnly: true,
    rankClimbMaxRank: 15,
  },
  // Candidate feature: require the options-led OI path (NSE combined ≥5%) to be
  // ACTIVELY building — combined-OI slope over the trailing ~30 min (from the
  // per-5-min nseOiPct series) — instead of accepting a stale morning print.
  // Live carries the slope as display evidence only until this earns its place.
  { ...BASE, name: 'oi-slope>=0', minNseOiSlope: 0 },
  { ...BASE, name: 'oi-slope>=1', minNseOiSlope: 1 },
  // Candidate feature: drop candidates fighting their sector's turnover-weighted
  // move (the heatmap aggregation; flat sectors pass). Display-only in prod.
  { ...BASE, name: 'sector-align-gate', requireSectorAlign: true },
  // Candidate feature under evaluation: the trend-aligned bypass of the extended
  // ban (extended-bypass.ts, gated OFF in prod by USE_EXTENDED_TREND_BYPASS).
  // Re-admits a genuine trend-day continuation (breakout + VWAP + Supertrend) that
  // EXCLUDE_EXTENDED throws away — e.g. KALYANKJIL 2026-07-09 (+4.5%→+17.5%).
  // Accept only after several days show ΣR improves vs shipped WITHOUT re-admitting
  // the 0-for-5 chase losers (2026-07-03 must stay flat/better).
  {
    ...BASE,
    name: 'extended-trend-bypass',
    extendedTrendBypass: true,
  },
];

const day = loadDay(DATE);
if (!day) {
  console.error(`No recorded intraday data for ${DATE} (oi_intraday is empty for that date).`);
  process.exit(1);
}
const BASE = await loadLiveVariant();
const VARIANTS = buildVariants(BASE);
const drift = describeVariantDrift(BASE);
console.log(
  drift.length === 0
    ? 'Baseline: live feature_toggles — identical to the config.ts defaults.'
    : `Baseline: live feature_toggles, which DIFFER from config.ts defaults:\n  ${drift.join('\n  ')}`
);
console.log(
  `Replay ${DATE} · universe ${day.symbols.length} tracked names · ticks ${day.ticks.length} (09:40–11:00 IST, 5-min)`
);
console.log(
  `Coverage: candidate ranks ${day.coverage.rankSnapshots ? 'point-in-time' : 'MISSING (falls back to recorded end-of-day universe)'}; scan mode ${day.coverage.scanModeRecorded ? 'point-in-time' : 'MISSING (assumes movers-only when ranks exist)'}; options-led fields ${day.coverage.optionsLedFields ? 'point-in-time' : 'MISSING (options-led OI path cannot qualify)'}.`
);
console.log(
  'Daily trade cap: 2 (the "picks" line). The "all fires" line drops the cap and scores EVERY first-seen qualified fire — the evidence read for comparing admission quality (the cap often fills by 09:40, hiding late fires from every variant). Remaining fidelity gap: option-contract premiums are not recorded, so affordability cannot be replayed. Days with missing coverage are exploratory, not production-fidelity evidence.\n'
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
  const all = evaluateDay(day, v, { allFires: true });
  console.log(
    `   all fires ${String(all.picks.length).padStart(2)} · target ${all.targets} / SL ${all.stops} / open ${all.picks.length - all.targets - all.stops} · ΣR ${all.totalR >= 0 ? '+' : ''}${all.totalR.toFixed(2)} · ≥1% fav ${all.hits1pct}/${all.picks.length}`
  );
  const capped = new Set(r.picks.map(({ p }) => `${p.symbol}:${p.side}`));
  for (const { p, o } of all.picks) {
    if (capped.has(`${p.symbol}:${p.side}`)) continue;
    console.log(
      `     + ${p.asOfIST} ${p.symbol.padEnd(12)} ${p.side} @${String(p.entry).padStart(8)} SL ${String(p.sl ?? '—').padStart(8)} (${p.slBasis}) → ${o.hit.toUpperCase().padEnd(6)} R ${o.rMultiple >= 0 ? '+' : ''}${o.rMultiple.toFixed(2)} · fav ${o.maxFavPct.toFixed(2)}% adv ${o.maxAdvPct.toFixed(2)}%${p.extended ? ' · EXT' : ''}${p.orBreakout ? ' · ORB' : ''}`
    );
  }
}
console.log(
  '\nDone. Accept a variant only if ΣR and target/SL both improve — and re-verify on the next recorded day before trusting it.'
);
