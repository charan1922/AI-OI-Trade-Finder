/**
 * REAL-MONEY round-trip test: market BUY 1 lot of a liquid stock option,
 * then market SELL it immediately. Cost ≈ bid-ask spread + charges
 * (₹100–400 on a liquid contract). Run ONLY after the Fyers app is
 * activated and the ₹0 smoke test (scripts/fyers-order-smoke.ts or the
 * /auto-trade button) passes.
 *
 * Uses the PRODUCTION adapter (FyersAdapter.placeMarketOrder/getOrderState)
 * so a pass proves the exact code path live trades use.
 *
 * Usage: npx tsx scripts/fyers-order-roundtrip.ts --yes
 *        (add --symbol=XYZ to test a different underlying; default SRF)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

const MAX_PREMIUM_BUDGET = 20_000; // ₹ premium per lot ceiling (capital ₹25k)

async function main(): Promise<void> {
  if (!process.argv.includes('--yes')) {
    console.error('[roundtrip] This places a REAL order with REAL money. Re-run with --yes to confirm.');
    process.exit(1);
  }
  const symArg = process.argv.find((a) => a.startsWith('--symbol='));
  const underlying = (symArg ? symArg.split('=')[1] : 'SRF').toUpperCase();

  const { FyersAdapter } = await import('../lib/auto-trade/brokers/fyers-adapter');
  const { prisma } = await import('../lib/db');
  const { todayIST, isMarketHours } = await import('../lib/dhan/market-feed');

  if (!isMarketHours()) {
    console.error('[roundtrip] market is closed — run between 09:15 and 15:30 IST.');
    process.exit(1);
  }

  // Resolve a real, liquid, affordable contract (same sources as the app).
  const [expiryRow] = (await prisma.$queryRawUnsafe(
    `SELECT expiryDate FROM fno_expiry_calendar WHERE expiryDate >= ? ORDER BY expiryDate LIMIT 1`,
    todayIST()
  )) as { expiryDate: string }[];
  const [lotRow] = (await prisma.$queryRawUnsafe(
    `SELECT lotSize FROM master_contracts WHERE underlying = ? AND instrument = 'FUTSTK' AND lotSize > 0 LIMIT 1`,
    underlying
  )) as { lotSize: number }[];
  if (!expiryRow || !lotRow) {
    console.error(`[roundtrip] cannot resolve expiry/lot for ${underlying}`);
    process.exit(1);
  }
  const lotSize = Number(lotRow.lotSize);
  const [strikeRow] = (await prisma.$queryRawUnsafe(
    `SELECT strike, close FROM bhavcopy_option_strike
      WHERE symbol = ? AND expiry = ? AND optionType = 'CE' AND close * ? <= ? AND oi > 0
      ORDER BY oi DESC, date DESC LIMIT 1`,
    underlying,
    expiryRow.expiryDate,
    lotSize,
    MAX_PREMIUM_BUDGET
  )) as { strike: number; close: number }[];
  if (!strikeRow) {
    console.error(`[roundtrip] no liquid CE under the ₹${MAX_PREMIUM_BUDGET} premium budget for ${underlying}`);
    process.exit(1);
  }

  const base = {
    symbol: underlying,
    optionType: 'CE' as const,
    strike: Number(strikeRow.strike),
    expiryDate: expiryRow.expiryDate,
    optSecurityId: '', // Dhan-only field; the Fyers adapter builds its own symbol

    lotSize,
    lots: 1,
  };
  console.log(
    `[roundtrip] contract: ${base.symbol} ${base.strike}CE exp ${base.expiryDate}, 1 lot × ${lotSize} (~₹${Math.round(strikeRow.close * lotSize)} premium at yesterday's close)`
  );

  const adapter = new FyersAdapter();
  const stamp = Date.now().toString(36);

  const waitForFill = async (orderId: string, label: string): Promise<number> => {
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const state = await adapter.getOrderState(orderId);
      console.log(`[roundtrip] ${label} order ${orderId}: ${state.status}${state.avgFillPrice ? ` @ ₹${state.avgFillPrice}` : ''}`);
      if (state.status === 'filled' && state.avgFillPrice != null) return state.avgFillPrice;
      if (state.status === 'rejected' || state.status === 'cancelled') {
        throw new Error(`${label} ${state.status}: ${state.detail ?? 'no detail'}`);
      }
    }
    throw new Error(`${label} not filled after 30s — CHECK THE FYERS APP MANUALLY before doing anything else.`);
  };

  // BUY 1 lot at market.
  const buy = await adapter.placeMarketOrder({
    ...base,
    side: 'BUY',
    idemKey: `roundtrip:${stamp}:buy`,
    correlationId: `RTBUY${stamp.toUpperCase()}`,
  });
  console.log(`[roundtrip] BUY accepted: id ${buy.brokerOrderId}`);
  const buyFill = await waitForFill(buy.brokerOrderId, 'BUY');

  // SELL it back immediately at market.
  const sell = await adapter.placeMarketOrder({
    ...base,
    side: 'SELL',
    idemKey: `roundtrip:${stamp}:sell`,
    correlationId: `RTSELL${stamp.toUpperCase()}`,
  });
  console.log(`[roundtrip] SELL accepted: id ${sell.brokerOrderId}`);
  const sellFill = await waitForFill(sell.brokerOrderId, 'SELL');

  const pnl = Math.round((sellFill - buyFill) * lotSize);
  console.log(
    `[roundtrip] ✅ ROUND-TRIP COMPLETE: bought ₹${buyFill}, sold ₹${sellFill} → spread cost ₹${pnl} (before charges).`
  );
  console.log('[roundtrip] The live order pipeline works end-to-end. Verify the two fills in the Fyers app match.');
  process.exit(0);
}

void main().catch((err) => {
  console.error(`[roundtrip] ❌ ${(err as Error).message}`);
  process.exit(1);
});
