---
type: Index
title: Playbooks
description: >
  Operating procedures for the live-trading agents — the morning scan, how to
  read a near-ATM CE vs PE setup, and the same-day scorecard. Grounded in the
  trade-suggest skill.
resource: .claude/skills/trade-suggest/SKILL.md
tags: [playbooks, procedures, index]
timestamp: 2026-07-05T00:00:00Z
---

# Playbooks

How an agent actually operates the [trade-suggest engine](../engine/index.md).
The authoritative procedure is the trade-suggest skill (`.claude/skills/
trade-suggest/SKILL.md`); these docs are the knowledge-layer summary.

- [morning-scan.md](morning-scan.md) — one scan pass, how to present ≤3 picks, loop cadence
- [near-atm-ce.md](near-atm-ce.md) — the bullish setup (buy CE)
- [near-atm-pe.md](near-atm-pe.md) — the bearish setup (buy PE)
- [scorecard-review.md](scorecard-review.md) — the same-day outcome review + EOD leaderboard

## Non-negotiables (every playbook)

- **Never** place, modify, or cancel orders. This is signal analysis, not advice.
- **Never** fabricate premiums, Greeks, win-rates, or any number not in the JSON.
- **Never** use `force=1` in loop mode ([window.md](../engine/window.md)).
- Always end a suggestion with: analysis only, not financial advice, no order placed.
