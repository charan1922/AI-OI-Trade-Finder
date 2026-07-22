/**
 * DB-FREE checks for the cash-target math and the exit-executability rules.
 *
 * These shipped to production (v1.26.0) covered only by scripts/verify-auto-trade.ts,
 * which needs a populated SQLite database and therefore does NOT run in CI — so a
 * green deploy proved nothing about them (AT-REVIEW 2026-07-23). Everything here
 * imports only pure modules (lib/auto-trade/backstops.ts and the stream
 * predicates), so GitHub Actions can gate it on every PR and prod push.
 *
 * Run: pnpm exec tsx scripts/verify-auto-target-stream.ts
 */
import assert from 'node:assert/strict';
import {
  backstopsFromFill,
  backstopsFromProposalFill,
  isRestTargetExecutable,
  targetRupeesForPosition,
} from '../lib/auto-trade/backstops';
import {
  fyersStreamIsSilent,
  fyersStreamNeedsTokenRotation,
  fyersStreamReconnectDelayMs,
  isStreamTargetExecutable,
  STREAM_SILENCE_LIMIT_MS,
} from '../lib/auto-trade/fyers-pnl-stream';

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

// ── Cash-target policy ──────────────────────────────────────────────────────
check('per-trade target is independent of lot count', () => {
  const settings = { profitTargetMode: 'per_trade' as const, profitTargetRupees: 1_100 };
  assert.equal(targetRupeesForPosition(settings, 1), 1_100);
  assert.equal(targetRupeesForPosition(settings, 3), 1_100);
});

check('per-lot target scales with lot count', () => {
  const settings = { profitTargetMode: 'per_lot' as const, profitTargetRupees: 1_100 };
  assert.equal(targetRupeesForPosition(settings, 1), 1_100);
  assert.equal(targetRupeesForPosition(settings, 3), 3_300);
});

check('target premium delivers the requested rupees at the fill', () => {
  // 125 units, ₹1,100 target → ₹8.80 of premium above the ₹128 fill.
  const { targetPremium } = backstopsFromFill(128, 125, 1, 1_100);
  assert.equal(targetPremium, 136.8);
  assert.equal(Math.round((targetPremium - 128) * 125), 1_100);
});

check('stop never goes below the floor and respects the per-lot loss cap', () => {
  const { slPremium } = backstopsFromFill(128, 125, 1, 1_100);
  assert.ok(slPremium >= 0.05);
  assert.ok(slPremium < 128, 'a stop at or above the fill would be nonsense');
});

check('a settings change cannot move a pending trade target', () => {
  // The proposal snapshotted ₹127 → ₹135.80 (₹1,100 on 125 units). The broker
  // filled 1 rupee higher, so the target must ride up by exactly 1 rupee — and
  // must NOT be recomputed from whatever the live setting now says.
  const { targetPremium } = backstopsFromProposalFill(128, 125, 1, 127, 135.8);
  assert.equal(targetPremium, 136.8);
});

check('proposal re-anchor holds for multi-lot positions', () => {
  const { targetPremium } = backstopsFromProposalFill(50, 100, 2, 50, 55);
  assert.equal(targetPremium, 55, 'same fill as proposal → same target');
});

// ── REST target executability (the 2026-07-23 blocker's sibling) ────────────
check('REST target fires when price AND full size are there', () => {
  assert.equal(
    isRestTargetExecutable({ bid: 120, bidQty: 500, targetPremium: 120, qtyUnits: 500 }),
    true,
  );
});

check('REST target does NOT fire on a thin bid at the right price', () => {
  // The exact production failure: ₹120 showing for 5 units against 500 held.
  assert.equal(
    isRestTargetExecutable({ bid: 120, bidQty: 5, targetPremium: 120, qtyUnits: 500 }),
    false,
  );
});

check('REST target does not fire with an unknown book size', () => {
  assert.equal(
    isRestTargetExecutable({ bid: 120, bidQty: null, targetPremium: 120, qtyUnits: 500 }),
    false,
  );
  assert.equal(
    isRestTargetExecutable({ bid: null, bidQty: 500, targetPremium: 120, qtyUnits: 500 }),
    false,
  );
});

check('REST and stream target rules agree on the same book', () => {
  const book = { bid: 120, bidQty: 500, targetPremium: 120, qtyUnits: 500 };
  assert.equal(
    isRestTargetExecutable(book),
    isStreamTargetExecutable({ ...book, bidSize: book.bidQty, bidAgeMs: 0 }),
    'the two exit paths must not disagree about what is takeable',
  );
  const thin = { bid: 120, bidQty: 5, targetPremium: 120, qtyUnits: 500 };
  assert.equal(
    isRestTargetExecutable(thin),
    isStreamTargetExecutable({ ...thin, bidSize: thin.bidQty, bidAgeMs: 0 }),
  );
});

// ── Stream freshness / recovery ─────────────────────────────────────────────
check('stream target rejects a stale depth tick', () => {
  assert.equal(
    isStreamTargetExecutable({ bid: 120, bidSize: 500, targetPremium: 120, qtyUnits: 500, bidAgeMs: 5_000 }),
    false,
  );
});

check('reconnect backoff grows then caps', () => {
  assert.equal(fyersStreamReconnectDelayMs(0), 1_000);
  assert.equal(fyersStreamReconnectDelayMs(1), 2_000);
  assert.equal(fyersStreamReconnectDelayMs(5), 32_000 > 30_000 ? 30_000 : 32_000);
  assert.equal(fyersStreamReconnectDelayMs(99), 30_000, 'must cap, never grow unbounded');
  assert.equal(fyersStreamReconnectDelayMs(-3), 1_000, 'nonsense input must not produce a negative delay');
});

check('token rotation is detected by fingerprint change', () => {
  assert.equal(fyersStreamNeedsTokenRotation('abc', 'abc'), false);
  assert.equal(fyersStreamNeedsTokenRotation('abc', 'def'), true);
  assert.equal(fyersStreamNeedsTokenRotation(null, 'abc'), true, 'unknown state must rotate once');
});

check('silence watchdog ignores a disconnected or idle stream', () => {
  const now = 1_000_000_000;
  assert.equal(
    fyersStreamIsSilent({ connected: false, trackedSymbols: 2, lastActivityMs: now - 600_000, nowMs: now }),
    false,
    'a disconnected socket is the reconnect supervisor’s job, not the watchdog’s',
  );
  assert.equal(
    fyersStreamIsSilent({ connected: true, trackedSymbols: 0, lastActivityMs: now - 600_000, nowMs: now }),
    false,
    'no subscriptions means silence is expected',
  );
});

check('silence watchdog fires only past the limit', () => {
  const now = 1_000_000_000;
  assert.equal(
    fyersStreamIsSilent({
      connected: true,
      trackedSymbols: 2,
      lastActivityMs: now - (STREAM_SILENCE_LIMIT_MS - 1_000),
      nowMs: now,
    }),
    false,
    'a quiet contract must not trigger a recycle',
  );
  assert.equal(
    fyersStreamIsSilent({
      connected: true,
      trackedSymbols: 2,
      lastActivityMs: now - (STREAM_SILENCE_LIMIT_MS + 1_000),
      nowMs: now,
    }),
    true,
    'total silence on a connected socket is a half-open socket',
  );
});

if (process.exitCode === 1) {
  console.error('\nauto-target/stream verification FAILED');
} else {
  console.log(`auto-target/stream verification passed: ${passed} checks`);
}
