/**
 * PURE premium-stop + per-lot-risk checks — no DB, no clocks, no network.
 *
 * These cover money-touching logic (how wide the stop is, and whether a lot is
 * allowed to be bought at all), so they must run in CI rather than only on the
 * box. They originally lived inline in scripts/verify-auto-trade.ts, which needs
 * a populated SQLite database and is therefore a laptop/box-only step — meaning
 * the safety assertions were claimed but never confirmed by a pipeline
 * (PR#18 review). Everything exercised here is a pure function, so there is no
 * reason for it to sit outside CI.
 *
 * Wired into scripts/verify-quant-shadow.ts, which the build workflow runs.
 */
import { checkEntryGates } from '../lib/auto-trade/risk/gates';
import {
  backstopsFromProposalFill,
  capitalReservationExceeds,
  effectiveBreachCeiling,
  fillRiskPerLotRupees,
  riskPerLotRupees,
  stopPremiumForFill,
} from '../lib/auto-trade/backstops';
import { DEFAULT_SETTINGS, MAX_RISK_PER_LOT_FALLBACK } from '../lib/auto-trade/config';
import {
  BACKSTOP_MAX_PCT,
  backstopStopPct,
  bsPrice,
  impliedVol,
  istEpochMs,
  spotStopRiskPerLot,
} from '../lib/auto-trade/risk/option-model';
// Leaf module on purpose: importing position-guard would drag prisma, the
// broker adapters and the candle store into this DB-free bench.
import {
  EXIT_ALERT_EVERY,
  EXIT_FAILURE_ESCALATE,
  EXIT_RETRY_BACKOFF_MS,
  exitRetryWaitMs,
  shouldAlertOnExitFailure,
} from '../lib/auto-trade/risk/exit-backoff';
import type { EntryGateInput } from '../lib/auto-trade/risk/gates';

export type CheckFn = (name: string, ok: boolean, detail?: string) => void;

/** A gate input that PASSES, so each test below isolates one failure cause.
 *  SRF-like: ₹44.05 ask on a 200 lot, ATM 2900 CE, spot 2900, chart stop 2880
 *  (models ≈ ₹2,135/lot at the stop — under the ₹2,500 coded ceiling). */
function passingGate(over: Partial<EntryGateInput> = {}): EntryGateInput {
  return {
    settings: { ...DEFAULT_SETTINGS, mode: 'paper' as const },
    tradeDate: '2099-01-01',
    expiryDate: '2099-01-28',
    liveEnvEnabled: false,
    marketOpen: true,
    sessionVerified: true,
    riskLatchReasons: [],
    minuteIST: 10 * 60,
    entriesToday: 0,
    openLots: 0,
    deployedRupees: 0,
    dailyRealizedPnl: 0,
    symbolTradedToday: false,
    lots: 1,
    perLotCost: 8_810,
    lotSize: 200,
    askPrice: 44.05,
    askQty: 200,
    spot: 2900,
    slSpot: 2880,
    strike: 2900,
    optionType: 'CE',
    nowMs: istEpochMs('2099-01-01', 10 * 60),
    slippagePct: 1,
    spreadPct: 2,
    hasSlSpot: true,
    brokerFundsAvailable: null,
    blockStaleAutoEntry: true,
    candleLatestBucketTs: 1_000_000_000,
    candleRequiredBucketTs: 1_000_000_000,
    candleFresh: true,
    ...over,
  };
}

const refused = (i: EntryGateInput) => !checkEntryGates(i).allow;
const because = (i: EntryGateInput, needle: string) =>
  checkEntryGates(i).reasons.some((r) => r.toLowerCase().includes(needle.toLowerCase()));

export function runPremiumStopChecks(check: CheckFn): void {
  // ── 1. Stop width: a flat % of the OPTION, independent of lot size ─────────
  check(
    'stop: 25% of the option price (SRF 23-Jul fill ₹44.05 → ₹33.04)',
    stopPremiumForFill(44.05) === 33.04,
    String(stopPremiumForFill(44.05))
  );
  check(
    'stop: SRF survives — its lowest recorded bid ₹36.10 sits above ₹33.04 (old ₹36.55 stop broke)',
    36.1 > stopPremiumForFill(44.05)
  );
  const widthPct = (fill: number) => (1 - stopPremiumForFill(fill) / fill) * 100;
  check(
    'stop: two very different contracts land on the same width (was 7.7% vs 9.4%)',
    Math.abs(widthPct(27.75) - widthPct(127)) < 0.05,
    `INDUSINDBK ₹27.75 → ${widthPct(27.75).toFixed(3)}% · POLYCAB ₹127 → ${widthPct(127).toFixed(3)}%`
  );
  check('stop: a custom width is honoured', stopPremiumForFill(100, 10) === 90);
  check(
    'stop: a nonsense width falls back to the coded default, never NaN',
    stopPremiumForFill(100, Number.NaN) === stopPremiumForFill(100)
  );
  check('stop: never reaches zero', stopPremiumForFill(0.05) >= 0.05);
  check('risk: per-lot rupees = (fill − stop) × lotSize', riskPerLotRupees(44.05, 200) === 2202);

  // ── 2. Proposal snapshot: an approved level cannot be moved by a setting ───
  check(
    'risk: the proposal re-anchor snapshots the STOP width, not just the cash target',
    backstopsFromProposalFill(128, 125, 1, 127, 135.8, 95.25).slPremium === 96,
    String(backstopsFromProposalFill(128, 125, 1, 127, 135.8, 95.25).slPremium)
  );
  check(
    'risk: a proposal written at a 10% width keeps 10% at fill, not today’s 25%',
    backstopsFromProposalFill(128, 125, 1, 127, 135.8, 114.3).slPremium === 115.2,
    String(backstopsFromProposalFill(128, 125, 1, 127, 135.8, 114.3).slPremium)
  );

  // ── 3. Per-lot risk ceiling — measured at the CHART stop (2026-10-09) ────
  // The trade is stopped by its spot plan, so the budget is measured there: the
  // option priced with the stock AT the stop (Black-Scholes, IV from the ask).
  const base = checkEntryGates(passingGate());
  check(
    'gates: a lot risking ≈₹2,135 at its chart stop passes the ₹2,500 ceiling',
    base.allow,
    base.reasons.join('; ')
  );
  check(
    'gates: an ALLOW carries the chart-stop risk the caller sizes the backstop from',
    base.chartStopRisk != null && base.chartStopRisk.riskPerLot > 2000 && base.chartStopRisk.riskPerLot < 2500,
    JSON.stringify(base.chartStopRisk)
  );
  const fartherStop = passingGate({ slSpot: 2871 });
  check('gates: the same lot with a FARTHER chart stop (2871) is refused', refused(fartherStop));
  check('gates: the refusal says the stop is NOT tightened to fit', because(fartherStop, 'not tightened'));
  check('gates: the refusal names the chart stop it measured at', because(fartherStop, '2871 chart stop'));
  // Boundary: ceiling set to exactly the modelled risk → allowed; ₹1 under → refused.
  const exact = base.chartStopRisk?.riskPerLot ?? Number.NaN;
  const withCeiling = (c: number) =>
    passingGate({ settings: { ...DEFAULT_SETTINGS, mode: 'paper' as const, maxRiskPerLotRupees: c } });
  check(
    'gates: exactly AT the ceiling is allowed (the check is >, not >=)',
    checkEntryGates(withCeiling(exact)).allow,
    `₹${exact}`
  );
  check('gates: ₹1 under the modelled risk is refused', refused(withCeiling(exact - 1)));

  // The motivating case, REAL numbers (trade_suggestions 2026-10-08 11:10 IST):
  // ADANIENT 2650 PE, ₹85.8, lot 309, spot 2638.3, prod ceiling ₹5,000. The plan's
  // stop was the opening-range HIGH 2743 (4% away) because price sat above the
  // last candle's high. The old 20%-premium rule called it ₹5,302 — it really
  // risked ≈₹12.8k. With a 1%-floored stop (2664.68) it risks ≈₹3.9k.
  const adani = (slSpot: number) =>
    passingGate({
      settings: { ...DEFAULT_SETTINGS, mode: 'paper' as const, maxRiskPerLotRupees: 5000, optionStopPct: 20 },
      tradeDate: '2026-10-08',
      expiryDate: '2026-10-27',
      nowMs: Date.parse('2026-10-08T05:40:18Z'),
      optionType: 'PE',
      strike: 2650,
      spot: 2638.3,
      slSpot,
      askPrice: 85.8,
      askQty: 309,
      lotSize: 309,
      perLotCost: 26_512,
    });
  const adaniFar = checkEntryGates(adani(2743)).chartStopRisk?.riskPerLot ?? 0;
  check(
    'ADANIENT 08-Oct: the real 4%-away stop (2743) risks > ₹12k and is REFUSED',
    refused(adani(2743)) && adaniFar > 12_000,
    `₹${adaniFar}`
  );
  const adaniNear = checkEntryGates(adani(2664.68));
  check(
    'ADANIENT 08-Oct: a 1%-floored stop risks < ₹5,000 and is ALLOWED (old 20% rule: ₹5,302, refused)',
    adaniNear.allow && (adaniNear.chartStopRisk?.riskPerLot ?? 0) < 5000,
    `₹${adaniNear.chartStopRisk?.riskPerLot} · ${adaniNear.reasons.join('; ')}`
  );

  // ── 4. FAIL CLOSED — "cannot calculate risk" must never mean "allow" ───────
  // This is the class of bug PR#18 review found on the human approval path,
  // which passed no lot size at all and so skipped the ceiling on every order.
  check('gates: a missing lot size FAILS the entry (never skipped)', refused(passingGate({ lotSize: null })));
  check('gates: a zero lot size FAILS the entry', refused(passingGate({ lotSize: 0 })));
  check('gates: a NaN lot size FAILS the entry', refused(passingGate({ lotSize: Number.NaN })));
  check(
    'gates: a missing lot size says risk could not be computed',
    because(passingGate({ lotSize: null }), 'per-lot risk cannot be computed')
  );
  check('gates: no live ask FAILS the entry (no executable price to size from)', refused(passingGate({ askPrice: null })));
  check('gates: a zero ask FAILS the entry', refused(passingGate({ askPrice: 0 })));
  check('gates: no live spot FAILS the entry (risk cannot be modelled)', refused(passingGate({ spot: null })));
  check('gates: no chart stop FAILS the entry', refused(passingGate({ slSpot: null })));
  check('gates: no strike FAILS the entry', refused(passingGate({ strike: null })));
  check('gates: no option type FAILS the entry', refused(passingGate({ optionType: null })));
  check(
    'gates: a chart stop already ABOVE spot on a CE (stopped before entry) FAILS',
    because(passingGate({ slSpot: 2905 }), 'not on the losing side')
  );
  check(
    'gates: a contract that expires before the hold ends FAILS',
    because(passingGate({ expiryDate: '2098-12-31' }), 'expires before')
  );
  check('gates: a NaN clock FAILS the entry', refused(passingGate({ nowMs: Number.NaN })));

  // ── 5. Risk is priced off the ASK we pay, at the stop, not off premium size ─
  // At a chart stop the loss is ≈ delta × stop distance × lot. A dearer option
  // (higher IV) on the SAME stop barely moves it — the old % rule refused the
  // dear contract outright. Paying more still costs rupee-for-rupee at the
  // fill-breach check (fill − value at stop).
  const cheap = checkEntryGates(passingGate()).chartStopRisk?.riskPerLot ?? Number.NaN;
  const dear =
    checkEntryGates(passingGate({ askPrice: 55, perLotCost: 11_000 })).chartStopRisk?.riskPerLot ?? Number.NaN;
  check(
    'gates: a dearer ask on the same stop still passes (risk is distance, not premium)',
    dear < 2500,
    `₹${cheap} → ₹${dear}`
  );
  check('gates: a dearer ask never LOWERS the modelled risk', dear >= cheap, `₹${cheap} → ₹${dear}`);
  check('gates: the refusal names the ask it priced from', because(passingGate({ slSpot: 2871 }), '₹44.05 ask'));

  // ── 6. Depth: a lot bigger than the resting offer sweeps the book ──────────
  check(
    'gates: too little size at the ask is refused (the fill would be worse)',
    refused(passingGate({ askQty: 50 })),
    'lot is 200 units, only 50 offered'
  );
  check('gates: unknown ask size is refused, not assumed sufficient', refused(passingGate({ askQty: null })));
  check('gates: exactly enough size at the ask is allowed', checkEntryGates(passingGate({ askQty: 200 })).allow);
  check(
    'gates: two lots need twice the displayed size',
    refused(passingGate({ lots: 2, askQty: 200, askPrice: 20, perLotCost: 4_000 })),
    '2 × 200 units needed, 200 offered'
  );

  // ── 7. stopPctOverride is the BACKSTOP width — validated, never the budget ─
  check(
    'gates: a proposal backstop width does not change the chart-stop risk',
    checkEntryGates(passingGate({ stopPctOverride: 10 })).chartStopRisk?.riskPerLot === cheap
  );
  check(
    'gates: a corrupt override FAILS closed rather than falling back silently',
    refused(passingGate({ stopPctOverride: 150 }))
  );
  check(
    'gates: a corrupt optionStopPct FAILS the entry',
    refused(passingGate({ settings: { ...DEFAULT_SETTINGS, mode: 'paper', optionStopPct: Number.NaN } }))
  );

  // ── 7b. The model itself ───────────────────────────────────────────────────
  // Textbook values (Hull, S=42 K=40 r=10% σ=20% T=0.5): call 4.76, put 0.81.
  check('model: Black-Scholes call matches Hull (4.76)', Math.abs(bsPrice('CE', 42, 40, 0.5, 0.1, 0.2) - 4.76) < 0.005);
  check('model: Black-Scholes put matches Hull (0.81)', Math.abs(bsPrice('PE', 42, 40, 0.5, 0.1, 0.2) - 0.81) < 0.005);
  check(
    'model: implied vol round-trips a known price (σ 31%)',
    Math.abs((impliedVol('CE', bsPrice('CE', 100, 105, 0.1, 0.065, 0.31), 100, 105, 0.1, 0.065) ?? 0) - 0.31) < 1e-4
  );
  check(
    'model: an impossible price (above any σ) has no implied vol',
    impliedVol('CE', 99, 100, 105, 0.1, 0.065) == null
  );
  const riskAt = (evalAtMs: number) =>
    spotStopRiskPerLot({
      optionType: 'PE',
      ask: 85.8,
      spot: 2638.3,
      slSpot: 2664.68,
      strike: 2650,
      expiryDate: '2026-10-27',
      lotSize: 309,
      nowMs: Date.parse('2026-10-08T05:40:18Z'),
      evalAtMs,
    });
  const instant = riskAt(Date.parse('2026-10-08T05:40:18Z'));
  const atSquareOff = riskAt(istEpochMs('2026-10-08', 15 * 60 + 12));
  check(
    'model: counting decay to square-off makes the risk LARGER, never smaller',
    instant.ok && atSquareOff.ok && atSquareOff.riskPerLot > instant.riskPerLot,
    `${instant.ok ? instant.riskPerLot : '-'} → ${atSquareOff.ok ? atSquareOff.riskPerLot : '-'}`
  );

  // ── 7c. Premium BACKSTOP width = max(optionStopPct, 1.5 × modelled drop) ──
  check('backstop: never tighter than the operator setting', backstopStopPct(20, 5) === 20);
  check('backstop: 1.5× the modelled drop when that is wider (14.66% → 21.99%)', backstopStopPct(20, 14.66) === 21.99);
  check('backstop: the modelled term is capped', backstopStopPct(20, 80) === BACKSTOP_MAX_PCT);
  check('backstop: an operator setting above the cap is never narrowed', backstopStopPct(70, 10) === 70);
  check(
    'backstop: a corrupt setting → NaN, which stopPremiumForFill replaces with the default',
    Number.isNaN(backstopStopPct(Number.NaN, 10)) &&
      stopPremiumForFill(100, backstopStopPct(Number.NaN, 10)) === stopPremiumForFill(100)
  );

  // ── 8. Approval drift — re-measured at approval against the LIVE spot ────
  // Proposal under the ceiling; while the human decides the stock runs 6 points
  // further from the same chart stop (option up with it, inside the slippage
  // guard). The stop is now farther away, so the lot risks more — refused.
  const atProposal = passingGate();
  const atApproval = passingGate({ spot: 2906, askPrice: 47.3, perLotCost: 9_460, slippagePct: 2.9 });
  check('approval drift: the proposal was under the ceiling', checkEntryGates(atProposal).allow);
  check(
    'approval drift: the stock running away from the stop breaches it and is REFUSED',
    refused(atApproval),
    `₹${checkEntryGates(atApproval).chartStopRisk?.riskPerLot} > ₹2,500`
  );

  // ── 9. Fill-breach ceiling: the SNAPSHOT wins over the live setting ─────────
  // The re-review found that comparing a fill against the CURRENT setting (not
  // the ceiling that approved the order) raises false breaches or hides real
  // ones when the setting moved between gate and fill. These prove the two pure
  // pieces behind the fix: which ceiling is chosen, and what counts as a breach.
  check(
    'breach: the snapshotted ceiling wins over the current setting',
    effectiveBreachCeiling(2500, 3000, MAX_RISK_PER_LOT_FALLBACK) === 2500,
    String(effectiveBreachCeiling(2500, 3000, MAX_RISK_PER_LOT_FALLBACK))
  );
  check(
    'breach: no snapshot → fall back to the current setting',
    effectiveBreachCeiling(null, 3000, MAX_RISK_PER_LOT_FALLBACK) === 3000
  );
  check(
    'breach: no snapshot and no setting → the coded default',
    effectiveBreachCeiling(null, null, MAX_RISK_PER_LOT_FALLBACK) === MAX_RISK_PER_LOT_FALLBACK
  );
  check(
    'breach: a non-finite snapshot is skipped, not trusted',
    effectiveBreachCeiling(Number.NaN, 3000, MAX_RISK_PER_LOT_FALLBACK) === 3000
  );
  // One fill risking ₹2,800/lot (₹56 fill, 25% stop ₹42, 200 lot) against the two
  // approval-time snapshots the reviewer described.
  const breachFill = 56;
  const breachStop = stopPremiumForFill(breachFill, 25); // ₹42
  const breachRisk = fillRiskPerLotRupees(breachFill, breachStop, 200); // ₹2,800
  check('breach: fill risk = (fill − stop) × lot', breachRisk === 2800, `₹${breachRisk}`);
  check(
    'breach: ceiling RAISED to ₹3,000 before fill → ₹2,800 fill does NOT latch (no false breach)',
    breachRisk <= effectiveBreachCeiling(3000, 3000, MAX_RISK_PER_LOT_FALLBACK)
  );
  check(
    'breach: ceiling LEFT at ₹2,500 → ₹2,800 fill IS a breach (latch fires)',
    breachRisk > effectiveBreachCeiling(2500, 2500, MAX_RISK_PER_LOT_FALLBACK)
  );
  // Since 2026-10-09 the breach is measured at the CHART stop: fill − the option
  // value modelled there. A fill ₹2 over the ask adds ₹2 × lot, rupee-for-rupee.
  check(
    'breach: at the chart stop, paying ₹2 over the ask adds exactly ₹2 × lot',
    fillRiskPerLotRupees(46.05, 33.38, 200) - fillRiskPerLotRupees(44.05, 33.38, 200) === 400
  );

  // ── 10. Aggregate capital cap — the decision behind the atomic reservation ─
  // The store enforces this INSIDE the INSERT/UPDATE so concurrent approvals
  // cannot jointly breach the cap; this covers the pure arithmetic + boundary.
  check('capital: exactly AT the cap is allowed (₹59,600 ≤ ₹60,000)', capitalReservationExceeds(50_000, 9_600, 60_000) === false);
  check('capital: exactly ON the cap is allowed (₹60,000 is not > ₹60,000)', capitalReservationExceeds(29_000, 31_000, 60_000) === false);
  check('capital: ₹1 over the cap is refused', capitalReservationExceeds(29_001, 31_000, 60_000) === true);
  // The reviewer's race, both halves. Two ₹31k fresh asks, ₹25k already reserved
  // by the other pending proposal. Checked against LIVE reserved state (what the
  // atomic SQL sees), the second approval is correctly refused…
  check(
    'capital: once one ₹31k approval is placing, the second (₹31k+₹31k) is refused',
    capitalReservationExceeds(31_000, 31_000, 60_000) === true
  );
  // …whereas the OLD read-then-write path compared against the STALE ₹25k
  // reservation and wrongly allowed it — the exact overshoot the atomic SQL fixes.
  check(
    'capital: the stale-read path (₹25k + ₹31k) would have wrongly passed — documents the bug',
    capitalReservationExceeds(25_000, 31_000, 60_000) === false
  );

  // ── 11. Exit-retry circuit breaker (RECLTD 2026-07-27) ────────────────────
  // The guard used to ALERT on repeated exit failures and then resubmit on the
  // very next 5-second pass — 89 rejected orders and 30+ identical alerts in
  // 10 minutes, none of which could have succeeded. This decides whether a
  // stopped-out position gets an exit attempt, so it belongs in CI.
  check('exit retry: first failure retries immediately (transient rejects must not wait)', exitRetryWaitMs(1) === 0);
  check(
    'exit retry: still immediate one BELOW the escalation threshold',
    exitRetryWaitMs(EXIT_FAILURE_ESCALATE - 1) === 0
  );
  check(
    'exit retry: AT the threshold the breaker engages (backs off, never gives up)',
    exitRetryWaitMs(EXIT_FAILURE_ESCALATE) === EXIT_RETRY_BACKOFF_MS
  );
  check('exit retry: stays backed off as failures pile up', exitRetryWaitMs(89) === EXIT_RETRY_BACKOFF_MS);
  // The incident, in numbers: 10 minutes of 5-second passes is ~120 attempts.
  // Under the breaker the same window allows at most ~5.
  check(
    'exit retry: the 10-minute RECLTD window now allows ≤6 attempts, not 89',
    Math.ceil((10 * 60_000) / EXIT_RETRY_BACKOFF_MS) + EXIT_FAILURE_ESCALATE <= 9
  );
  // Alert dedup: the FIRST escalation must always fire (a silent breaker is
  // worse than a noisy one), and repeats must be throttled.
  // Assert the SHIPPED helper, not a re-statement of it — a copy here could
  // drift from the guard and still pass.
  const alertsAt = shouldAlertOnExitFailure;
  check('exit alert: the first escalation always fires', alertsAt(EXIT_FAILURE_ESCALATE) === true);
  check('exit alert: the next failure does NOT re-alert', alertsAt(EXIT_FAILURE_ESCALATE + 1) === false);
  check(
    'exit alert: re-alerts once per EXIT_ALERT_EVERY failures',
    alertsAt(EXIT_FAILURE_ESCALATE + EXIT_ALERT_EVERY) === true
  );
  check('exit alert: never alerts below the threshold', alertsAt(EXIT_FAILURE_ESCALATE - 1) === false);

  // Review finding (2026-07-28): exitTrade REFUSES on three paths before any
  // auto_orders row exists (stale date, unexpected short, excess position), so
  // an order-derived count alone stays at 0 and never backs off. The guard now
  // takes max(orderDerived, inMemory). These assert the combining rule.
  const effectiveFails = (orderDerived: number, inMemory: number) => Math.max(orderDerived, inMemory);
  check(
    'exit retry: a refusal that wrote NO order row still engages the breaker',
    exitRetryWaitMs(effectiveFails(0, EXIT_FAILURE_ESCALATE)) === EXIT_RETRY_BACKOFF_MS
  );
  check(
    'exit retry: a durable reject count still engages it after a restart wipes memory',
    exitRetryWaitMs(effectiveFails(EXIT_FAILURE_ESCALATE, 0)) === EXIT_RETRY_BACKOFF_MS
  );
  check(
    'exit retry: neither source at the threshold means no backoff (the two do not sum)',
    exitRetryWaitMs(effectiveFails(EXIT_FAILURE_ESCALATE - 1, EXIT_FAILURE_ESCALATE - 1)) === 0
  );
}
