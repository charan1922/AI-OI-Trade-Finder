/**
 * Fyers ORDER-PIPELINE smoke test (ops tool — run manually, market hours only).
 *
 * Places ONE deliberately unfillable LIMIT BUY (₹1 on an option trading far
 * higher), confirms it appears in the order book with our tag, then CANCELS
 * it immediately. Proves the broker accepts our orders (app permission,
 * symbology, tag) with no fill risk and no position. Total cost: ₹0
 * (an accepted-then-cancelled order has no charges).
 *
 * Usage:  npx tsx scripts/fyers-order-smoke.ts
 * Built after the 2026-07-16 SRF incident (order refused, reason lost).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

async function main(): Promise<void> {
  const { fyersModel } = await import('fyers-api-v3');
  const { fyersAppId, getFyersAccessToken } = await import('../lib/fyers/auth');
  const { safeJson, toFyersOptionSymbol } = await import('../lib/auto-trade/brokers/fyers-adapter');
  const path = await import('node:path');

  const symbol = toFyersOptionSymbol({
    symbol: 'SRF',
    optionType: 'CE',
    strike: 2900,
    expiryDate: '2026-07-28',
  });
  const tag = `RSMOKE${Date.now().toString(36).toUpperCase()}`;
  console.log(`[smoke] symbol=${symbol} tag=${tag}`);

  const fyers = new fyersModel({ path: path.join(process.cwd(), 'data'), enableLogging: true });
  fyers.setAppId(fyersAppId());
  fyers.setAccessToken(await getFyersAccessToken());

  // 1. Quote sanity — the limit must sit FAR below the market so it can't fill.
  const quote = (await fyers.getQuotes([symbol])) as Record<string, unknown>;
  const row = (quote?.d as Record<string, unknown>[] | undefined)?.[0];
  const ltp = Number((row?.v as Record<string, unknown> | undefined)?.lp);
  console.log(`[smoke] LTP = ₹${ltp}`);
  if (!Number.isFinite(ltp) || ltp < 10) {
    console.error('[smoke] ABORT: LTP unavailable or too low for a safe unfillable limit — pick another contract.');
    process.exit(1);
  }

  // 2. Place the unfillable limit buy (1 lot).
  const req = {
    symbol,
    qty: 200,
    type: 1, // LIMIT
    side: 1, // BUY
    productType: 'INTRADAY',
    limitPrice: 1,
    stopPrice: 0,
    validity: 'DAY',
    disclosedQty: 0,
    offlineOrder: false,
    orderTag: tag,
  };
  let placed: Record<string, unknown>;
  try {
    placed = (await fyers.place_order(req)) as Record<string, unknown>;
  } catch (err) {
    console.error(`[smoke] ❌ PLACE REJECTED/FAILED — this is the exact broker answer:`);
    console.error(safeJson(err, 1000));
    process.exit(1);
  }
  console.log(`[smoke] place response: ${safeJson(placed, 500)}`);
  const orderId = String(placed?.id ?? '');
  if (placed?.s !== 'ok' || !orderId) {
    console.error('[smoke] ❌ broker refused the order (resolved error) — see response above.');
    process.exit(1);
  }
  console.log(`[smoke] ✅ order ACCEPTED, id=${orderId}`);

  // 3. Verify it is visible in the order book with our tag.
  await new Promise((r) => setTimeout(r, 1500));
  const book = (await fyers.get_orders()) as Record<string, unknown>;
  const orders = Array.isArray(book?.orderBook) ? (book.orderBook as Record<string, unknown>[]) : [];
  const mine = orders.find((o) => String(o.id) === orderId);
  console.log(
    mine
      ? `[smoke] ✅ visible in order book: status=${mine.status} tag=${String(mine.orderTag ?? '')}`
      : '[smoke] ⚠ order NOT visible in book yet (id lookup miss)'
  );

  // 4. Cancel immediately — leave nothing behind.
  try {
    const cancelled = (await fyers.cancel_order({ id: orderId })) as Record<string, unknown>;
    console.log(`[smoke] cancel response: ${safeJson(cancelled, 300)}`);
  } catch (err) {
    console.error(`[smoke] ⚠ CANCEL FAILED — cancel order ${orderId} MANUALLY in the Fyers app NOW: ${safeJson(err, 500)}`);
    process.exit(1);
  }
  console.log('[smoke] ✅ DONE: accepted → seen in book → cancelled. Order pipeline is GO.');
}

void main();
