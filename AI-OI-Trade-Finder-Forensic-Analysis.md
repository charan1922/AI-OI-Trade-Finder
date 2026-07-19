# AI-OI Trade Finder — Deep Forensic Analysis & Super-Intelligence Roadmap

**Date:** 19 July 2026 · **Scope:** Full codebase (~50k lines TypeScript, 294 source files) + Auto-Trade & AI Commentary Curriculum (30 pp) · **Method:** Five parallel line-by-line subsystem audits (data engine, scanner/signals, auto-trade/risk, AI layer, platform/security)

---

## Part 0 — Executive Summary

The app is a well-architected NSE F&O options auto-trader built on the design law **"the AI proposes, the code disposes."** The core is sound: a 5-minute Fyers poller records candles/OI for ~167 F&O names, a pure-rules scanner funnels them to picks via R-Factor + OI + breakout gates, an AI (Azure OpenAI or MiMo) decides within a fixed tool menu, deterministic gates re-verify every money-touching action, and everything is written down (candles, decisions, prompts, token counts). Application-layer authz is unusually good for a solo project: default-deny mutations, spoof-proof role header, injection-clean db-explorer, fail-closed NaN handling in gates.

The risk concentrates in four places:

1. **Position-level truth is missing.** Reconciliation is order-level only; a stale `open` row after a broker-side square-off can trigger a next-day SELL → naked short (the single biggest hole vs "never an unknown position").
2. **Silent decay & fail-open trading-day protection.** Master contracts sync is manual-only; the holiday table can be empty (fails OPEN, letting the trading path run on stale data); the bhavcopy day-marker advances even when nothing was synced.
3. **The benchmark of record no longer mirrors production.** The live scanner runs a chaotic-open gate and regime-scaled confidence thresholds that the replay harness doesn't model — every replay/autoresearch ΣR figure validates a different scanner than the one deployed.
4. **Everything rests on one env var.** `APP_PASSWORD` unset = every request is admin (can trade, dump the DB, reveal broker tokens). No login rate limiting, no tests in CI, no backups, no down-alerting.

**Verdict:** paper mode is safe to continue; before approval/live mode, fix the Critical + High items in Part 2 (est. small, well-bounded changes — most are one-function fixes) and adopt Tier 0/1 of the roadmap in Part 4.

---

## Part 1 — Architecture As-Built (verified against the curriculum)

### 1.1 The chain of command (delivered as designed)

```
Data Engine → Scanner → AI → Safety Gates → Broker
 (collects)  (shortlists) (decides) (verifies)  (executes)
```

- **Boot:** `instrumentation.ts` → file logging → `startFyersPoller()` (`lib/fyers/poller.ts`) + `startGuardLoop()` (60 s fast position guard). Cross-process singleton via `runtime_leases` (TTL leases, fail-closed on DB error).
- **Poller tick (5-min grid + 10 s):** token warm-up 08:40–09:15 IST (Fyers + Dhan, TOTP chains, tokens cached to disk); market hours → priority-first candle/OI download (open positions & picks first, concurrency 3), then `runAutonomousCapture` (scan → auto-trade pass → commentary fallback), then background tail for the remaining ~160 names; after 16:00 → EOD scorecard; after 01:00 → bhavcopy sync trigger.
- **Rate discipline:** Fyers serial gate ≥350 ms (~2.8 r/s), Dhan quote gate ≥1500 ms (0.67 r/s), NSE cookie-cached client, 429 → escalating cooldowns. Viewer quotes cached 6.5 s with request coalescing; scanner always `fresh:true`. Matches the curriculum's politeness promise.
- **Scanner funnel** (`lib/trade-suggest/engine.ts` `runTradeSuggest`): window (09:40–11:00 runtime-tunable) → 5 NSE movers feeds as candidates → one batched fresh quote → gates in order: illiquidity → neutral bias → R-Factor ≥ 3.6 → confidence ≥ regime-scaled floor → OI evidence (futures ≥1.1× 20d **OR** NSE combined ≥5% + optShare ≥10% + ₹5 Cr premium) → turnover → price-agrees-with-bias → Supertrend → VWAP → quiet-setup → chaotic-open (ratio > 5 skip). Composite score weights match the curriculum exactly (.22/.20/.18/.12/.08/.08/.07/.05). Plans: spot SL = last completed 5-min low/high with 0.35% noise floor, target = 2R; premium SL = tighter of 60%×LTP and LTP−1500/lot; target = LTP+5000/lot.
- **AI layer:** one brain per cycle enforced in the poller — the auto-trade decision pass's note IS the commentary; standalone MiMo narrator only as fallback. Tool loop (max 10 steps) over 9 tools; every mutating tool re-runs `checkEntryGates`/`checkStopMove` in code against fresh DB + fresh quote; picks resolvable only from this cycle's scan; lots hardcoded to 1. Prompts versioned in `prompt_versions`; every pass records provider/model/tokens in `auto_decisions`.
- **Risk gates** (`lib/auto-trade/risk/gates.ts`): pure function, NaN fail-closed sweep on all 14 numeric inputs, two-key live rule (setting + `AUTO_TRADE_LIVE_ENABLED`), stops only tighten, exits never blocked. Position guard runs before the AI every cycle + a 60 s fast guard loop: premium stop/target, spot stop/target, 15:12 square-off, +30% breakeven trail, Supertrend momentum exit.
- **Execution** (`lib/auto-trade/execution.ts`): DB row first, atomic idempotency claim (UNIQUE `idemKey`), SHA-256 correlation tag persisted pre-submit, broker adapters (Fyers SDK / Dhan REST / paper fills at real bid-ask), ambiguity-classified errors, `reconcileUnresolvedOrders` on restart and every pass. Exits route to the opening venue.
- **Record-keeping:** every table promised in the curriculum exists and is written (`fyers_candles` 20 sessions, `oi_intraday`, `rank_snapshots`, `trade_suggestions`, `auto_decisions`, `auto_trades`/`auto_orders`, `trade_commentary`, `prompt_versions`). EOD `reviewToday()` grades picks maxUp/maxDown/close pct from the suggestion moment.

### 1.2 Notable divergences from the curriculum (deliberate but undocumented drift)

| Curriculum says | Code ships | File |
|---|---|---|
| ~50 stocks | ~167 (all non-avoid F&O) | `lib/fyers/symbols.ts` |
| Max 3 trades/day | Default 2 (clamp 1–4) | `lib/auto-trade/config.ts` |
| ₹25,000 capital cap | Default ₹60,000 (clamp ₹10k–₹200k) | same |
| ₹2,500 loss halt | Default ₹3,000 | same |
| Spread reject > 8% | Default 3% (stricter) | same |
| Max 7 picks shown, "1–3 in practice" | MAX_PICKS = 7 | `lib/trade-suggest/config.ts` |
| Gate 2: futures OI **AND** live combined OI | **OR** — either path passes | `engine.ts:606` |
| 12-factor R-Factor | Only ~8 factors can ever be available live (options factors structurally absent — no option chain on live path) | `rfactor-inputs.ts` |
| Extended ×0.6 penalty | Dormant — `EXCLUDE_EXTENDED=true` hard-bans instead | `config.ts` |
| Fixed 09:45–11:00 window, 15:12 square-off | Runtime-tunable (clamped) settings | `lib/auto-trade/settings.ts` |
| Guard = stops/targets/square-off | Plus two undocumented exits: +30% breakeven trail, Supertrend flip | `position-guard.ts` |

---

## Part 2 — Forensic Findings: Issues & Defects (consolidated, ranked)

### CRITICAL

**C1. No broker position-level reconciliation → possible naked short.** `getOpenTrades()` has no date filter and the guard never checks `trade.date` vs today; adapters have no `getPositions()` at all. Scenario (live): server dies 15:05 → broker auto-squares the intraday position 15:26 → DB row stays `open` → next morning a premium stop trips → MARKET SELL on a position that no longer exists. *Fix: add `getPositions()` to the adapter interface; cross-check every reconcile pass; auto-close rows the broker shows flat.* (`lib/auto-trade/risk/position-guard.ts`, `store.ts:311`)

**C2. Holiday protection fails OPEN and can be entirely absent.** `market_holidays` is only populated when the market-calendar page is visited; `isMarketHoliday` soft-fails open; the CSV covers only 2025–2026. Fresh deploy + weekday NSE holiday → scanner + auto-trade run against stale NSE/Dhan data that statically serves the last session → entries attempted on a closed market. *Fix: seed holidays at boot; fail CLOSED for the trading path; add NSE live market-status as second opinion.* (`lib/fyers/poller.ts:168`, `lib/backtest/trading-calendar.ts`)

**C3. Master-contracts sync is manual-only and non-transactional.** Nothing automatic refreshes the Dhan scrip master; expiries roll out of the table silently (FUT resolution → null, no OI recorded, strikes unfindable) and the destructive `DELETE FROM master_contracts` + chunked inserts has no transaction (crash mid-sync = empty table until a human notices). *Fix: nightly `forceSync()` in the EOD branch inside a transaction; alert if row count drops >10%.* (`lib/historify/master-contracts.ts:47,193`)

**C4. Auth collapses to full-admin if `APP_PASSWORD` is unset.** `proxy.ts` returns `admin` for every request when the var is empty — the entire internet could place orders, dump the DB (`/api/db-explorer/dump`), and reveal broker JWTs (`/api/*/token?reveal`). *Fix: refuse to boot in production without `APP_PASSWORD`.* (`proxy.ts:88`, `lib/auth/server.ts`)

### HIGH

**H1. Exit-order claim is not crash-safe → permanent exit deadlock.** `claimExitOrder` inserts the SELL row without a `correlationId` (written only after, `execution.ts:361`); a crash in between leaves a `sent` order with no id and no tag — reconcile can never resolve it, and the pending SELL blocks all future exit attempts on that trade forever. The guard silently retries into a wall. *Fix: include correlationId in the claim INSERT (entry path already does).* (`store.ts:472`, `execution.ts:358`)

**H2. Azure calls have no effective timeout → AI layer can die silently.** `ipv4Fetch` drops `init.signal`, so the SDK's abort-based timeout can't cancel the socket; no `Promise.race` deadline on the pass. A hung endpoint → the engine lease renews forever → every subsequent cycle skipped ("previous pass still running") until restart. Guard still protects exits, but decisions/commentary stop with no alarm. *Fix: honor abort signal; hard 3-min deadline on `runToolLoop`.* (`lib/ai-assistant/ipv4-fetch.ts:10-56`, `providers.ts`)

**H3. Replay benchmark ≠ live scanner.** The chaotic-open gate is ON live but absent from `replay-lib.ts`; the regime confidence multiplier is live-only (and non-deterministic — "first symbol with ≥30 bars" from feed order proxies the whole market); runtime toggles aren't snapshotted; replay caps 2 trades/day vs live 7 picks. Every autoresearch acceptance is validating a scanner that isn't the one shipped. *Fix: port both gates into replay variants; persist the effective toggle set per scan.* (`config.ts:127`, `engine.ts:443-460`, `replay-lib.ts`)

**H4. Bhavcopy day-marker advances on any HTTP 200, even when nothing synced.** Contradicts its own doc comment; if NSE publishes late, the next trading day runs with baselines shifted one session — OI level, prev-day breakout levels, turnover pace all silently skewed. *Fix: only set `lastBhavcopyDate` when `latestDate` equals the expected session.* (`poller.ts:643-679`)

**H5. TF backtest defects undermine the evidence base.** (a) `ENTRY_BAR_INDEX=6` assumes contiguous bars from 09:15 — gapped option series produce entries at wrong times/prices; (b) `downloadAllTFData` `break`s after one option per symbol — second trades silently drop (survivorship); (c) ranking universe = the TF-selected book itself (top-10 of ~17 is circular). (`backtest-evaluator.ts:764+`, `data-downloader.ts:587`)

**H6. Kill switch frozen during an in-flight AI pass.** Settings are read once per pass and captured; flipping the kill switch mid-pass doesn't stop a `place_entry_order` later in the same pass. *Fix: re-read killSwitch/mode inside every mutating tool.* (`engine.ts:76`, `tools/execute.ts:237`)

**H7. No login rate limiting; zero tests; no CI gate; no backups.** Unlimited password attempts against the single secret; no `*.test.ts` anywhere; CI builds and pushes the image without typecheck/lint/tests; no scheduled DB/EBS snapshots; Sentry env var exists but is never initialized; no dead-man alerting if the box is down during market hours.

**H8. Secrets hygiene.** Dhan PIN + live TOTP go into a query string (logged by any proxy in the path); broker JWTs cached world-readable 0644 on disk; the SQLite DB with full trade history was at one point tracked via Git LFS in a repo whose .gitignore says "THIS REPO IS PUBLIC." (`lib/dhan/auth.ts:96`, `lib/fyers/auth.ts:32`)

### MEDIUM (selected — highest impact)

- **M1. `oi_intraday` grows unbounded** — `pruneOiIntraday` exists but has zero callers; the hottest table on the /live path grows millions of rows. (`lib/signals/oi-intraday.ts:318`)
- **M2. OI attach lands on drifting buckets** — attached at `Date.now()` during a ~3-min tail walk, not the tick bucket; late symbols systematically skewed one bucket; 15:30 tick writes OI into a phantom bucket with no candle. (`poller.ts:420`)
- **M3. Guard can go silently blind** — `fetchOptionQuotes` swallows all errors (Dhan outage = premium stops unchecked, no alert); `latestSpot` has no freshness bound (stalled poller = hours-old spot, stops fire late/never). (`quotes.ts:63,78`)
- **M4. Review scorecard flatters itself** — the bar containing the suggestion is excluded (first-5-min adverse excursion never measured); same-day-only (missed day = grades lost forever = survivorship in the calibration loop); "hit" = +1% favorable any time, even after being stopped first; premium-level outcomes never graded. (`review.ts:38`, `store.ts`)
- **M5. Range-spread factor morning bias** — session-so-far range vs full-day 20d baseline with no time-of-day adjustment; every quiet name gets a "coiled" bump on the heaviest-weighted factor (.18) exactly during the entry window. (`range-spread.ts:44`)
- **M6. OI urgency from two points** — velocity/accel from the last two 1-min prints of a sluggish feed; one quirky print saturates a .18-weighted composite component. (`oi-intraday.ts`)
- **M7. OI magnitude factors reward unwinds** — |change| scoring lets collapsing OI (−8%) add strength toward the 3.6 gate while positions exit.
- **M8. Fyers unresolved orders can't cross midnight** — day-book-only lookups + give-up path requires `brokerOrderId == null` → overnight `sent` orders limbo forever. (`fyers-adapter.ts:254`, `execution.ts:520`)
- **M9. Paper `getOrderState` is a stub** — returns `filled/null` for any id; crashed paper orders stay `sent` forever, corrupting the paper track record used for the go-live decision. (`paper-adapter.ts:42`)
- **M10. Telegram callback auth uses chat id, not presser id** — in a group chat, any member can Approve/Reject/kill/mode-live; no `update_id` dedup; no `answerCallbackQuery`. (`webhook/route.ts:39`, `handlers.ts`)
- **M11. Executed orders can vanish from the audit trail** — `insertDecision` runs only after the tool loop resolves; a mid-loop throw after `place_entry_order` loses the pass's trace/reasons/tokens; the poller then runs a second "fallback" AI call for a cycle where the brain already acted. (`engine.ts:205`)
- **M12. Fill quantity never checked vs ordered** — a partial TRADED fill would be exited at full `lotSize×lots` → oversell. (`execution.ts:86`)
- **M13. Give-up path can free the daily slot while the broker holds the position** — enabling a replacement trade that exceeds the real caps. (`execution.ts:519`)
- **M14. Money stored as Float** everywhere (premiums, P&L, turnover) — should be integer paise; `auto_trades` lacks a status index for the guard's hot scan.
- **M15. Realized P&L omits fees/brokerage/STT** (~₹50–100/round trip) — paper results overstated.
- **M16. Opening range declared final one bar early live** (09:40 bar still forming) — live-vs-replay divergence at the window's first tick. (`session-context.ts:56`)
- **M17. Viewer-triggerable Fyers quota burn** — `/api/live/candles` enrolls junk symbols into the universe with no F&O validation. (`candles/route.ts:40`)
- **M18. EOD closing-snapshot freeze race** — first post-market poll at 15:31 can freeze a partial board while the poller is still writing until ~15:33; first-write-wins, never recomputed. (`closing-snapshot.ts:199`)
- **M19. ₹1,500/lot worst case not actually guaranteed** — spot SL is primary; nothing constrains spot-stop loss ≤ ₹1,500; the premium backstop caps loss only if it's the order that executes.
- **M20. No unrealized-loss halt** — the daily halt is realized-only; a deep-red open position + fresh entry can exceed intended daily risk.
- **M21. Naive CSV parsing** (comma-split, quote-stripping) in bhavcopy + master contracts — quoted commas silently drop rows with zero error accounting.
- **M22. `/api/db-explorer/dump {full:true}` copies the tables the browser denylists** (auto_trades/orders/decisions/settings + user emails) — one admin credential = one-request full exfil.
- **M23. Single-instance assumptions** — two replicas would double-poll and could double-exit; leases only partially cover; per-process single-flights don't cross processes.
- **M24. No audit trail for config/kill-switch/risk-cap changes** — `updatedAt` only, no actor.
- **M25. TOCTOU on cycle overlap guard** — `cycleRunning` set after two awaits; manual run-once + timer tick can interleave two full download cycles.

### LOW (notable)

Dead alert functions (`dailyLossHalt`, `killSwitchActivated` defined, never called); approval TTL only enforced lazily on engine passes; "one entry per pass" is prompt-only, not code-enforced; `parseArgs` silently swallows malformed tool JSON (model gets misleading feedback); assistant chat history client-supplied without role/length validation (admin-only, but prompt-injection + cost hole); compile-time window constants leak into assistant prompts ("09:40–11:00" hardcoded while runtime window is tunable); unescaped Markdown in Telegram command replies (silent delivery failures); prompt-version PK race under multi-process; `exitReason` persisted before placement (misleading on rejected exits); Muhurat/half-day sessions invisible to `isMarketHours`; NextAuth pinned to a beta; unpinned npx MCP servers in `.mcp.json`; module-level (non-globalThis) rate limiter state in `lib/dhan/rate-limiter.ts` can double-dispatch under HMR.

### Verified clean (checked for, found correct)

IST math correct on any server TZ (offset-shift idiom; IST has no DST); NaN fail-closed sweep in gates genuinely implemented; no same-day bhavcopy leakage into baselines (`date < today` both live and replay); replay tick/bar filters have no lookahead; scoring.ts genuinely pure; entry idempotency chain solid (UNIQUE claim → correlation tag pre-submit); atomic status transitions close approve/reject/expire races; guard never sells unconfirmed entries; two-key live rule enforced in the gate not just UI; SQL values always parameterized, identifier interpolation allowlist-guarded; Supertrend/ATR/VWAP textbook-correct; lot sizes never guessed; Telegram broadcast renderer entity-safe.

---

## Part 3 — Gaps vs Design Intent

1. **"Never an unknown position"** — order-level reconciliation is delivered; position-level truth is not (C1).
2. **"Fail-closed"** — honored in gates and paper fills, but violated at the system edges: holiday fail-open (C2), stale NSE pulse data written as live (poller ignores the `stale` flag), silent CSV row drops (M21), guard blind-spots without alarms (M3).
3. **"Replay = live because scoring is pure"** — true for scoring only; the funnel around it diverges in ≥6 ways (H3, M16, replay candidate breadth, tilt basis, premiums, toggle drift).
4. **"Every decision written down"** — auto_decisions loses the trace when a pass throws mid-loop (M11); `auto_decisions` rows don't record prompt version; `record_note` is ephemeral; assistant chat has no usage recording.
5. **"20 sessions retained"** — true for candles/ranks; false for `oi_intraday` (unbounded) — and stale comments claiming "today-only" retention actively misled the closing-snapshot code into refusing to read data that exists.
6. **"34-check bench proves the gates"** — strong on pure gates/settings/store; zero coverage of reconciliation, ambiguity classification, partial fills, correlation recovery, guard exit paths, approval TTL — i.e., none of the failure modes found in this audit are benched.
7. **Curriculum numbers vs shipped defaults** — trades/day, capital cap, loss halt, spread limit all differ (Part 1.2); the curriculum should be regenerated from config or the config restored to the documented contract.
8. **Operational maturity** — no backups, no uptime/dead-man alerting, no restart supervision documented, 7-day local-only logs, Sentry unwired, two-DB drift with only 2 real migrations, Railway-vs-AWS doc contradiction.

---

## Part 4 — Super-Intelligence Feature Roadmap

Ordered by leverage. Tier 0 is "stop the bleeding"; Tiers 1–2 make the system measurably smarter with data it already collects; Tier 3 is the genuinely-new intelligence layer.

### Tier 0 — Trust foundations (prerequisites; days, not weeks)

1. **Position-truth reconciliation** — `getPositions()` on the adapter interface; cross-check DB open trades vs broker net qty every reconcile pass; auto-close broker-flat rows; alert on the reverse. (fixes C1)
2. **Broker-side bracket/OCO stops** — Fyers CO/BO, Dhan Super Order: place the premium stop as a resting broker-side order. Removes the 60 s guard latency and survives app downtime entirely. The single highest-value pre-live upgrade.
3. **Fail-closed calendar + auto master-contracts** — seed holidays at boot, fail closed on the trading path, nightly transactional scrip-master sync with row-count sanity alert. (C2, C3)
4. **Crash-safe exits** — correlationId in the exit claim; age-based terminal ruling for day-crossed orders; real paper `getOrderState`. (H1, M8, M9)
5. **Boot refusal without `APP_PASSWORD`; login rate limiting; nightly DB snapshot to S3; dead-man's Telegram alert** (poller stale / box down during market hours / token warm-up failed / guard blind N ticks). (C4, H7, M3)
6. **AI-pass deadline + incremental decision persistence** — abort-signal-honoring fetch, 3-min hard deadline, persist tool trace per-step so an executed order can never vanish from the audit. (H2, M11)

### Tier 1 — Benchmark fidelity (make the evidence trustworthy)

7. **Replay = live, enforced** — port chaotic-open + regime multiplier into replay; snapshot the effective toggle set into every scan record; record the exact scanned symbol list per tick; align replay trade cap with live picks. (H3)
8. **Premium-level grading** — persist the picked option's full quote (bid/ask/LTP/IV/OI) per tick; grade stored premiumSL/target against next-day `rollingoption` bars so hit-rate = rupee outcome including charges; verify the ₹1,500 worst-case claim empirically. (M4, M19)
9. **Fix the review scorecard** — include the suggestion bar; catch-up grading for missed days; path-aware hit metric (SL-first counts as a loss).
10. **Walk-forward, multiplicity-aware autoresearch** — leave-one-day-out validation, minimum-N acceptance, deflated-Sharpe-style penalty; the current in-sample hill-climb with 60 mutations/run is a data-snooping engine with a human guardrail.
11. **Bench the failure modes** — add reconcile give-up, partial-fill quarantine, correlation recovery (mock adapter), approval-TTL-at-approve, and crash-injection around `claimExitOrder` to the 34-check bench; wire typecheck/lint/tests as a blocking CI gate.

### Tier 2 — Smarter signals (data already in hand or one API call away)

12. **Time-of-day baselines** — from 20 retained sessions, estimate each symbol's U-shaped intraday volume/range curve; replace the uniform turnover session-fraction and the range-spread full-day baseline with "vs 20-day average *at this time of day*." Single highest-leverage math fix; kills the documented ~2× morning over-read and M5's coiled-bump bias.
13. **Robust OI-build estimator** — Theil–Sen/OLS slope over trailing 15–30 min of `oi_intraday`, z-scored against the symbol's own historical OI-build distribution → a real "urgency percentile" replacing the 2-point second-difference. (M6)
14. **Intraday option-chain for the shortlist** — one Dhan chain call per 5 min for ≤10 shortlist names lights up the four dormant R-Factor factors (callOi/putOi/PCR/volume) and enables **delta-weighted OI change** — directional option flow, far sharper than direction-blind premium share. `classifyOptionFlow` already exists but only runs EOD.
15. **IV awareness** — entry-IV vs 20-day IV percentile (don't buy post-spike vega); target-feasibility check: required spot move = ₹5000/(lot×delta); reject picks whose target implies >k×ATR of remaining-day move.
16. **Real regime input** — NIFTY bars + India VIX + the existing `gex.ts` gamma proxy as a scored, replay-mirrored feature — replacing the arbitrary first-symbol regime proxy. (H3b)
17. **Order-flow persistence** — session-cumulative depth-imbalance and close-vs-ATP volume delta from stored buyQty/sellQty/ATP, replacing the instantaneous 0.07-weight snapshot.
18. **Sector relative strength** from official sectoral indices (`lib/sector/` exists) instead of turnover-weighted constituent proxies.
19. **Event/earnings filter** — no corporate-events calendar exists anywhere; results-day gap risk is invisible to every gate. NSE announcements scrape → "results today/tomorrow" gate. Removes a known fat tail.
20. **Websocket feeds** — Dhan/Fyers market sockets for held contracts (sub-second stop latency, fixes M3 quote dependency) and for the shortlist (true per-minute OI, eliminates drifting-bucket attach M2, frees the REST budget for backfill).
21. **Data-quality monitor** — per-cycle assertions from CycleSummary (bars/OI coverage vs universe, priority freshness), Fyers-vs-Dhan LTP divergence checks, bhavcopy lateness, token near-expiry — all alerting through the existing Telegram plumbing.
22. **Candle gap backfill** — diff retained sessions vs the trading calendar at boot/EOD and re-fetch missing days from Fyers history (serves ~100 days) so the replay corpus self-heals.

### Tier 3 — The learning layer (super-intelligence proper)

23. **Probability-calibrated scoring** — `live_urgency_eod` freezes the FULL candidate board daily (picked and unpicked = built-in counterfactuals) and `trade_suggestions` holds outcomes. Fit a walk-forward logistic/GBM: gate features → P(+1R before SL). Replace (or calibrate) the hand-weighted linear composite. Meta-label the experimental paths (momentum/rank-climb flags as features, not gates).
24. **Case-based memory for the AI** — nightly post-trade reflection job writes a per-trade lesson row from `auto_trades` + `auto_decisions` + outcomes; inject top-k similar past cases (same setup profile: extended/chaotic-open/sector) into the decision prompt. Closes the loop that feature-toggle descriptions currently close manually.
25. **Confidence calibration** — require stated 0–1 confidence in `place_entry_order` args; store it; chart calibration vs realized outcomes; feed the calibration summary back into the prompt.
26. **Structured output + runtime contract enforcement** — emit the read as JSON schema (header/sections/verdicts/SL levels), render markdown in code; run `checkContract()` (already built, offline-only today) on every live read — regenerate once or quarantine on failure. The hand-rolled heading-contract prompt and both fragile page parsers collapse into a schema.
27. **Verifier pass (grounding)** — promote the replay bench's "ungrounded numbers" detector to runtime: every number in the commentary must appear in the scan JSON.
28. **Entry-only ensemble** — entries are ≤2/day; before `place_entry_order`, ask the other configured provider for a second opinion and require agreement (or log disagreement for the operator). Costs pennies at this volume. The neutral tool-def layer makes adding Claude/Anthropic ~100 lines.
29. **Exit-engine A/B in replay** — the project's own TF backtest concluded the edge is exit discipline; add trailing variants (Supertrend line trail, breakeven at +1R, time-stop 14:30) as replay knobs. This is where the evidence says the money is (addresses the documented KALYANKJIL failure: extended trends need wider stops + smaller size).
30. **Portfolio-level risk** — sector/correlation caps across simultaneous picks (7 picks can currently be 7 same-sector CEs); net-delta awareness; unrealized-loss included in the daily halt (M20); premium-at-risk position sizing (lots = floor(riskBudget/(entry−stop)×lotSize)) capped by existing gates.
31. **Prompt-regression CI** — run N recorded sessions against each candidate prompt version; diff contract metrics + literal-following P&L; key results to `prompt_versions` so `/prompts` shows each version's bench score.
32. **Cost & ops telemetry** — daily token/₹ rollup from `auto_decisions` + `trade_commentary` (+ assistant once recorded); latency histograms quote→decision→fill from timing data already logged; audit_log table (actor/before/after) for every config/kill-switch change.

### Sequencing recommendation

- **Week 1–2:** Tier 0 (items 1–6). Nothing else matters if positions can go unknown or the box trades on a holiday.
- **Week 3–4:** Tier 1 (items 7–11). Until replay mirrors live, no tuning decision is trustworthy.
- **Month 2:** Tier 2 signal upgrades in evidence order: 12 → 13 → 14 → 19 → 16, each validated through the now-trustworthy replay harness before its toggle ships ON.
- **Month 3+:** Tier 3, starting with 23 (probability calibration — data already accumulating) and 26–27 (structured output + grounding — pure reliability wins), then 24–25, 28–30.

---

*Full per-subsystem audit details (file:line for every finding) are preserved in the session that produced this report. Companion document: `SKILL.md` — the operating manual for future Claude sessions working on this codebase.*
