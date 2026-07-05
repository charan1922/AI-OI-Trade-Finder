---
type: Index
title: Models
description: >
  The R-Factor engine (how the 12 factors blend into a 1–8 strength + a
  buy/sell/neutral bias) and the shared normalization primitives every factor
  uses.
resource: lib/r-factor/engine.ts
tags: [models, r-factor, engine, index]
timestamp: 2026-07-05T00:00:00Z
---

# Models

- **[r-factor.md](r-factor.md)** — the orchestrator: run all 12
  [factors](../factors/index.md), blend their strengths (renormalized over
  available factors), scale to 1–8, and derive direction from a weighted
  majority vote.
- **[normalization.md](normalization.md)** — the pure math primitives
  (`clamp`, `scoreFromRatio`, `scoreFromMagnitude`, `direction`, `pctChange`)
  that turn raw market numbers into comparable `[0,1]` scores.

> The R-Factor here is the **simulator's** self-contained 12-factor library
> (`lib/r-factor/`). It is a different design from the parent project's V4
> ensemble described in the top-level `CLAUDE.md` — when they disagree, this
> bundle documents the simulator code, which is what runs.
