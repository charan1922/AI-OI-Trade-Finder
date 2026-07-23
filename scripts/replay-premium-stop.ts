/**
 * Fill-price SENSITIVITY ANALYSIS of the premium-stop rule change, over every
 * recorded LIVE trade.
 *
 * NOT an exact replay of the production entry gate. It decides allow/refuse from
 * each trade's ACTUAL FILL against MAX_RISK_PER_LOT_RUPEES; the real gate
 * (risk/gates.ts) decides from the PRE-ORDER ASK, the ask quantity, and the
 * runtime settings at that moment. A trade whose ask-risk sat just under the
 * ceiling but whose market fill nudged it over would be allowed-and-latched by
 * production yet labelled "refused" below. Read the verdicts as fill-price
 * sensitivity, not as what the gate would literally have done.
 *
 * With that caveat, it answers: under the new rule (a flat OPTION_STOP_PCT stop,
 * with over-sized lots refused at MAX_RISK_PER_LOT_RUPEES instead of having their
 * stop tightened), which real trades still fit the per-lot budget at their fill,
 * and which would have survived their stop?
 *
 * Data sources — all recorded, nothing modelled:
 *   auto_trades            the real fills, stops and outcomes
 *   auto_quote_snapshots   the guard's own 5-second option bid/ask samples
 *                          while each position was open (today's trades only)
 *   rfactor_v2_option_snapshots
 *                          per-strike option bid/ask/ltp captured all day, which
 *                          is what makes "would it have survived?" answerable
 *                          AFTER the real exit
 *
 * HONEST LIMITS, stated up front because they bound every number below:
 *  - n = 9 completed live trades over 5 sessions. That is a small sample.
 *  - Full-day option prices exist only for 2026-07-23. For earlier dates this
 *    can say whether the trade would have been ALLOWED, and whether the lowest
 *    bid the guard actually saw would still have broken the new stop — it cannot
 *    say what the contract did after the real exit.
 *  - "Survived" here means the recorded bid never touched the new stop. It does
 *    NOT claim the trade would have been closed at any particular profit; the
 *    exit rules (target, square-off) are unchanged and not re-simulated.
 *
 *   npx tsx scripts/replay-premium-stop.ts
 */
try {
  process.loadEnvFile('.env.local');
} catch {
  // file-based DB — nothing else needed
}

import { prisma } from '../lib/db';
import { riskPerLotRupees, stopPremiumForFill } from '../lib/auto-trade/backstops';
import { MAX_RISK_PER_LOT_RUPEES, OPTION_STOP_PCT } from '../lib/trade-suggest/config';

interface TradeRow {
  id: number;
  date: string;
  symbol: string;
  optionType: string;
  strike: number;
  lotSize: number;
  entryFillPremium: number;
  slPremium: number;
  exitFillPremium: number | null;
  realizedPnlRupees: number | null;
  exitReason: string | null;
  closedAt: string | null;
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/**
 * Lowest option bid PRESENT IN THE RETAINED GUARD SNAPSHOTS while the position
 * was open. The guard samples roughly every 5 seconds and keeps one routine row
 * per minute (plus every row that decided something), so this is the lowest
 * SAMPLED bid — not proof that no lower bid ever existed between samples
 * (PR#18 review). It is the same evidence the live stop was actually checked
 * against, which is why it is the fair basis for "would the wider stop have
 * fired?", but it must not be described as a continuous low.
 */
async function guardLowBid(tradeId: number): Promise<number | null> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT MIN(bid) AS low FROM auto_quote_snapshots WHERE tradeId = ? AND bid IS NOT NULL`,
    tradeId
  )) as { low: number | null }[];
  const low = rows[0]?.low;
  return low != null && Number.isFinite(Number(low)) ? Number(low) : null;
}

/** Full-day bid path for one strike, from the option-chain snapshots. */
async function dayBidPath(
  symbol: string,
  date: string,
  strike: number,
  side: string
): Promise<{ capturedAt: string; bid: number }[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT capturedAt, evidence FROM rfactor_v2_option_snapshots WHERE symbol = ? AND date = ? ORDER BY capturedAt`,
    symbol,
    date
  )) as { capturedAt: string; evidence: string }[];
  const out: { capturedAt: string; bid: number }[] = [];
  for (const row of rows) {
    let parsed: { rows?: { strike: number; side: string; bid: number | null }[] };
    try {
      parsed = JSON.parse(row.evidence);
    } catch {
      continue;
    }
    const leg = (parsed.rows ?? []).find((r) => r.strike === strike && r.side === side);
    if (leg?.bid != null && Number.isFinite(leg.bid)) out.push({ capturedAt: row.capturedAt, bid: leg.bid });
  }
  return out;
}

async function main(): Promise<void> {
  const trades = (await prisma.$queryRawUnsafe(
    `SELECT id, date, symbol, optionType, strike, lotSize, entryFillPremium, slPremium,
            exitFillPremium, realizedPnlRupees, exitReason, closedAt
       FROM auto_trades
      WHERE mode = 'live'
        AND status = 'closed'
        AND entryFillPremium IS NOT NULL
        AND realizedPnlRupees IS NOT NULL
      ORDER BY date, id`
  )) as TradeRow[];

  console.log(`Premium-stop FILL-PRICE SENSITIVITY — new rule: ${OPTION_STOP_PCT}% stop, refuse a lot risking over ${inr(MAX_RISK_PER_LOT_RUPEES)}`);
  console.log(`(allow/refuse decided from each trade's FILL; the live gate uses the pre-order ASK + depth — not identical)`);
  console.log(`${trades.length} completed live trades on record\n`);

  let allowedCount = 0;
  let refusedCount = 0;
  let refusedPnl = 0;
  let survivedCount = 0;

  for (const t of trades) {
    const fill = Number(t.entryFillPremium);
    const lotSize = Number(t.lotSize);
    const oldStop = Number(t.slPremium);
    const oldWidthPct = ((fill - oldStop) / fill) * 100;
    const newStop = stopPremiumForFill(fill);
    // Sensitivity basis: risk at the ACTUAL FILL. Production sizes off the
    // pre-order ask (+ ask depth); this uses the fill because that is what the
    // recorded rows carry, so a near-boundary trade could differ from the gate.
    const risk = riskPerLotRupees(fill, lotSize);
    const allowed = risk <= MAX_RISK_PER_LOT_RUPEES;
    const pnl = t.realizedPnlRupees == null ? null : Number(t.realizedPnlRupees);

    console.log(`── ${t.date}  ${t.symbol} ${t.strike}${t.optionType}  (lot ${lotSize})`);
    console.log(
      `   filled ${inr(fill)}/unit · lot cost ${inr(fill * lotSize)} · actual result ${pnl == null ? 'n/a' : inr(pnl)}`
    );
    console.log(
      `   OLD stop ${inr(oldStop)} (${oldWidthPct.toFixed(1)}% — set by ₹1,500 ÷ ${lotSize})` +
        `   →   NEW stop ${inr(newStop)} (${OPTION_STOP_PCT}%, risks ${inr(risk)})`
    );

    if (!allowed) {
      refusedCount++;
      if (pnl != null) refusedPnl += pnl;
      console.log(`   VERDICT: REFUSED — ${inr(risk)} of risk exceeds the ${inr(MAX_RISK_PER_LOT_RUPEES)} per-lot budget`);
      console.log(`            this trade would not have been taken. It actually returned ${pnl == null ? 'n/a' : inr(pnl)}.\n`);
      continue;
    }
    allowedCount++;

    const low = await guardLowBid(t.id);
    if (low == null) {
      console.log(`   VERDICT: ALLOWED — no stored bid samples for this trade, survival not testable\n`);
      continue;
    }
    const brokeOld = low <= oldStop;
    const brokeNew = low <= newStop;
    console.log(
      `   lowest bid in the retained snapshots while open: ${inr(low)}` +
        `  → old stop ${brokeOld ? 'BROKEN' : 'held'} · new stop ${brokeNew ? 'BROKEN' : 'HELD'}`
    );

    if (brokeOld && !brokeNew) {
      survivedCount++;
      const path = await dayBidPath(t.symbol, t.date, Number(t.strike), t.optionType);
      const after = t.closedAt ? path.filter((p) => p.capturedAt > t.closedAt!) : [];
      const stoppedLater = after.find((p) => p.bid <= newStop) ?? null;
      const best = after.reduce<{ capturedAt: string; bid: number } | null>(
        (acc, p) => (acc == null || p.bid > acc.bid ? p : acc),
        null
      );
      console.log(`   VERDICT: ALLOWED and would NOT have been stopped out here.`);
      if (after.length === 0) {
        console.log(`            no full-day option prices stored for ${t.date} — cannot say what happened next.\n`);
        continue;
      }
      if (stoppedLater) {
        console.log(
          `            later in the day the bid did reach ${inr(stoppedLater.bid)} at ${stoppedLater.capturedAt} — it would have stopped out then.`
        );
      } else {
        console.log(`            no retained snapshot shows the bid back at ${inr(newStop)} for the rest of the session.`);
      }
      if (best) {
        const wouldBe = (best.bid - fill) * lotSize;
        console.log(
          `            best bid after the real exit: ${inr(best.bid)} at ${best.capturedAt}` +
            `  →  ${inr(wouldBe)} on one lot at that point (vs ${pnl == null ? 'n/a' : inr(pnl)} actually booked).`
        );
      }
      console.log('');
      continue;
    }
    console.log(`   VERDICT: ALLOWED, and the outcome is unchanged by the wider stop.\n`);
  }

  console.log('─'.repeat(72));
  console.log(`allowed under the new rule : ${allowedCount}`);
  console.log(`refused as too big a lot   : ${refusedCount}  (those trades actually returned ${inr(refusedPnl)} in total)`);
  console.log(`stopped out before, would survive now : ${survivedCount}`);

  // Honesty check: the capital cap ALREADY refuses a lot costing more than the
  // budget, so crediting the new gate with every refusal would overstate it.
  // Only the lots that fit the capital budget and still risk too much are new.
  const capRows = (await prisma.$queryRawUnsafe(
    `SELECT value FROM auto_trade_settings WHERE key = 'maxCapitalRupees'`
  )) as { value: string }[];
  const capital = Number(capRows[0]?.value ?? 60_000);
  let uniquelyNew = 0;
  let uniquelyNewPnl = 0;
  const alsoOverCapital: string[] = [];
  for (const t of trades) {
    const fill = Number(t.entryFillPremium);
    const cost = fill * Number(t.lotSize);
    if (riskPerLotRupees(fill, Number(t.lotSize)) <= MAX_RISK_PER_LOT_RUPEES) continue;
    if (cost > capital) {
      alsoOverCapital.push(`${t.symbol} (${inr(cost)})`);
      continue;
    }
    uniquelyNew++;
    if (t.realizedPnlRupees != null) uniquelyNewPnl += Number(t.realizedPnlRupees);
  }
  console.log(
    `\nof those ${refusedCount} refusals, the CURRENT capital cap (${inr(capital)}) already blocks ` +
      `${alsoOverCapital.length}: ${alsoOverCapital.join(', ') || 'none'}`
  );
  console.log(
    `the new per-lot risk gate is therefore uniquely responsible for ${uniquelyNew} refusal(s), ` +
      `worth ${inr(uniquelyNewPnl)} of realised loss avoided.`
  );

  console.log(
    `\nCAVEATS, all of which bound the numbers above:\n` +
      `  1. n=${trades.length} over 5 sessions. Small sample.\n` +
      `  2. Full-day option prices exist only for 2026-07-23, so "what happened next"\n` +
      `     is answerable for one trade (SRF) and no others.\n` +
      `  3. Lot cost and the old stop width are the SAME underlying variable — a big\n` +
      `     lot got a tight stop BECAUSE ₹1,500 divided by a big lot size is small.\n` +
      `     So "refused the losers" and "the tight stops lost" are one finding seen\n` +
      `     twice, not two independent confirmations.\n` +
      `  4. Refusing a trade is not free: it also forgoes whatever that trade might\n` +
      `     have won. On this sample all five refusals were losses, but that is a\n` +
      `     property of the sample, not a guarantee.\n` +
      `  5. These nine trades are the IN-SAMPLE evidence the policy was chosen\n` +
      `     from, not an independent validation set. Every bid figure above is\n` +
      `     the lowest RETAINED SNAPSHOT, not a continuous tape. The next live\n` +
      `     sessions are the real forward test.\n` +
      `  6. Allow/refuse here is a FILL-price sensitivity. The live gate sizes off\n` +
      `     the pre-order ASK + ask depth and the runtime settings, so a trade\n` +
      `     near the ceiling could be gated differently than labelled above.\n` +
      `Directional evidence, not proof. Watch the next few live sessions.`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
