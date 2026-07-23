# R-Factor V2 shadow measurement

## Status

R-Factor V2 is **measurement only**. It does not select candidates, approve an
entry, place an order, set a stop/target, or exit a position. The existing
R-Factor and Auto Trade behavior continue unchanged.

The purpose of the shadow is to collect enough same-time evidence to replace
the current hand-tuned R-Factor only after an honest out-of-sample evaluation.

## Why V2 exists

The current score mixes activity and direction and has large historical data
gaps. In the retained database, futures OI factors are usually available, but
call OI, put OI, PCR, option volume, and full strike evidence are mostly absent.
That makes a TradeFinder-like number impossible to validate from the existing
rows alone.

V2 fixes the measurement design before changing trading:

- activity strength and direction are separate outputs;
- a strong bearish move can score high without becoming a bullish signal;
- missing evidence lowers an explicit coverage percentage and contributes zero
  against fixed weights, instead of silently making the remaining inputs look
  more important;
- turnover prefers this stock's own same-clock history in prior sessions;
- every "pace" number carries the kind of denominator it actually used, so an
  estimate can never be mistaken for a measurement;
- rank and percentile are withheld when comparable coverage is below 55%;
- the old R-Factor, V2 inputs, factor breakdown, coverage, direction, rank, and
  percentile are stored together for later comparison.

## The two scores, and why ranking uses the smaller one

Each name gets two activity numbers:

- **`activityScore`** (1–8, shown on `/live`) — everything measured, including
  option-chain evidence when it exists.
- **`comparableActivity`** — the factors *every* name can supply from the live
  poll alone. Option evidence is excluded.

**Ranking, percentile, and the option-chain shortlist all use
`comparableActivity`.** This is deliberate and it fixes a real feedback loop:
option chains are fetched only for the strongest few names, and option evidence
can add up to 15% of the total score. Ranking on the full score would mean the
names already enriched score higher *because* they were enriched, stay in the
top few, and get enriched again — while a newly active name sits structurally
capped below them and can never overtake. Ranking on the comparable score breaks
that loop. `verify:r-factor-v2` asserts it directly.

Because of this, a normal row shows overall coverage below 100% (no option
chain) while still being fully ranked. The tooltip shows both numbers.

## Per-stock normalization

A 2× turnover day in a habitually quiet stock is a much bigger event than 2× in
one that swings every day, and a single shared ratio curve cannot tell them
apart. Where a stock has at least 8 prior sessions of its own same-clock history,
turnover is scored as a **robust z-score** — `0.6745 × (value − median) / MAD` —
against that stock's own spread. Median and MAD are used rather than mean and
standard deviation so one violent session in a stock's history cannot inflate its
own "normal" and hide a genuine outlier today.

With too little history the z is withheld and the ratio curve is used instead,
and the factor says which one it was.

## Sector-relative activity

A name is also scored against the measured peers in its sector from the same
poll. Peer context **excludes the stock itself**, so a name can never justify its
own sector-relative score or vote twice on its own direction. A sector needs at
least 3 measured peers before the comparison is used at all.

## Direction

Direction is a separate weighted vote, never a by-product of activity:

| Vote | Weight |
| --- | --- |
| Price change | 0.22 |
| Price × futures-OI quadrant | 0.20 |
| NSE OI slope (confirms the priced side only) | 0.08 |
| Depth imbalance | 0.10 |
| Sector peer bias | 0.10 |
| Option-chain flow | 0.30 |

Two rules matter here. The OI-slope vote can only *confirm* a side the price
already implies, so when the price move is unknown it is **skipped entirely**
rather than counted as a zero — a zero vote would quietly drag every unpriced
name toward neutral. And `directionConfidence` scales with how much of the vote
weight was actually available, so a side backed by two inputs never looks as
certain as one backed by six.

## Option-chain evidence

Full option-chain evidence is fetched only for the six strongest shadow
candidates, with at most twelve names retained by the worker. It is deliberately
low priority:

- it waits while live/interactive Dhan quote work is pending;
- it gives up after 15 seconds rather than create a queue ahead of live quotes;
- requests are spaced by at least four seconds (Dhan allows one unique
  option-chain request every three);
- each symbol is refreshed at most once every five minutes;
- cached evidence is used for at most ten minutes;
- every qualifying near-money CE and PE leg used by the aggregate is stored,
  including OI, previous OI, volume, previous volume, premium, previous close,
  IV, Greeks, bid, and ask.

**Moneyness weighting.** Alongside the raw OI PCR there is a delta-weighted PCR,
so a wall of cheap far-out-of-the-money contracts cannot masquerade as
conviction. Direction weighting is economic too: each leg counts by
`√(premium × volume) × OI-build share × |delta|`, not by raw contract count.

**The pace baseline.** Traded option premium is compared to this underlying's own
same-clock median from retained evidence once at least 3 prior sessions exist
(`same-time`). Until then it falls back to the previous full session scaled by
the fraction of today elapsed (`prior-session-linear`) — which is a known-weak
assumption, because real intraday volume is U-shaped rather than even. When only
the estimate is available the score deliberately shifts weight onto the OI level
change, which needs no assumption about how activity spreads through the day.
The kind used is stored on every row.

## Gamma evidence — recorded, never scored

Each option snapshot also retains an OI-weighted gamma reading, reusing the
existing `lib/signals/gex.ts` proxy so there is one gamma convention in the
codebase: net call-minus-put share, the strike holding the largest net
concentration, its distance from spot, and gross gamma.

**None of it feeds activity, direction, or any trading decision.** Public OI plus
a model gamma cannot reveal who is actually long or short, so the call-minus-put
sign is an analytical convention, not dealer inventory, and it predicts neither a
range nor a breakout. It is retained purely so the evaluation harness can later
test whether proximity to a gamma concentration relates to a breakout running or
stalling. `verify:r-factor-v2` asserts that changing the gamma inputs leaves the
activity and direction scores byte-identical.

## Performance: nothing may block a quote

The `/live` quote route is on the money path — `lib/trade-suggest/engine.ts`
always calls it with `fresh: true` so the scanner never reads a stale cache.
Every millisecond spent in the shadow therefore lands on the path that produces
real trade decisions.

The same-clock baseline query costs roughly 230ms over a season of intraday
history and grows with it, so it is **never awaited on a request**: it is served
from a cache refreshed in the background, keyed to a 5-minute clock bucket (well
inside the ±10 minute window the query already tolerates), and dropped entirely
once older than 15 minutes. The snapshot write is fire-and-forget. What remains
inline is pure arithmetic over data already in memory.

## Retention

Both shadow tables keep the newest 20 sessions, matching the candle and rank
policy, pruned by the Fyers poller after each recorder cycle
(`pruneRFactorV2Snapshots`). Without this the snapshot table would be the
fastest-growing table in the database: one row per symbol per minute, each
carrying two JSON payloads.

## Where to see it

On `/live`, the `R V2 Shadow` column appears immediately after `App R-Factor`.
The number is activity on the 1–8 scale. The arrow is independent direction.
Hovering shows both coverage numbers, same-poll rank/percentile, option-chain
status, and each contributing or missing factor.

The raw audit tables are:

- `rfactor_v2_snapshots`
- `rfactor_v2_option_snapshots`
- `rfactor_v2_bucket_owner` — which universe owns each minute

They are created safely with `CREATE TABLE IF NOT EXISTS` on first shadow write,
extended with `ALTER TABLE ... ADD COLUMN` guards for installs that predate a
field, and are also declared in the Prisma schema.

## One universe owns a minute, and the database decides it

`activityRank`, `activityPercentile` and `universeSize` are all relative to the
symbol list that was computed. `/live` sections each poll a different list while
the scanner polls the full universe, so a minute holding two of them would store
two incompatible definitions of "rank 1" under identical column names.

A minute is therefore owned by the largest universe seen in it, identified by an
exact symbol-set fingerprint (`universeKey`). Ownership is read from
`rfactor_v2_bucket_owner` **inside the same transaction** that deletes and
replaces the minute — never from a remembered "last bucket", which cannot answer
the question after a process restart (memory forgets an owner whose rows are
still in SQLite) or when writes arrive out of clock order (the route awaits
several I/O steps between stamping its timestamp and firing the write, so a
larger 10:00 batch can land after a smaller 10:01 one).

Note that `universeSize` counts only the RANKABLE names, while ownership
compares `inputUniverseSize`, the total computed. They are different numbers and
are stored separately rather than conflated.

## Versions, and why there are two of them

- `modelVersion` + `configHash` on each snapshot — the engine's scoring
  definition. The evaluator refuses to average across them.
- `optionEvidenceVersion` on each option snapshot — the definition of the
  STORED option fields, versioned independently.

The second exists because same-clock option baselines compare today's
`premiumValue` against retained ones. `v2.2` redefined that field from
`LTP × volume` to `VWAP × volume`, so a baseline built from older rows would be
apples-to-oranges — and the snapshot it fed would still carry the current model
version, leaving nothing downstream able to detect it. Baselines therefore
require an exact version match; legacy rows default to `unknown` and never
qualify, so the dataset self-heals instead of needing a manual purge.

## Commands

```text
pnpm verify:r-factor-v2         # 31 deterministic checks, no DB or network
pnpm verify:r-factor-v2-store   # 22 DB round-trip checks, isolated temp SQLite
pnpm eval:r-factor-v2           # read-only out-of-sample evaluation
pnpm typecheck
pnpm lint
```

Both verify suites run in CI. The store suite uses a throwaway database in a
temp directory, so it proves what the pure checks cannot: that the tables and
their additive columns really create, that the batched SQL parameter counts hold
past one chunk, that a minute keeps exactly one universe across a process
restart and out-of-order arrivals, that a failed batch rolls back rather than
leaving a truncated minute, and that retention keeps the newest 20 sessions.

`eval:r-factor-v2` joins shadow snapshots to retained 5-minute candles and asks
the only question that matters: when V2 said a name was highly active and leaning
a direction, did the underlying actually move that way over the next 15/30/60
minutes — by more than for a name V2 was not excited about, on days V2 was not
tuned on? It holds out the most recent sessions, and it clusters by day, because
snapshots are one row per symbol per minute and consecutive rows overlap heavily
— raw row counts are **not** independent samples and their standard errors would
be far too small. It reports spot moves only: no option premium, spread, or
slippage. It accepts `--db=` so it can also run against a pulled production clone.

It refuses rather than quietly averaging incomparable rows. Mixed model versions
exit 1 with instructions to pin one (`--model-version=`, which also refuses if
the prefix still spans two config hashes), and any minute holding more than one
universe is excluded **before** dates, the train/test split and the activity
thresholds are derived — warning about it after the tables are printed would be
too late, since every number above would already be built from mixed rows.
Thresholds come from training sessions only, and horizons are measured from each
snapshot's exact `capturedAt`, not its floored minute.

## Why TradeFinder cannot calibrate this

The retained TradeFinder captures (`tf_snapshots`: 639 rows over 8 dates,
2026-03-19 to 2026-04-02) **do not overlap our intraday history at all**
(`oi_intraday` starts 2026-06-17). Zero shared dates. V2's inputs are all
live-intraday — turnover pace, OI velocity, depth imbalance, option chain — and
none of them exist for March, so the TF rows cannot calibrate or validate V2
unless TF is captured alongside live sessions going forward.

This is a hard constraint, not a preference. V2 must be judged on forward
outcomes, never on agreement with a third-party screenshot.

## Before V2 may affect trading

Do not promote V2 from shadow based on one visible winning trade or by forcing
its values to equal a third-party screenshot. Require all of the following:

1. enough full live sessions with option evidence and same-time baselines;
2. timestamp-aligned review against retained candles and executable quotes;
3. frozen parameters before evaluating later sessions;
4. out-of-sample evidence that high-activity, aligned-direction candidates
   improve target/stop outcomes after spread and slippage;
5. no material Dhan quote latency or rate-limit regression;
6. a separate reviewed change that explicitly wires V2 into trading.

Until then, the shadow is an evidence recorder, not a profit promise.
