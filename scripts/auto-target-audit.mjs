/**
 * Read-only cash-target audit over completed Auto Trade positions.
 *
 * Prefers executable bid history from auto_quote_snapshots. Older trades fall
 * back to exact-contract LTP retained in commentary/tool traces and are clearly
 * labelled as estimates rather than fillable target touches.
 *
 * Usage:
 *   node scripts/auto-target-audit.mjs --amount=1100 --basis=per_trade
 *   node scripts/auto-target-audit.mjs --amount=1100 --basis=per_lot
 */
import Database from 'better-sqlite3';

function arg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const amount = Number(arg('amount', '1100'));
const basis = arg('basis', 'per_trade');
if (!Number.isFinite(amount) || amount <= 0) throw new Error('--amount must be a positive number');
if (!new Set(['per_trade', 'per_lot']).has(basis)) {
  throw new Error('--basis must be per_trade or per_lot');
}

const db = new Database('./data/project-r.db', { readonly: true, fileMustExist: true });
const trades = db
  .prepare(
    `SELECT id, date, symbol, optionType, strike, lotSize, lots,
            entryFillPremium, exitFillPremium, realizedPnlRupees, openedAt, closedAt
       FROM auto_trades
      WHERE status = 'closed'
        AND entryFillPremium IS NOT NULL
        AND exitFillPremium IS NOT NULL
      ORDER BY date, id`
  )
  .all();

const commentariesByDate = new Map();
const commentaries = db.prepare(`SELECT date, asOf, picksJson FROM trade_commentary ORDER BY date, asOf`).all();
for (const row of commentaries) {
  const bucket = commentariesByDate.get(row.date) ?? [];
  bucket.push(row);
  commentariesByDate.set(row.date, bucket);
}

const decisionsByDate = new Map();
const decisions = db.prepare(`SELECT date, at, toolTrace FROM auto_decisions ORDER BY date, at`).all();
for (const row of decisions) {
  const bucket = decisionsByDate.get(row.date) ?? [];
  bucket.push(row);
  decisionsByDate.set(row.date, bucket);
}

const quoteSnapshotsByTrade = new Map();
const hasQuoteHistory = Boolean(
  db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auto_quote_snapshots'`).get()
);
if (hasQuoteHistory) {
  const snapshots = db
    .prepare(
      `SELECT tradeId, capturedAt, ltp, bid, ask, source
         FROM auto_quote_snapshots
        ORDER BY tradeId, capturedAt`
    )
    .all();
  for (const row of snapshots) {
    const bucket = quoteSnapshotsByTrade.get(Number(row.tradeId)) ?? [];
    bucket.push(row);
    quoteSnapshotsByTrade.set(Number(row.tradeId), bucket);
  }
}

function instant(raw) {
  const value = String(raw ?? '');
  return Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}+05:30`);
}

let actualTotal = 0;
let simulatedTotal = 0;
let observedTouches = 0;
let bidBackedTrades = 0;
let executableBidTouches = 0;
const rows = [];

for (const trade of trades) {
  const qty = Number(trade.lotSize) * Number(trade.lots);
  const cashTarget = basis === 'per_lot' ? amount * Number(trade.lots) : amount;
  const premiumTarget = Number(trade.entryFillPremium) + cashTarget / qty;
  let maxObservedPremium = Math.max(Number(trade.entryFillPremium), Number(trade.exitFillPremium));
  let maxObservedSource = 'fill';
  let maxExecutableBid = null;
  let executableBidSamples = 0;
  const openedAt = instant(trade.openedAt);
  const closedAt = instant(trade.closedAt);

  for (const commentary of commentariesByDate.get(trade.date) ?? []) {
    const at = instant(commentary.asOf);
    if (!Number.isFinite(at) || at < openedAt || at > closedAt) continue;
    let picks = [];
    try {
      picks = JSON.parse(commentary.picksJson || '[]');
    } catch {
      continue;
    }
    const pick = picks.find(
      (candidate) =>
        candidate.symbol === trade.symbol &&
        candidate.side === trade.optionType &&
        Number(candidate.strike) === Number(trade.strike)
    );
    const premium = Number(pick?.premium);
    if (Number.isFinite(premium) && premium > maxObservedPremium) {
      maxObservedPremium = premium;
      maxObservedSource = 'scanner LTP';
    }
  }

  // The autonomous model sometimes asks get_quote while managing an open
  // position. Those exact-contract LTPs live only in the deterministic tool
  // trace, so include them instead of silently understating historical MFE.
  for (const decision of decisionsByDate.get(trade.date) ?? []) {
    const at = instant(decision.at);
    if (!Number.isFinite(at) || at < openedAt || at > closedAt) continue;
    let trace = [];
    try {
      trace = JSON.parse(decision.toolTrace || '[]');
    } catch {
      continue;
    }
    for (const step of trace) {
      if (step?.name !== 'get_quote' || String(step?.args?.symbol ?? '').toUpperCase() !== trade.symbol) continue;
      const match = String(step.summary ?? '').match(/premium\s+([0-9]+(?:\.[0-9]+)?)/i);
      const premium = Number(match?.[1]);
      if (Number.isFinite(premium) && premium > maxObservedPremium) {
        maxObservedPremium = premium;
        maxObservedSource = 'position get_quote LTP';
      }
    }
  }

  const storedQuotes = (quoteSnapshotsByTrade.get(Number(trade.id)) ?? []).filter((snapshot) => {
    const at = instant(snapshot.capturedAt);
    return Number.isFinite(at) && at >= openedAt && at <= closedAt;
  });
  for (const snapshot of storedQuotes) {
    const ltp = Number(snapshot.ltp);
    if (Number.isFinite(ltp) && ltp > maxObservedPremium) {
      maxObservedPremium = ltp;
      maxObservedSource = 'stored guard LTP';
    }
    const bid = Number(snapshot.bid);
    if (Number.isFinite(bid) && bid > 0) {
      executableBidSamples++;
      maxExecutableBid = maxExecutableBid == null ? bid : Math.max(maxExecutableBid, bid);
    }
  }

  const bidBacked = storedQuotes.length > 0;
  const ltpTargetObserved = maxObservedPremium >= premiumTarget;
  const executableTargetObserved = maxExecutableBid != null && maxExecutableBid >= premiumTarget;
  const targetObserved = bidBacked ? executableTargetObserved : ltpTargetObserved;
  const actualPnl = Number(trade.realizedPnlRupees);
  const simulatedPnl = targetObserved ? cashTarget : actualPnl;
  actualTotal += actualPnl;
  simulatedTotal += simulatedPnl;
  if (targetObserved) observedTouches++;
  if (bidBacked) bidBackedTrades++;
  if (executableTargetObserved) executableBidTouches++;
  rows.push({
    date: trade.date,
    symbol: trade.symbol,
    entry: Number(trade.entryFillPremium).toFixed(2),
    target: premiumTarget.toFixed(2),
    maxLtp: maxObservedPremium.toFixed(2),
    maxBid: maxExecutableBid == null ? '—' : maxExecutableBid.toFixed(2),
    evidence: bidBacked ? `stored bid (${executableBidSamples} samples)` : `${maxObservedSource} (LTP only)`,
    observed: targetObserved ? 'yes' : 'no',
    actualPnl,
    simulatedPnl: Math.round(simulatedPnl),
  });
}

console.table(rows);
console.log(
  JSON.stringify(
    {
      policy: { basis, amount },
      completedTrades: rows.length,
      targetObserved: observedTouches,
      bidBackedTrades,
      executableBidTouches,
      actualPnlRupees: Math.round(actualTotal),
      simulatedPnlRupees: Math.round(simulatedTotal),
      evidenceLimit:
        bidBackedTrades === rows.length
          ? 'Target touches use retained executable bids; an observed bid still does not guarantee the final broker fill price.'
          : 'Older trades without auto_quote_snapshots use LTP-only estimates; only bid-backed rows prove the target was executable.',
    },
    null,
    2
  )
);

db.close();
