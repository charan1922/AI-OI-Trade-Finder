/**
 * Pure, DB-free checks for the candle-freshness rule (lib/priority-refresh/freshness.ts)
 * and the auto-trade stale-candle ENTRY gate (lib/auto-trade/risk/gates.ts).
 * Freshness now proves FINALIZATION (the required completed bucket was written
 * AT/AFTER its close time), so a still-forming bucket reads stale (PR#10 review).
 * No DB / I/O — runs in GitHub CI.
 */
import { DEFAULT_SETTINGS } from '../lib/auto-trade/config';
import { checkEntryGates, type EntryGateInput } from '../lib/auto-trade/risk/gates';
import { FYERS_BUCKET_SEC } from '../lib/fyers/candle-store';
import {
  evaluateFreshness,
  evaluateFreshnessBestEffort,
  requiredCompletedBucket,
  type EqBucketStatus,
} from '../lib/priority-refresh/freshness';

type Check = (name: string, ok: boolean, detail?: string) => void;

const BUCKET = FYERS_BUCKET_SEC; // 300s
const REQUIRED = 1_800_000; // a bucket-start (divisible by 300)
const CLOSE_MS = (REQUIRED + BUCKET) * 1000; // when the REQUIRED bucket closes
const row = (bucketTs: number, updatedAtMs: number): EqBucketStatus => ({ bucketTs, updatedAtMs });

/** A fresh, otherwise-clean gate input (paper mode, inside the window). */
const gbase: EntryGateInput = {
  // The per-lot risk ceiling FAILS CLOSED without a lot size, a live ask and
  // enough displayed size at that ask (PR#18 review), so this fixture must carry
  // all three or every "should allow" case below would fail for the wrong
  // reason. The ₹30,000 lot inherently risks ₹7,500 at a 25% stop, hence the
  // matching ceiling — the ceiling itself is covered with realistic contracts in
  // scripts/premium-stop-checks.ts; these checks are about candle freshness.
  settings: { ...DEFAULT_SETTINGS, mode: 'paper', maxRiskPerLotRupees: 10_000 },
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
  perLotCost: 30_000,
  lotSize: 500,
  askPrice: 60,
  askQty: 500,
  slippagePct: 1,
  spreadPct: 2,
  hasSlSpot: true,
  brokerFundsAvailable: null,
  blockStaleAutoEntry: true,
  candleLatestBucketTs: REQUIRED,
  candleRequiredBucketTs: REQUIRED,
  candleFresh: true,
};

export async function runFreshnessGateChecks(check: Check): Promise<void> {
  {
    let warned = false;
    const metadata = await evaluateFreshnessBestEffort(
      REQUIRED,
      async () => {
        throw new Error('temporary database failure');
      },
      () => {
        warned = true;
      }
    );
    check(
      'freshness metadata: store failure is reported and fails closed without throwing',
      warned && metadata.requiredBucketTs === REQUIRED && metadata.latestBucketTs === null && !metadata.fresh
    );
  }

  // ── Freshness rule (finalization) ──────────────────────────────────────────
  check('freshness: required bucket written AT close → fresh', evaluateFreshness(row(REQUIRED, CLOSE_MS), REQUIRED).fresh);
  check('freshness: required bucket written AFTER close → fresh', evaluateFreshness(row(REQUIRED, CLOSE_MS + 12_000), REQUIRED).fresh);
  check(
    'freshness: required bucket written BEFORE close (still forming) → STALE',
    !evaluateFreshness(row(REQUIRED, CLOSE_MS - 10_000), REQUIRED).fresh
  );
  check('freshness: missing required bucket → stale', !evaluateFreshness(null, REQUIRED).fresh);
  check(
    'freshness: a stored OLDER bucket (wrong start) → stale',
    !evaluateFreshness(row(REQUIRED - BUCKET, CLOSE_MS), REQUIRED).fresh
  );
  check('freshness: NaN required bucket fails closed', !evaluateFreshness(row(REQUIRED, CLOSE_MS), Number.NaN).fresh);
  check(
    'freshness: off-grid required bucket fails closed',
    !evaluateFreshness(row(REQUIRED + 1, CLOSE_MS), REQUIRED + 1).fresh
  );
  check(
    'freshness: future/off-grid stored bucket never matches required → stale',
    !evaluateFreshness(row(REQUIRED + 5 * BUCKET, CLOSE_MS + 999_999), REQUIRED).fresh
  );
  check('freshness: non-finite write time → stale', !evaluateFreshness(row(REQUIRED, Number.NaN), REQUIRED).fresh);
  {
    // requiredCompletedBucket = current forming bucket − one 5-min period.
    const cur = 1_800_300;
    const now = (cur + 100) * 1000;
    check('freshness: requiredCompletedBucket = current bucket − one period', requiredCompletedBucket(now) === REQUIRED, `${requiredCompletedBucket(now)}`);
  }

  // ── Stale-candle entry gate (pure) ──────────────────────────────────────────
  check('gate: fresh candle + normal gates → allow', checkEntryGates(gbase).allow);
  {
    const v = checkEntryGates({ ...gbase, candleFresh: false, candleLatestBucketTs: REQUIRED - BUCKET });
    check('gate: stale candle + block ON → reject', !v.allow && v.reasons.some((r) => r.includes('stale')));
  }
  check(
    'gate: missing candle + block ON → reject',
    !checkEntryGates({ ...gbase, candleFresh: false, candleLatestBucketTs: null }).allow
  );
  check(
    'gate: stale candle + block OFF → existing gates decide (allow)',
    checkEntryGates({ ...gbase, blockStaleAutoEntry: false, candleFresh: false, candleLatestBucketTs: null }).allow
  );
}
