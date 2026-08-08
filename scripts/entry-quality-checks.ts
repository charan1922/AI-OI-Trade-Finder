/**
 * PURE entry-quality checks — no DB, no clocks, no network.
 *
 * Covers the two detectors that now feed the entry bar both AIs read:
 *   • consolidation-breakout.ts — the coil-and-pop structure, whose `pivot`
 *     is offered to the model as an invalidation level. A wrong pivot would
 *     put a stop on the wrong side of a real level, so it is money-touching.
 *   • move-freshness.ts — the "App Since 9:45" read, which decides whether a
 *     candidate's move is still ahead of the trade. It is direction-aware, and
 *     a sign error would invert every bearish verdict.
 *
 * Both are pure, so per the standing rule (see CLAUDE.md, premium-stop) they
 * belong in CI rather than only in the box-only auto-trade bench.
 *
 * Wired into scripts/verify-quant-shadow.ts, which the build workflow runs.
 */
import {
  DEFAULT_CONSOLIDATION_CONFIG,
  detectConsolidationBreakout,
} from '../lib/trade-suggest/consolidation-breakout';
import { classifyMoveFreshness, isStaleMove } from '../lib/trade-suggest/move-freshness';
import { TF_ENDPOINT_URL, TF_ENDPOINTS, TF_PARSED_ENDPOINTS } from '../lib/tf-live/endpoints';
import type { IndicatorBar } from '../lib/signals/indicators';

export type CheckFn = (name: string, ok: boolean, detail?: string) => void;

const STEP = 300; // 5-min buckets, in seconds

/** Build a bar series from [low, high, close] triples, oldest first. */
function bars(rows: [number, number, number, number?][], startTs = 1_000_000): IndicatorBar[] {
  return rows.map(([low, high, close, volume], i) => ({
    bucketTs: startTs + i * STEP,
    open: (low + high) / 2,
    high,
    low,
    close,
    volume: volume ?? 1000,
  }));
}

/** `nowBucketTs` for a series: the bucket AFTER the last bar, so every bar counts as completed. */
const nowAfter = (series: IndicatorBar[]): number => series[series.length - 1].bucketTs + STEP;

/** Six tight bars around 100 (≈1% wide) — a valid coil under the default config. */
const COIL: [number, number, number, number?][] = [
  [99.6, 100.3, 100.0],
  [99.7, 100.4, 100.1],
  [99.6, 100.2, 99.9],
  [99.8, 100.4, 100.2],
  [99.7, 100.3, 100.0],
  [99.7, 100.4, 100.1],
];

export function runEntryQualityChecks(check: CheckFn): void {
  // ── consolidation breakout ────────────────────────────────────────────────
  {
    const series = bars([...COIL, [100.3, 101.6, 101.4, 3000], [101.0, 102.0, 101.7, 2000]]);
    const hit = detectConsolidationBreakout(series, 'bullish', nowAfter(series));
    check('consolidation: tight coil + break + hold is detected', hit != null);
    check(
      'consolidation: pivot is the coil HIGH for a bullish break',
      hit?.pivot === 100.4,
      `got ${hit?.pivot}`
    );
    check(
      'consolidation: volume expansion + tight base grades strong',
      hit?.grade === 'strong',
      `grade ${hit?.grade}, volMult ${hit?.volumeMult}`
    );
    check(
      'consolidation: barsSinceBreakout counts completed bars after the break',
      hit?.barsSinceBreakout === 1,
      `got ${hit?.barsSinceBreakout}`
    );
  }

  {
    // Same coil, but the bar after the break closes BACK INSIDE it. A failed
    // breakout must not be reported as a breakout — this is the fakeout guard.
    const series = bars([...COIL, [100.3, 101.6, 101.4, 3000], [99.9, 101.2, 100.1, 2000]]);
    const hit = detectConsolidationBreakout(series, 'bullish', nowAfter(series));
    check('consolidation: a break that closes back inside the coil is NOT reported', hit == null);
  }

  {
    // Broke on the very last completed bar — real, but nothing has held it yet.
    const series = bars([...COIL, [100.3, 101.6, 101.4, 3000]]);
    const hit = detectConsolidationBreakout(series, 'bullish', nowAfter(series));
    check('consolidation: a break with no hold bar grades unconfirmed', hit?.grade === 'unconfirmed', `grade ${hit?.grade}`);
    check('consolidation: unconfirmed break reports barsSinceBreakout 0', hit?.barsSinceBreakout === 0);
  }

  {
    // A wide, trending range is not a coil, however cleanly price left it.
    const wide = bars([
      [95, 100, 99],
      [96, 101, 100],
      [97, 102, 101],
      [98, 103, 102],
      [99, 104, 103],
      [100, 105, 104],
      [104, 107, 106.5, 3000],
      [106, 108, 107.5],
    ]);
    const hit = detectConsolidationBreakout(wide, 'bullish', nowAfter(wide));
    check('consolidation: a wide trending range is not treated as a coil', hit == null);
  }

  {
    // Bearish mirror: the pivot must be the coil LOW.
    const series = bars([...COIL, [98.4, 99.6, 98.6, 3000], [98.0, 99.2, 98.3, 2000]]);
    const hit = detectConsolidationBreakout(series, 'bearish', nowAfter(series));
    check('consolidation: bearish break is detected', hit != null);
    check('consolidation: pivot is the coil LOW for a bearish break', hit?.pivot === 99.6, `got ${hit?.pivot}`);
  }

  {
    // A bullish coil must never be reported as a bearish setup.
    const series = bars([...COIL, [100.3, 101.6, 101.4, 3000], [101.0, 102.0, 101.7, 2000]]);
    const hit = detectConsolidationBreakout(series, 'bearish', nowAfter(series));
    check('consolidation: a bullish break is not reported for a bearish trade', hit == null);
  }

  {
    // The forming bucket must be excluded — otherwise the detector sees a bar
    // the live engine has not finished recording (lookahead in replay).
    const series = bars([...COIL, [100.3, 101.6, 101.4, 3000], [101.0, 102.0, 101.7, 2000]]);
    const excludingLastTwo = series[series.length - 2].bucketTs;
    const hit = detectConsolidationBreakout(series, 'bullish', excludingLastTwo);
    check(
      'consolidation: bars at/after nowBucketTs are excluded (no lookahead)',
      hit == null,
      'with the breakout bar still forming there is nothing to report'
    );
  }

  {
    // Too few bars to form a base at all.
    const series = bars(COIL.slice(0, 3));
    check(
      'consolidation: too few completed bars returns null, never a guess',
      detectConsolidationBreakout(series, 'bullish', nowAfter(series)) == null
    );
  }

  {
    // Volume is unknowable when the coil printed none — reported as null, and
    // the grade must NOT be promoted to strong on an unmeasured expansion.
    const noVol: [number, number, number, number?][] = COIL.map(([l, h, c]) => [l, h, c, 0]);
    const series = bars([...noVol, [100.3, 101.6, 101.4, 3000], [101.0, 102.0, 101.7, 2000]]);
    const hit = detectConsolidationBreakout(series, 'bullish', nowAfter(series));
    check('consolidation: unmeasurable volume is null, not assumed 1×', hit?.volumeMult === null);
    check('consolidation: unmeasured volume cannot grade strong', hit?.grade === 'confirmed', `grade ${hit?.grade}`);
  }

  check(
    'consolidation: default config keeps the coil ceiling under the tight threshold ordering',
    DEFAULT_CONSOLIDATION_CONFIG.tightBaseRangePct < DEFAULT_CONSOLIDATION_CONFIG.maxBaseRangePct
  );

  // ── move freshness ────────────────────────────────────────────────────────
  {
    const fresh = classifyMoveFreshness({ sinceEntryPct: 1.4, changePctOpen: 1.9, direction: 'bullish' });
    check('freshness: still-running move reads fresh', fresh.profile === 'fresh', fresh.profile);
    check('freshness: freshShare is the post-09:45 share of the day move', fresh.freshShare === 0.74, `got ${fresh.freshShare}`);
  }

  {
    const spent = classifyMoveFreshness({ sinceEntryPct: 0.05, changePctOpen: 2.4, direction: 'bullish' });
    check('freshness: big day move with nothing since 09:45 reads spent', spent.profile === 'spent', spent.profile);
    check('freshness: spent counts as a stale move', isStaleMove(spent.profile));
  }

  {
    const fading = classifyMoveFreshness({ sinceEntryPct: -0.9, changePctOpen: 3.0, direction: 'bullish' });
    check('freshness: giving the move back reads fading', fading.profile === 'fading', fading.profile);
    check('freshness: fading counts as a stale move', isStaleMove(fading.profile));
  }

  {
    // Direction awareness: the SAME raw numbers mean opposite things.
    const raw = { sinceEntryPct: -1.2, changePctOpen: -2.0 };
    const bullish = classifyMoveFreshness({ ...raw, direction: 'bullish' });
    const bearish = classifyMoveFreshness({ ...raw, direction: 'bearish' });
    check('freshness: falling price is fading for a BULLISH trade', bullish.profile === 'fading', bullish.profile);
    check('freshness: the same fall is FRESH for a BEARISH trade', bearish.profile === 'fresh', bearish.profile);
    check(
      'freshness: bearish directional values are sign-flipped',
      bearish.sinceEntryDirectional === 1.2 && bearish.dayDirectional === 2,
      `since ${bearish.sinceEntryDirectional}, day ${bearish.dayDirectional}`
    );
  }

  {
    const unknown = classifyMoveFreshness({ sinceEntryPct: null, changePctOpen: 2.0, direction: 'bullish' });
    check('freshness: a missing 09:45 reference reads unknown', unknown.profile === 'unknown');
    check(
      'freshness: unknown is NOT treated as stale (missing evidence never blocks)',
      !isStaleMove(unknown.profile)
    );
    check('freshness: unknown reports no directional value', unknown.sinceEntryDirectional === null);
  }

  {
    const quiet = classifyMoveFreshness({ sinceEntryPct: 0.05, changePctOpen: 0.2, direction: 'bullish' });
    check('freshness: flat on a flat day is quiet, not spent', quiet.profile === 'quiet', quiet.profile);
    check('freshness: quiet is not a stale move (nothing was spent)', !isStaleMove(quiet.profile));
    check('freshness: freshShare is suppressed on a too-small day move', quiet.freshShare === null);
  }

  {
    const nan = classifyMoveFreshness({ sinceEntryPct: Number.NaN, changePctOpen: 2, direction: 'bullish' });
    check('freshness: a non-finite input reads unknown, never a number', nan.profile === 'unknown');
  }

  // ── TradeFinder endpoint registry ─────────────────────────────────────────
  // A typo in one of these URLs fails SILENTLY: the collector records a capture
  // error every 5 minutes forever and nothing else looks wrong. Pin them.
  {
    const expected: Record<string, string> = {
      'all_sector': 'https://tradefinder.in/api_be/data/order/all_sector',
      'daily-index': 'https://tradefinder.in/api_be/data/order/daily-index',
      'market_pulse': 'https://tradefinder.in/api_be/data/market_pulse',
    };
    check(
      'tf endpoints: exactly the three feeds this app actually uses are captured',
      TF_ENDPOINTS.length === 3 && Object.keys(expected).every((e) => (TF_ENDPOINTS as readonly string[]).includes(e)),
      TF_ENDPOINTS.join(', ')
    );
    check(
      'tf endpoints: sector_scope (TF\'s own, unrelated to our /sector-scope page) is NOT captured',
      !(TF_ENDPOINTS as readonly string[]).includes('sector_scope')
    );
    for (const [endpoint, url] of Object.entries(expected)) {
      check(`tf endpoints: ${endpoint} URL is exact`, TF_ENDPOINT_URL[endpoint as keyof typeof TF_ENDPOINT_URL] === url);
    }
    check(
      'tf endpoints: every endpoint has a URL (no undefined fetch target)',
      TF_ENDPOINTS.every((e) => typeof TF_ENDPOINT_URL[e] === 'string' && TF_ENDPOINT_URL[e].startsWith('https://'))
    );
    check(
      'tf endpoints: only the two confirmed-schema feeds are marked parsed',
      TF_PARSED_ENDPOINTS.length === 2 &&
        TF_PARSED_ENDPOINTS.includes('all_sector') &&
        TF_PARSED_ENDPOINTS.includes('daily-index'),
      'market_pulse is captured RAW until a real payload is inspected'
    );
  }
}
