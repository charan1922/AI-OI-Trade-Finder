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
import { backstopsFromProposalFill, riskPerLotRupees, stopPremiumForFill } from '../lib/auto-trade/backstops';
import { DEFAULT_SETTINGS } from '../lib/auto-trade/config';
import type { EntryGateInput } from '../lib/auto-trade/risk/gates';

export type CheckFn = (name: string, ok: boolean, detail?: string) => void;

/** A gate input that PASSES, so each test below isolates one failure cause.
 *  Mirrors a real 23-Jul entry: SRF at ₹44.05 on a 200 lot. */
function passingGate(over: Partial<EntryGateInput> = {}): EntryGateInput {
  return {
    settings: { ...DEFAULT_SETTINGS, mode: 'paper' as const },
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

  // ── 3. Per-lot risk ceiling: refuse the contract, never tighten the stop ───
  check('gates: a lot risking ₹2,202 passes the ₹2,500 ceiling', checkEntryGates(passingGate()).allow);
  check(
    'gates: POLYCAB-sized lot (₹127 ask × 125, risks ₹3,969) is REFUSED',
    refused(passingGate({ askPrice: 127, lotSize: 125, askQty: 125, perLotCost: 15_875 }))
  );
  check(
    'gates: the refusal says the stop is NOT tightened to fit',
    because(passingGate({ askPrice: 127, lotSize: 125, askQty: 125, perLotCost: 15_875 }), 'not tightened')
  );
  // Boundary: ₹40 ask × 250 = ₹2,500 exactly at a 25% stop.
  check(
    'gates: exactly AT the ceiling is allowed (₹2,500 is not > ₹2,500)',
    checkEntryGates(passingGate({ askPrice: 40, lotSize: 250, askQty: 250, perLotCost: 10_000 })).allow,
    String(riskPerLotRupees(40, 250))
  );
  // The stop level is rounded to 2dp, so the smallest step that genuinely moves
  // the risk above the ceiling on a 250 lot is ₹0.04, not ₹0.01 — ₹40.02 still
  // computes to exactly ₹2,500. The assertion is that the comparison is `>`,
  // not `>=`; using a price that only LOOKS over would prove nothing.
  check(
    'gates: just over the ceiling is refused (the check is >, not >=)',
    refused(passingGate({ askPrice: 40.04, lotSize: 250, askQty: 250, perLotCost: 10_010 })),
    `₹${riskPerLotRupees(40.04, 250)} vs ceiling ₹2,500`
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
  check(
    'gates: a corrupt optionStopPct FAILS the entry',
    refused(passingGate({ settings: { ...DEFAULT_SETTINGS, mode: 'paper', optionStopPct: Number.NaN } }))
  );

  // ── 5. Risk is priced off the ASK we pay, not the ltp/mid mark ─────────────
  // A market BUY lifts the offer. Sizing off a ₹100 mark while the ask is ₹110
  // understates the rupees really behind the stop.
  check(
    'gates: an lot that is cheap on the MARK but dear on the ASK is refused',
    refused(passingGate({ perLotCost: 9_500, askPrice: 55, lotSize: 200, askQty: 200 })),
    `mark ₹9,500 → looks fine; ask ₹55 × 200 risks ₹${riskPerLotRupees(55, 200)}`
  );
  check(
    'gates: the refusal names the ask it priced from',
    because(passingGate({ perLotCost: 9_500, askPrice: 55, lotSize: 200, askQty: 200 }), 'ask we would actually pay')
  );

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

  // ── 7. stopPctOverride — the approval path gates on the PROPOSAL's width ───
  // Same contract, same ceiling: allowed at the proposal's 10% width, refused at
  // a 25% one. Gating on a since-changed setting would ship a different policy
  // than the one evaluated.
  check(
    'gates: a proposal snapshotted at a 10% width is sized at 10%',
    checkEntryGates(passingGate({ askPrice: 127, lotSize: 125, askQty: 125, perLotCost: 15_875, stopPctOverride: 10 }))
      .allow,
    `risk at 10% = ₹${riskPerLotRupees(127, 125, 10)}`
  );
  check(
    'gates: the same contract at the 25% runtime width is refused',
    refused(passingGate({ askPrice: 127, lotSize: 125, askQty: 125, perLotCost: 15_875 })),
    `risk at 25% = ₹${riskPerLotRupees(127, 125)}`
  );
  check(
    'gates: a corrupt override FAILS closed rather than falling back silently',
    refused(passingGate({ stopPctOverride: 150 }))
  );

  // ── 8. The approval drift scenario the review described, end to end ────────
  // Proposal sized just under the ceiling; the option ticks up ~2.9% while the
  // human decides — inside the slippage guard, so nothing else objects — and the
  // fresh risk crosses the limit. Before the fix this was approved, because the
  // approval path never passed lotSize and the ceiling skipped itself.
  const atProposal = passingGate({ askPrice: 49, lotSize: 200, askQty: 200, perLotCost: 9_800 });
  const atApproval = passingGate({ askPrice: 50.42, lotSize: 200, askQty: 200, perLotCost: 10_084, slippagePct: 2.9 });
  check(
    'approval drift: the proposal was under the ceiling',
    checkEntryGates(atProposal).allow,
    `₹${riskPerLotRupees(49, 200)}`
  );
  check(
    'approval drift: a +2.9% move (inside the slippage guard) now breaches it and is REFUSED',
    refused(atApproval),
    `₹${riskPerLotRupees(50.42, 200)} > ₹2,500`
  );
}
