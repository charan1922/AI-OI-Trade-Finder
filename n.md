1. What the page does (one sentence)
It takes your TradeFinder trades from a JSON file, lets you download the real Dhan + NSE data behind each one, and renders a "why was this trade taken" view — multi-day OI buildup, turnover, a strike ladder, and a plain-English rationale — all computed from actual downloaded values.

Data flow:


tradefinder_platform_trades.json
        │  (loadAllTFTrades)
        ▼
 [trade list, left pane]  ──click──►  [context view, right pane]
        │                                   │
        │ Download/Re-sync                  │ fetch trade-context + strike-ladder
        ▼                                   ▼
 Dhan API (charts/intraday,          SQLite aggregation queries
  charts/rollingoption)               (getDailyContext, getStrikeLadder)
  + NSE master contracts                   │
        │                                   ▼
        ▼                            bar charts, rationale, ladder, table
 SQLite (backtest_equity/futures/options, trade_contracts)
  + NSE bhavcopy_days (fallback)
2. Data sources — all real, no synthesis
Source	What it gives	Where used
tradefinder_platform_trades.json	The trades themselves (symbol, date, strike, P&L, entry/exit, humanReview)	loadAllTFTrades()
Dhan /v2/charts/intraday	5-min OHLCV + OI candles for equity / futures / the traded option	downloadEquity/Futures/Option5min
Dhan /v2/charts/rollingoption	Expired-option candles, ATM±3 strikes both sides	downloadOptionBand (powers the ladder)
Dhan master CSV	symbol → securityId resolution	master-contracts.ts
NSE bhavcopy (bhavcopy_days table)	Official EOD futures OI/turnover + equity turnover	fallback only when Dhan has no candles
HolidaycalenderData.csv	Official NSE holidays	trading-calendar.ts window accounting
The crucial design rule (your earlier feedback, saved in memory): Dhan candles are primary; bhavcopy fills gaps; nothing is ever invented. Futures volume is deliberately never mixed between the two because Dhan reports shares and NSE reports contracts.

3. Storage — SQLite tables
In backtest-store.ts (formerly duckdb-schema.ts — it's SQLite, not DuckDB):

backtest_equity, backtest_futures, backtest_options — 5-min bars keyed by symbol/date/timestamp (+ strike/option_type for options).
trade_contracts (line 39) — your "preserve the contract IDs" request. Per trade it stores eqSecurityId, futSecurityId, futExpiry, futLotSize, optSecurityId, optVia, resolvedAt. getTradeContract/upsertTradeContract read/write it.
Why it matters: on a re-sync, if all IDs are already preserved, the download skips the master-contract lookup entirely — so a re-sync keeps working even after a contract has expired and dropped out of today's master CSV.

4. Backend logic
backtest-evaluator.ts — the two functions that feed the page
getDailyContext() (line 183) — the heart of it. Three GROUP BY date queries (futures, option-strike, equity), each newest-days first:

Futures/option EOD OI = oi of that day's last 5-min bar (correlated subquery, line 195/204).
Turnover = SUM(volume × close) per day — this is an approximation of traded value (Dhan candles carry no real turnover field; the UI hint says "≈" honestly).
It then merges in bhavcopy_days as a fallback (line 222) and tags each day's futSrc/eqSrc as 'dhan' | 'bhavcopy' | null so the UI can disclose the source.
Insight metrics (line 313): oiLevel20d = trade-day OI ÷ 20-session average (line 297) — this is TradeFinder's V4 oi_level signal you asked me to match. It requires ≥5 prior sessions or returns null (won't fake a baseline). Change % uses a 5-session lookback (kBack), not first-to-last, because a fresh contract starts near-zero OI and would show absurd +14000% otherwise.
calendar = analyzeWindow() for the weekend/holiday accounting.
getStrikeLadder() (line 351) — per-strike CE/PE EOD OI for the trade day, band PCR (Σ PE OI ÷ Σ CE OI), and max-pain (the strike minimizing writer payout, line 388). It only reports available: true if there are ≥2 strikes on each side — a single traded strike is honestly not a ladder.

data-downloader.ts
downloadEquity/Futures/Option5min — accept an optional preserved securityId/expiry/lotSize, return the resolved IDs back so they can be persisted.
downloadOptionBand (line 352) — fetches ATM±3 CE+PE via rollingoption, tries expiry codes 1/2/3 until one has data, inserts with INSERT OR IGNORE. Note the graceful fallback (line 364): if master contracts aren't synced today, it uses the most-recent synced equity row rather than failing (equity IDs are stable).
trading-calendar.ts
analyzeWindow() (line 169) walks every calendar date in the window and classifies it: weekend skipped, official holiday (from your CSV), special weekend session (market actually traded), symbol gap (market open but our data missing — flagged ⚠ because it would skew averages), or no-data weekday (reported plainly, never relabeled as a holiday). This is the honesty layer you insisted on twice.

API routes
tf-validate/route.ts — the multiplexer. Relevant actions: symbol-status (builds the trade list + ready/partial/missing per leg), trade-context, strike-ladder (with optional download: true).
download-stream/route.ts — SSE streaming download. Preserves contracts (line 45), auto-syncs master contracts as a visible step if stale (line 54), then downloads equity → futures → options → band per trade, persisting IDs after each leg. This is the "no room for assumptions" re-sync fix.
5. Frontend
page.tsx — flex split: aside w-72 list left (sticky, scrolls), main flex-1 context right. State is derived, not effect-driven (effectiveKey via useMemo, line 58) to avoid the lint error class you hit. Verified-only toggle, search, status filter.
trade-list.tsx — dense rows, EQ/FUT/OPT status dots, tradeKey() is the stable identity used everywhere.
trade-context-view.tsx — right pane orchestrator. Fetches trade-context, guards with ctxKey === key so a stale response from a previous trade never renders against the wrong trade. Composes: Header, TradeRationale, ContractChips, CalendarNote, BhavcopySourceNote, 4 bar charts, StrikeLadderPanel, DailyContextTable.
daily-bar-chart.tsx — pure div/SVG bars (no chart dependency added). Colors are inline style={{backgroundColor}} because Tailwind can't JIT dynamic opacity classes — this was the "bars rendering transparent" bug. fmtOI/fmtTurnover do Indian K/L/Cr formatting.
trade-rationale.tsx — the "Why this trade" verdict. Builds evidence bullets from insight, leads with the 20-day oi_level (TF's signal), green/amber dots for supports/against. Every bullet is derived from real values.
strike-ladder.tsx — tornado CE/PE OI, on-demand band download.
daily-context-table.tsx — full per-day table, newest first, with weekday + day-over-day deltas.
bhavcopy-sync.tsx — user-triggered NSE EOD sync.
Hooks: use-data-status.ts (loads trade list, lint-safe effect), use-download-stream.ts (parses the SSE stream into progress state).
6. The honesty mechanisms (your repeated constraint)
These are worth knowing because they're load-bearing:

Turnover is labeled "≈ Σ(volume×close)" — never claimed as exchange turnover.
oi_level returns null with <5 sessions instead of a misleading number.
futSrc/eqSrc tags + BhavcopySourceNote disclose every bhavcopy-sourced day.
CalendarNote flags symbol data-gaps that would skew averages.
Futures volume is never cross-filled (units differ).
Partial trades show a note that Dhan genuinely doesn't serve that data (expired options beyond ATM±3, ex-F&O futures).
7. Before you commit — honest caveats
It's a large diff (~116 files including the dhanhq skill and earlier staged work). You may want to split: (a) data-downloader feature, (b) bhavcopy/calendar libs, (c) the dhanhq skill/MCP.
Pre-existing set-state-in-effect lint errors live in files I didn't touch (app/backtest/page.tsx, SymbolBar.tsx) — not introduced here.
Only TATAELXSI has preserved contract IDs so far; others populate on their next re-sync.
Want me to walk through