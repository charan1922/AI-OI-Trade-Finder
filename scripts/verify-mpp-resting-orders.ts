/**
 * MPP resting-order handling (lib/auto-trade/execution.ts → cancelRestingOrder), driven through the
 * REAL exitTrade / placeEntryOrder against an ISOLATED throwaway SQLite database and a scripted fake
 * of the live Fyers adapter. No network, no broker, no Telegram.
 *
 * Why it exists: since 2026-04-01 (SEBI retail-algo framework) Fyers and Dhan turn every API MARKET
 * order into a LIMIT at LTP ± a protection band. In a fast move the order RESTS at that stale limit,
 * and an open SELL blocks every new exit claim — a stop that never fills. The fix cancels a resting
 * order, and re-places an exit ONLY after the broker confirms the cancel with nothing filled. These
 * checks pin the money rules: never two live SELLs, never re-place after any fill, never on an
 * unconfirmed cancel, bounded re-prices, and a resting entry is cancelled instead of filling hours
 * later. Runs in GitHub CI. Exit 1 on any failure.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrderState, OrderTicket, PlacedOrder } from '../lib/auto-trade/brokers/adapter';

// No real alerts from a bench, whatever the shell has set.
for (const k of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'ALERT_WEBHOOK_URL']) delete process.env[k];

// The engine polls every 2s; a scripted broker needs no wall-clock wait.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: (...a: unknown[]) => void, _ms?: number, ...args: unknown[]) =>
  realSetTimeout(fn, 0, ...args)) as typeof setTimeout;

const originalCwd = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), 'mpp-resting-'));
mkdirSync(join(tmp, 'data'), { recursive: true });
process.chdir(tmp);

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** One scripted broker order: its state before and after a cancel request. */
interface Script {
  /** State returned while polling (before any cancel). */
  resting: OrderState;
  /** State returned after cancelOrder was called. */
  afterCancel: OrderState;
  /** cancelOrder throws (e.g. "already traded"). */
  cancelThrows?: boolean;
}

const fake = {
  scripts: [] as Script[],
  placed: [] as { id: string; side: string; qty: number }[],
  cancelled: new Set<string>(),
  netQtyUnits: 550,
  reset(scripts: Script[], netQtyUnits = 550) {
    this.scripts = scripts;
    this.placed = [];
    this.cancelled = new Set();
    this.netQtyUnits = netQtyUnits;
  },
};

const PENDING: OrderState = { status: 'pending', avgFillPrice: null, filledQtyUnits: null };
const CANCELLED: OrderState = { status: 'cancelled', avgFillPrice: null, filledQtyUnits: null };
const filled = (price: number, units = 550): OrderState => ({ status: 'filled', avgFillPrice: price, filledQtyUnits: units });

async function main(): Promise<void> {
  const { FyersAdapter } = await import('../lib/auto-trade/brokers/fyers-adapter');
  const proto = FyersAdapter.prototype as unknown as Record<string, unknown>;
  proto.placeMarketOrder = async (ticket: OrderTicket): Promise<PlacedOrder> => {
    const id = `o${fake.placed.length + 1}`;
    fake.placed.push({ id, side: ticket.side, qty: ticket.qtyUnitsOverride ?? 0 });
    return { brokerOrderId: id };
  };
  proto.getOrderState = async (id: string): Promise<OrderState> => {
    const s = fake.scripts[Number(id.slice(1)) - 1];
    if (!s) return { status: 'unknown', avgFillPrice: null, detail: 'unscripted order' };
    return fake.cancelled.has(id) ? s.afterCancel : s.resting;
  };
  proto.cancelOrder = async (id: string): Promise<void> => {
    const s = fake.scripts[Number(id.slice(1)) - 1];
    fake.cancelled.add(id);
    if (s?.cancelThrows) throw new Error('cancel_order failed: order already traded');
  };
  proto.getNetPosition = async () => ({ kind: 'verified', netQtyUnits: fake.netQtyUnits, sellAvg: null });

  const { insertTrade, getTrade, getOrdersForTrade, updateTrade, claimExitOrder } = await import('../lib/auto-trade/store');
  const { exitTrade, placeEntryOrder } = await import('../lib/auto-trade/execution');
  const { getAutoTradeSettings } = await import('../lib/auto-trade/settings');
  const { todayIST } = await import('../lib/market-data');
  const date = todayIST();

  let n = 0;
  async function newTrade(status: 'open' | 'placing') {
    n += 1;
    const id = await insertTrade({
      date,
      symbol: `TEST${n}`,
      direction: 'bullish',
      optionType: 'CE',
      strike: 1000,
      expiryDate: '2099-12-30',
      lotSize: 550,
      lots: 1,
      optSecurityId: `9${n}`,
      mode: 'live',
      broker: 'fyers',
      status,
      entrySpot: 1000,
      slSpot: 990,
      targetSpot: null,
      entryPremium: 100,
      slPremium: 75,
      targetPremium: 200,
      aiReasonEntry: 'bench',
    });
    if (id == null) throw new Error('insertTrade returned null');
    if (status === 'open') await updateTrade(id, { entryFillPremium: 100 });
    const t = await getTrade(id);
    if (!t) throw new Error('trade not found');
    return t;
  }
  const sells = async (tradeId: number) => (await getOrdersForTrade(tradeId)).filter((o) => o.side === 'SELL');

  // A — rests twice at the stale limit, the third (fresh) exit fills.
  {
    const t = await newTrade('open');
    fake.reset([
      { resting: PENDING, afterCancel: CANCELLED },
      { resting: PENDING, afterCancel: CANCELLED },
      { resting: filled(92), afterCancel: filled(92) },
    ]);
    const out = await exitTrade(t, 'stop');
    const after = await getTrade(t.id);
    const rows = await sells(t.id);
    check('resting exit is cancelled and re-placed until it fills', out.state === 'filled' && after?.status === 'closed', out.message);
    check('…exactly 3 SELLs, the first two cancelled at the broker', fake.placed.length === 3 && fake.cancelled.has('o1') && fake.cancelled.has('o2'));
    check('…stored: 2 cancelled + 1 filled', rows.filter((o) => o.status === 'cancelled').length === 2 && rows.filter((o) => o.status === 'filled').length === 1, rows.map((o) => o.status).join(','));
  }

  // B — every exit rests: bounded (1 + MAX_EXIT_REPRICES placements), trade stays open, claim free.
  {
    const t = await newTrade('open');
    fake.reset([1, 2, 3, 4, 5].map(() => ({ resting: PENDING, afterCancel: CANCELLED })));
    const out = await exitTrade(t, 'stop');
    const after = await getTrade(t.id);
    check('re-pricing is bounded (3 placements, not a loop)', fake.placed.length === 3, `${fake.placed.length} placed`);
    check('…outcome is a retryable failure, trade still open', out.ok === false && after?.status === 'open', out.message);
    const claim = await claimExitOrder({ tradeId: t.id, idemKeyBase: `bench:${t.id}`, broker: 'fyers', mode: 'live', qtyUnits: 550 });
    check('…every SELL is cancelled, so the next pass can claim a new exit', claim != null);
  }

  // C — the cancel loses a race with a fill: book the fill, never re-place.
  {
    const t = await newTrade('open');
    fake.reset([{ resting: PENDING, afterCancel: filled(90), cancelThrows: true }]);
    const out = await exitTrade(t, 'stop');
    check('cancel that races a fill books the fill — no second SELL', out.state === 'filled' && fake.placed.length === 1, out.message);
  }

  // D — cancel accepted but the broker still says pending: NO re-place (two live SELLs = a short).
  {
    const t = await newTrade('open');
    fake.reset([{ resting: PENDING, afterCancel: PENDING }]);
    const out = await exitTrade(t, 'stop');
    const rows = await sells(t.id);
    check('unconfirmed cancel never re-places', out.state === 'pending' && fake.placed.length === 1, out.message);
    check('…and the open SELL still blocks a new claim', rows.length === 1 && rows[0].status === 'sent');
  }

  // E — cancelled after a PARTIAL fill: manual, never an automatic re-place.
  {
    const t = await newTrade('open');
    fake.reset([{ resting: PENDING, afterCancel: { status: 'cancelled', avgFillPrice: 91, filledQtyUnits: 275 } }]);
    const out = await exitTrade(t, 'stop');
    check('partial fill then cancel → unknown + manual, no re-place', out.state === 'unknown' && fake.placed.length === 1, out.message);
  }

  // F — a resting ENTRY is cancelled: the trade fails cleanly instead of filling hours later.
  {
    const t = await newTrade('placing');
    fake.reset([{ resting: PENDING, afterCancel: CANCELLED }]);
    const out = await placeEntryOrder(t, await getAutoTradeSettings(), 'live');
    const after = await getTrade(t.id);
    check('resting entry is cancelled and the trade fails', out.ok === false && after?.status === 'failed' && fake.cancelled.has('o1'), out.message);
    check('…and is never re-placed', fake.placed.length === 1);
  }

  // G — the entry cancel races a fill: the trade opens normally.
  {
    const t = await newTrade('placing');
    fake.reset([{ resting: PENDING, afterCancel: filled(101), cancelThrows: true }]);
    const out = await placeEntryOrder(t, await getAutoTradeSettings(), 'live');
    const after = await getTrade(t.id);
    check('entry cancel that races a fill opens the trade', out.state === 'filled' && after?.status === 'open', out.message);
  }

  const { prisma } = await import('../lib/db');
  await prisma.$disconnect();
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    process.chdir(originalCwd);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Windows briefly holds the SQLite handle after disconnect; a leftover temp dir is harmless.
    }
    console.log(failures === 0 ? '\n✅ all MPP resting-order checks passed' : `\n❌ ${failures} MPP check(s) failed`);
    process.exit(failures === 0 ? 0 : 1);
  });
