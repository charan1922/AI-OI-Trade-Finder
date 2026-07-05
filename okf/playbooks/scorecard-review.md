---
type: Playbook
title: Same-day scorecard + EOD leaderboard
description: >
  After 15:30 (or on request), score today's calls from fyers_candles —
  favorable/adverse spot moves (DOWN is favorable for PE), and how many moved
  ≥1% favorably. Then the EOD TF-style leaderboard rank. Must run same-day.
resource: lib/trade-suggest/review.ts
tags: [playbook, scorecard, review, leaderboard]
timestamp: 2026-07-05T00:00:00Z
---

# Scorecard + leaderboard

## Same-day scorecard (must run same day)

```bash
curl -s -X POST http://localhost:5001/api/trade-suggest \
  -H "Content-Type: application/json" -d '{"action":"review"}'
```

Per suggestion: direction, spot at call, **max favorable** move, **max adverse**
move, close vs call — all in spot terms. **For PE picks the favorable direction is
DOWN**, so read `maxDownPct` as the win. Summarize: how many of today's calls
moved ≥ 1% favorably before 15:30. Reads equity candles after `suggestedAt` from
`fyers_candles` — which **clears overnight**, so this MUST happen the same day
([data-sources/fyers.md](../data-sources/fyers.md)).

## EOD leaderboard (once bhavcopy is synced)

```bash
curl -s "http://localhost:5001/api/trade-suggest?view=leaderboard"
```

Top names by the parent-validated spread-linear model (`R = 1.56 × spread ratio`
— TF's EOD fingerprint) plus `suggestionRanks` (each pick's rank; null = didn't
rank). Picks in the top ~10 mean the live scan agreed with TF's EOD view;
consistently unranked picks mean the [gates](../engine/gates.md) need tuning. The
`turnoverRatio` column is context only (turnover terms degrade the TF match).

## Weekly tune-up

```bash
curl -s -X POST http://localhost:5001/api/trade-suggest \
  -H "Content-Type: application/json" -d '{"action":"stats","days":30}'
```

Hit-rate (≥1% favorable), avg favorable/adverse excursion, by-rank / by-score
buckets. If high-score buckets don't outperform low, the [config](../engine/gates.md)
thresholds need tightening — propose changes but apply only with the user's OK,
and validate on the [replay benchmark](../method/point-in-time-replay.md) first.

## Related

- [morning-scan.md](morning-scan.md) · [ground-truth/tf-fingerprint.md](../ground-truth/tf-fingerprint.md) · [method/ml-roadmap.md](../method/ml-roadmap.md)
