/**
 * Pure, DB-free checks for the candle-freshness rule (lib/priority-refresh/freshness.ts)
 * and the auto-trade stale-candle ENTRY gate (lib/auto-trade/risk/gates.ts).
 * Mirrors final-capped-priority-sector-plan.md §35 (Freshness + the pure
 * Entry-Gate cases). No DB / I/O — runs in GitHub CI.
 */
import { DEFAULT_SETTINGS } from '../lib/auto-trade/config';
import { checkEntryGates, type EntryGateInput } from '../lib/auto-trade/risk/gates';
import { FYERS_BUCKET_SEC } from '../lib/fyers/candle-store';
import { computeCandleFreshness, requiredCompletedBucket } from '../lib/priority-refresh/freshness';

type Check = (name: string, ok: boolean, detail?: string) => void;

const BUCKET = FYERS_BUCKET_SEC; // 300s
const CUR = 1_800_000; // a bucket-start (divisible by 300)
const NOW = (CUR + 100) * 1000; // 100s into the still-forming bucket CUR
const REQUIRED = CUR - BUCKET; // latest completed bucket = 1_799_700

/** A fresh, otherwise-clean gate input (paper mode, inside the window). */
const gbase: EntryGateInput = {
  settings: { ...DEFAULT_SETTINGS, mode: 'paper' },
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
  slippagePct: 1,
  spreadPct: 2,
  hasSlSpot: true,
  brokerFundsAvailable: null,
  blockStaleAutoEntry: true,
  candleLatestBucketTs: REQUIRED,
  candleRequiredBucketTs: REQUIRED,
  candleFresh: true,
};

export function runFreshnessGateChecks(check: Check): void {
  // ── Freshness rule ─────────────────────────────────────────────────────────
  {
    const f = computeCandleFreshness(REQUIRED, NOW);
    check('freshness: latest == required → fresh, age 0', f.fresh && f.ageBuckets === 0, `req=${f.requiredBucketTs}`);
  }
  check('freshness: latest ahead (forming bucket) → fresh', computeCandleFreshness(CUR, NOW).fresh);
  {
    const f = computeCandleFreshness(REQUIRED - BUCKET, NOW);
    check('freshness: one bucket behind → stale, age 1', !f.fresh && f.ageBuckets === 1);
  }
  {
    const f = computeCandleFreshness(REQUIRED - 2 * BUCKET, NOW);
    check('freshness: two buckets behind → stale, age 2', !f.fresh && f.ageBuckets === 2);
  }
  {
    const f = computeCandleFreshness(null, NOW);
    check('freshness: missing candle → stale, age null', !f.fresh && f.ageBuckets === null && f.latestBucketTs === null);
  }
  check('freshness: requiredCompletedBucket = current bucket − one period', requiredCompletedBucket(NOW) === REQUIRED, `${requiredCompletedBucket(NOW)}`);
  check('freshness: NaN clock fails closed (stale)', !computeCandleFreshness(REQUIRED, Number.NaN).fresh);
  {
    // Exactly on a 5-min boundary: now = start of CUR → required = CUR − period.
    const f = computeCandleFreshness(CUR - BUCKET, CUR * 1000);
    check('freshness: exact 5-min boundary handled', f.fresh && f.requiredBucketTs === CUR - BUCKET);
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
