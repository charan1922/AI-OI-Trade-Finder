# TradeFinder capture: two feeds only

**Date:** 2026-10-08 · **Decided by:** the operator ("just market_pulse and sector_scope data capture is enough").

## Decision

Capture exactly two TradeFinder feeds, stored raw:

| Tag | Path |
| --- | --- |
| `market_pulse` | `/api_be/data/market_pulse` |
| `sector_scope` | `/api_be/data/sector_scope` |

Both are fired by one page, `https://tradefinder.in/marketPulse` (measured on the worker box with fresh cookies: `market_pulse` 32 KB, `sector_scope` 31 KB, both `status: SUCCESS`). The worker therefore opens that page only — one Chromium tab on a 1 GB host instead of two.

## What changed

- `lib/tf-live/endpoints.ts` — `TF_ENDPOINTS` is the allowlist; `TfEndpoint` still includes the retired tags so stored rows stay readable.
- `lib/tf-live/ingest.ts` — explicit `endsWith('/data/sector_scope')` case (not `/data/order/sector_scope`).
- `app/api/tf/worker-config/route.ts` — `TF_PAGES` is `['…/marketPulse']`.
- Benches pin the list: `scripts/verify-tf-ingest.ts`, `scripts/entry-quality-checks.ts`.

## Not captured any more — and why nothing breaks

`all_sector`, `daily-index`, `rfactor_data` and `check_signal` are no longer stored. That loses nothing: `sector_scope` **contains** the two that mattered (checked on the 2026-10-08 capture):

- `payload.data.all_sector` — the per-stock board, basket → symbol → `param_0..3` (LTP, prev close, %, R-Factor), 16 baskets.
- `payload.data['daily-index']` — the 16 sector values, `{ Symbol, param_3 }`.

Every reader now goes through one list and one parser, so today's data comes from `sector_scope` and older days from whatever was stored then:

| Set | Feeds, newest first | Parser |
| --- | --- | --- |
| `TF_BOARD_ENDPOINTS` | `sector_scope`, `rfactor_data`, `all_sector` | `parseTfBoard(endpoint, payload)` |
| `TF_INDEX_ENDPOINTS` | `sector_scope`, `daily-index` | `parseTfIndices(endpoint, payload)` |

Readers switched: Running Race and the TF selector (`race.ts`, `/api/tf/race`), the trade snapshot (`snapshot.ts`), the /live TF column and `/sector-scope` (`store.ts`), `/tf/history` (`/api/tf/eod`), the replay script, and the "no board captured today" hint on /live. Reading a `sector_scope` payload with the old `parseAllSector()` gives rows full of nulls rather than an error — `verify-tf-ingest.ts` pins that.

## Removed as dead code (2026-10-08)

- The lt/at fetch path — `lib/tf-live/collector.ts`, `client.ts`, `status.ts`, `POST /api/tf/capture` (no caller), the lt/at functions in `store.ts`, and `scripts/tf-client-checks.ts`. Replaying TradeFinder's token was proven impossible on 2026-08-08; the worker replaced it. `withinCaptureWindow()` moved to `browser.ts`, its only user.
- The `tf_live_rows` writer (`extractRows`, `recordTfLiveRows`): rows were written, never read. The `tf_live_session` and `tf_live_rows` tables stay — `schema.prisma` declares them and old boxes hold data.
- `getTfLiveCaptureHistory` and the `history` field of `/api/tf/browser-session`, and `TF_PARSED_ENDPOINTS`.

## `/tf` shows today's data (operator request, 2026-10-08)

"Capture history by date" is gone from `/tf`; older days are on `/tf/history`. In its place, **Today's data** shows the latest successful capture of each feed for today (IST), like `/fyers`' coverage table, from `GET /api/tf/browser-session?data=1`. The capture time turns amber after 10 minutes. "Last capture per endpoint" always lists both captured feeds — with today's success and error counts each (`counts` from `getTfCaptureCountsForDate`), and "never" for a feed that has not landed yet — and the paste help is one line.

- `sector_scope` → `parseSectorScope()`: one row per symbol with its sectors, LTP, prev close, %, R-Factor (the confirmed `all_sector` meanings — ASHOKLEY (149.4 − 153.7) / 153.7 = −2.80% = `param_2`).
- `market_pulse` → `parseMarketPulse()`: its lists (top_gainers, top_losers, intraday_boost, high_powered_stocks, top_level_stocks, low_level_stocks, breakout_beacon), params passed through raw. `isPriceList()` labels `param_0..2` as LTP / prev close / % only when every row of that capture satisfies (p0 − p1) / p1 × 100 ≈ p2. That holds on every row of six lists and fails for `breakout_beacon` (p2 is `BULL`/`BEAR`). **`param_3` stays unlabelled**: it matched `intraday_boost`'s R-Factor for only 10 of 20 `top_gainers` and 5 of 15 `top_losers`, so its meaning is not confirmed.

**Step through the day** (operator request, 2026-10-08): captures land all session, so "Today's data" has a time picker — a slider over every capture minute today, ◀ ▶, and **Live** (the latest; default). `&at=<ISO>` returns the last capture of each feed at or before that time; `times` holds one stop per minute (both feeds fire on the same page load ~0.1s apart, so a minute's last capture covers both). The "N min old" warning shows only on Live.

**Tab and column order** (operator request, 2026-10-08): sector scope, then intraday boost, then the other lists in TradeFinder's order. R-Factor is the 3rd column wherever it is known: sector scope (Symbol, Sectors, R-Factor, …) and any market_pulse list whose `param_3` passes `isRFactorParam3()` — it must equal the sector_scope R-Factor of the same capture on every overlapping row (≥ 5). That held for intraday_boost (80 of 80) and not for top_gainers (12 of 25) or top_losers (8 of 25).

## Open

- `param_3` in market_pulse lists other than intraday_boost, and all of `breakout_beacon`'s params, have no confirmed meaning yet.
