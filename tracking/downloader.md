# /data-downloader page, explained

## 1. The big picture

Despite its URL, the page titles itself TradeFinder Trade Context, and that is the better name.

You have a list of real trades taken on the TradeFinder platform, stored in tradefinder_platform_trades.json. Each trade is an option trade on an Indian stock, for example: bought the NATIONALUM 250 CE on 2026-02-18, made +₹12K. The goal of the project is to reverse-engineer why TradeFinder picked those stocks.

To answer why, you need the market data around each trade, and that is what this page manages. For every trade it:

- Shows whether the historical data is already downloaded, using ready / partial / missing status.
- Lets you download the data from Dhan, in three legs per trade: stock price candles, futures candles, and the specific option contract candles.
- Renders an analysis of the downloaded data: charts of open interest and turnover buildup in the roughly 30 sessions before the trade, plus a plain-English Why this trade verdict.

So it is two tools in one: a data download manager on the left, and a trade forensics viewer on the right.

## 2. The files involved

The page follows the project convention of underscore-prefixed folders for non-route files.

| File | Purpose |
| --- | --- |
| page.tsx | Page shell, header, search and filter controls, master/detail layout |
| _hooks/use-data-status.ts | Fetches the trade list and status |
| _hooks/use-download-stream.ts | Runs a download and streams live progress |
| _components/trade-list.tsx | Left sidebar list |
| _components/trade-context-view.tsx | Right detail panel |
| _components/trade-rationale.tsx | Why this trade card |
| _components/daily-bar-chart.tsx | Small Recharts bar charts |
| _components/daily-context-table.tsx | Per-day table at the bottom |
| _components/download-progress.tsx | Progress bar and log |
| _components/bhavcopy-sync.tsx | Sync NSE data button |
| _components/human-verified-badge.tsx | Amber verified shield badge |

Backend routes it talks to:

- api/backtest/tf-validate/route.ts — multi-action POST endpoint; this page uses the symbol-status and trade-context actions.
- api/backtest/download-stream/route.ts — streaming download endpoint.
- api/bhavcopy/route.ts — NSE bhavcopy status and sync.

The library layer doing the real work is lib/backtest/data-downloader.ts for Dhan API calls and SQLite inserts, plus lib/backtest/backtest-evaluator.ts for getDailyContext analysis.

## 3. What happens when the page loads

useDataStatus POSTs { action: 'symbol-status' } to /api/backtest/tf-validate. On the server, route.ts:

- Loads all trades from the TradeFinder JSON file.
- Asks SQLite which (symbol, date) combinations already have data in backtest_equity, backtest_futures, and backtest_options. The options check also matches option type and strike.
- Returns three booleans for each trade: hasEquity, hasFutures, and hasOptions, plus an overall status:
	- ready: all three legs are present.
	- partial: at least one leg is present, but something is missing. (Fixed: this used to look only at equity/futures, so a trade with only option data was wrongly called "missing".)
	- missing: nothing has been downloaded yet.

The header chips like X ready / Y partial / Z missing of N are computed client-side from this list. If the status request fails, the page now shows a red "Failed to load the trade list" message with a hint to click Refresh list (previously a failure was silently swallowed and you just saw nothing).

## 4. The controls row

- Search box filters by symbol substring or date substring.
- Status dropdown filters All / Ready / Partial / Missing.
- Verified only toggle shows only trades flagged humanReview: true, which were cross-checked against actual broker screenshots. The amber shield badge marks those trades. By default only verified trades are shown, and the header counts respect this toggle too.
- Sync NSE data button is explained in section 7. It is a separate download from the per-trade one.
- Refresh list re-runs the status query, which is useful after a download in another tab.

A nice React detail in page.tsx is that the selected trade defaults to the first visible row derived in render, with no useEffect, and selection is stored as a string key (symbol|date|optionType|strike) rather than an object reference, so it survives list refreshes.

## 5. The download flow

When you click Download for a missing trade, or Re-sync trade from the header button, useDownloadStream.start([trade]) POSTs to /api/backtest/download-stream.

This endpoint does not return one JSON blob. It returns a Server-Sent Events stream: a long-lived response where the server pushes small data: {...} JSON lines as work progresses. The hook reads that stream chunk by chunk and updates the progress UI live with progress, step-done, symbol-done, error, and complete events.

On the server, in download-stream/route.ts, each trade goes through these steps:

1. Date window - downloads from trade date minus 45 calendar days up to the trade date, which is about 30 trading sessions and enough history to compute 20-day averages.
2. Contract resolution - Dhan needs a numeric securityId per instrument. The route first checks the trade_contracts table for preserved IDs from a previous download. This matters because Dhan's master contract list only contains currently live contracts, so an option that expired months ago disappears from it. By saving IDs on first download, a later re-sync still works. If something is not preserved, it syncs Dhan's master contract CSV, shown as a visible master-sync step because of the project's no silent downloads rule.
3. Sequential legs - Dhan forbids parallel calls, so the legs are downloaded one after another:
	 - Equity: downloadEquity5min, which stores 5-minute OHLCV candles in backtest_equity.
	 - Futures: downloadFutures5min, which stores 5-minute candles plus open interest in backtest_futures.
	 - Option: downloadOption5min, which stores the traded strike's 5-minute candles plus OI in backtest_options.

The option leg has a fallback. If the contract has expired and dropped out of the master list, or returns no candles, it switches to Dhan's /v2/charts/rollingoption endpoint in data-downloader.ts. That endpoint serves expired options keyed by the underlying plus an ATM-relative strike band, then the code filters rows back to the exact traded strike. The OPT via rollingoption chip in the detail view tells you that path was used. The limitation, also shown in the UI's partial-data warning, is that rollingoption only covers ATM +/- 3 strikes, so deep OTM or ITM expired options are simply unobtainable.

Each leg's resolved ID is saved back to trade_contracts. Errors are collected per leg, so one failed leg does not abort the others. A final complete event carries totals. The page then refreshes the list and bumps refreshToken, which forces the detail panel to re-fetch its charts.

All inserts use INSERT OR IGNORE, so re-downloading the same range never duplicates rows.

Cancelling: the Cancel button aborts the browser's request, and the server notices the disconnect (via req.signal and the stream's cancel callback) and stops between Dhan calls instead of downloading on. The UI shows an amber "Download cancelled — N rows saved before stopping" banner, distinct from the green "Download complete" one. The progress bar also counts the finished legs of the current trade (equity → futures → option ≈ 33 / 66 / 100 percent), so a single-trade download no longer sits at 0 percent until the end.

## 6. The detail panel

When a non-missing trade is selected, TradeContextView POSTs { action: 'trade-context', days: 30 } and getDailyContext in backtest-evaluator.ts aggregates the 5-minute bars into one row per day: end-of-day OI from the last bar of each day, turnover as volume times close summed across the day, volumes, closes, and NSE bhavcopy data merged in. If this request fails, the panel now shows a red error box instead of "Loading context…" forever.

What you see, top to bottom:

1. Header - symbol, CE/PE plus strike, date, P&L, entry to exit premium with percent return, and the per-trade Re-sync button.
2. Why this trade card - the core payoff of the page.

Key concept: open interest alone tells you the magnitude of positioning, never the direction. Direction comes from combining price change with OI change, the classic four quadrants:

| Price | OI | Quadrant | Bias |
| --- | --- | --- | --- |
| Up | Up | Long buildup | Bullish |
| Down | Up | Short buildup | Bearish |
| Up | Down | Short covering | Bullish-ish |
| Down | Down | Long unwinding | Bearish-ish |

The card leads with that quadrant verdict, then lists evidence bullets, where green dots support the trade direction and amber dots go against it:

- Option flow at the traded strike, where premium plus OI separates fresh buying from option writing.
- OI level metrics, meaning trade-day OI divided by the 20-day average. The project's key V4 finding is that TradeFinder's top picks sit at 1.25-1.35x.
- 5-session OI change.
- Volume and turnover multiples. The volume-surge multiple now compares the trade day against the average of the OTHER sessions (the trade day used to be included in its own baseline, which slightly understated the surge).

If the data-derived bias contradicts the CE/PE direction TradeFinder actually took, an amber Direction conflict banner is shown instead of hiding it. That is deliberately honest design.

3. Contract chips - the exact Dhan security IDs backing the data, for transparency and for reuse on Re-sync.
4. Calendar note - accounts for every day in the window: weekends skipped, named NSE holidays, special weekend sessions, and gaps where the market traded but the symbol's data is missing. Those gaps can silently skew 20-day averages, so they are flagged.
5. Coverage chips - indicators such as Futures OI - 28/30 sessions, with a hint to click Sync.
6. Four bar charts - Total Option OI (CE + PE, all strikes), Futures OI, Futures Turnover, and Equity Turnover. The amber bar is the trade day; in diff mode the bars are green or red versus the previous day, and the very first bar is gray because it has no previous day to compare against. Hover the info icon for each metric's data source.
7. Daily Detail table - every session, newest first, with day-over-day deltas and a per-day quadrant badge (LB / SB / SC / LU).

## 7. Why two data sources

This is the subtle design decision on the page, documented in backtest-evaluator.ts.

- Dhan candles give you a single contract's data. A futures contract's OI naturally ramps up from near zero as it approaches being the front month, so charting one contract's OI shows a fake buildup that is really just contract maturation.
- NSE bhavcopy is the exchange's official end-of-day file. It gives totals across all contracts and strikes, which means the true stock-wide futures OI and total option OI.

So the charts use bhavcopy only for futures OI and turnover plus total option OI and volume. Dhan supplies equity turnover and the traded strike's premium and OI. Days that bhavcopy has not covered render as gaps, never as estimates, which stays consistent with the no fabricated data rule.

The Sync NSE data button fills those gaps. It is global, since one NSE file covers every stock. It auto-sizes its window to cover the earliest downloaded trade, capped at 300 days, and only fetches dates that are not already on disk.

## 8. Bugs found and fixed (2026-06-12)

A code review found the issues below. All of them are now fixed. Each entry explains the problem, why it mattered, and what the fix was — in plain terms.

### Fixed: cancelling a download showed "Download complete"

**Problem.** The progress component decided what to show using only two facts: "is a download running?" and "is there a log?". After you clicked Cancel, the download was no longer running and the log existed — exactly the same situation as a successful finish — so it showed the green "Download complete" banner.

**Fix.** The hook (use-download-stream.ts) now tracks a third fact, `cancelled`. The component shows an amber "Download cancelled — N rows saved before stopping" banner when it is set. Lesson: when a process can end more than one way, a boolean is not enough state; you need to record *how* it ended.

### Fixed: Cancel only stopped the browser, not the server

**Problem.** Cancel aborted the browser's fetch, which stops *reading* the response — but the server's loop had no idea and kept calling Dhan and inserting rows. Eventually it tried to push a progress event into the dead stream, which threw an unhandled error. Wasteful (Dhan has strict rate limits) and noisy.

**Fix.** The route (download-stream/route.ts) now sets a `clientGone` flag in two places: when `req.signal` fires its abort event, and in the stream's `cancel()` callback (which the runtime calls when the reader goes away). The download loop checks the flag before each leg and stops cleanly; every send and the final close are wrapped so a dead stream can never throw. Lesson: in a streaming endpoint, client disconnection is a normal event you must handle, not an exception.

### Fixed: no error state in the detail panel or the trade list

**Problem.** Both data fetches had `catch` blocks that swallowed errors silently. If the trade-context request failed, the right panel said "Loading context…" forever; if the trade-list request failed, the page just looked empty. Silent failure is the worst failure: the user cannot tell broken from slow.

**Fix.** Both now store the error message in state and render a red message with a retry hint. The detail panel's error is stored together with the trade's key, so an error for trade A never shows while trade B is loading. The list hook (use-data-status.ts) was restructured so the fetch function returns `{ data, error }` and all state updates happen in the caller — this also keeps React's "no synchronous setState inside an effect" lint rule happy.

### Fixed: duplicate React keys in the download log

**Problem.** Log lines were rendered with `key={line}` (the text itself as the key). React keys must be unique among siblings; two identical lines (e.g. the same error twice) collide, causing a console warning and potential mis-rendering.

**Fix.** The key is now `position:text`. Because the log is append-only (lines never reorder or get removed), the position is stable, so this is a safe key. Lesson: text content is rarely a safe React key; something positional or an ID is.

### Fixed: progress bar sat at 0% for single-trade downloads

**Problem.** The bar measured completed *symbols* / total symbols, but this page always downloads exactly one trade — so the bar showed 0% the whole time, then jumped to 100%.

**Fix.** The hook now also counts finished *legs* of the current trade (2 legs without an option, 3 with), and the bar adds that fraction: roughly 33% after equity, 66% after futures, 100% when done.

### Fixed: inconsistent SQL string escaping

**Problem.** The option insert escaped single quotes in the symbol name, but the equity and futures inserts interpolated it raw. Not exploitable here (symbols come from the project's own JSON), but inconsistent — a symbol containing a quote would have broken two of the three paths.

**Fix.** All three insert paths now escape the symbol the same way.

### Fixed: first bar in diff-mode charts was always green

**Problem.** Diff mode colors each bar green/red versus the previous day, but the first bar was compared with itself, so "greater or equal" always won and it was always green — implying a rise that the data does not show.

**Fix.** The first bar is now gray (no previous day exists to compare against).

### Fixed: options-only trades classified as "missing"

**Problem.** The status logic said partial = "equity or futures present". A trade where only the option leg had downloaded fell through to "missing", even though data exists.

**Fix.** Partial now means *any* real leg is present, with care taken that the option check only counts when the trade actually has an option leg (strike > 0).

### Fixed: volume-surge average included the trade day itself

**Problem.** "Option volume was 2.1x its average" included the trade day inside that average, diluting the very surge being measured — and it was inconsistent with the OI-level metric, which correctly excludes the trade day.

**Fix.** The average now uses only the other sessions, matching the OI-level methodology.

### Also cleaned up

- Removed an unused `tfBullish` variable in trade-rationale.tsx (dead code flagged by lint).

### Known remaining (deliberately left)

- `summary` from useDataStatus is still returned but unused by the page, because the page recomputes counts client-side so they respect the verified toggle. Harmless.
- `entryTime`, `exitTime`, `quantity`, and `expiry` are fetched per trade but not displayed. They are available if a future UI wants them.
- Project-wide `pnpm lint` runs out of memory on this machine (pre-existing; unrelated to this page). Linting the changed folders directly works: `npx eslint app/data-downloader app/api/backtest ...`.

## Overall verdict

The page is well built: derived state instead of effect chains, honest gap handling, preserved contract IDs, and sequential Dhan calls all follow good practice. The bugs found in review (cancel behavior, missing error states, and several small correctness issues) have all been fixed and verified with ESLint and tsc.
