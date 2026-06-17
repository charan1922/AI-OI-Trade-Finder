# Project-R Simulator

A focused, standalone app for **market simulation** and **backtesting** — extracted from the main Project-R platform so it stays lean (no R-Factor engine, AI-trading, or quant modules).

Three things only:

| Route | What it does |
|-------|--------------|
| `/market-simulator` | Deterministic 5-min replay of real Dhan F&O data on a virtual clock (SSE) — candles, VWAP/EMA/OI overlays, transport controls. |
| `/data-downloader` | Download real 5-min equity + futures + **option** data per TradeFinder trade into the local DB. Expired options use Dhan `/v2/charts/rollingoption`. Per-trade status shows EQ / OI / OPT coverage and a "why this trade" read (direction, contract OI buildup, futures level). |
| `/backtest` | Replay a downloaded trade: option candles + P&L curve + signal chart (the backtest evaluator). |
| `/trade-assistant` | **AI chatbot** ("Trade Coach") that explains any TradeFinder trade in plain English — Azure OpenAI **Responses API + function calling** over real trade data. Grounded: its tools return only pipeline numbers, so it can't fabricate. |

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Prisma + SQLite (`better-sqlite3`) · DuckDB/Parquet · Tailwind v4 + shadcn/ui.

## Structure

```
app/
  market-simulator/   simulator UI (_components, _hooks, _lib)
  data-downloader/    download UI (_components, _hooks, _lib)
  backtest/           backtest replay UI (_components, _lib)
  trade-assistant/    AI chat UI — page + _components (message-bubble, tool-trace) + _hooks/use-chat
  api/
    simulator/        control · stream(SSE) · download · search
    backtest/         download-stream(SSE) · tf-validate
    bhavcopy/         NSE EOD sync (also backfills per-expiry option OI)
    ai-assistant/     chat (Azure OpenAI Responses API + function calling)
lib/
  simulator/          replay engine, quote synthesizer, parquet store, data-source
  backtest/           data-downloader (incl. rollingoption), evaluator, backtest-store, expiry-calendar
  ai-assistant/       azure-client · tools · trade-data (grounding) · system-prompt · assistant (Responses loop)
  dhan/               auth (TOTP) · rate-limiter · market-feed
  historify/          master-contracts (symbol -> securityId) · bhavcopy-service · duckdb helper
  ai-trading/         commissions (option charge model — used by the evaluator)
  db.ts env.ts utils.ts logger.ts
prisma/               schema + config (SQLite at data/project-r.db)
data/                 project-r.db, parquet cache, tradefinder_platform_trades.json
```

## Prerequisites

- `.env.local` with Dhan credentials (TOTP auto-token):
  ```
  DHAN_CLIENT_ID=...
  DHAN_PIN=...
  DHAN_TOTP_SECRET=...
  # or static fallback:
  DHAN_ACCESS_TOKEN=...
  ```
- `data/project-r.db` — must have `master_contracts` synced (copied over with the project). Required so symbol -> securityId resolution works before any download.
- **Optional** — for the `/trade-assistant` chatbot, add Azure OpenAI to `.env.local` (the page degrades gracefully if absent):
  ```
  AZURE_OPENAI_API_KEY=...
  AZURE_OPENAI_INSTANCE_NAME=...        # https://<instance>.openai.azure.com
  AZURE_OPENAI_CHAT_DEPLOYMENT=...      # a Responses-API-capable deployment
  AZURE_OPENAI_API_VERSION=2025-03-01-preview   # optional override
  ```

## Commands

```bash
pnpm install
pnpm db:generate     # regenerate the Prisma client
pnpm dev             # http://localhost:5001
pnpm build           # production build
pnpm typecheck       # tsc --noEmit
pnpm format          # prettier (imported code may differ from your style — run once to align)
```

## Notes

- **Dhan rate limits**: all API calls go through `lib/dhan/rate-limiter.ts` (Data 10/s, Quote 1/s) — never parallelize Dhan requests.
- **Expired options**: `lib/backtest/data-downloader.ts` falls back from `/charts/intraday` to `/charts/rollingoption` (underlying + ATM-relative strike + relative monthly expiry) and filters to the exact traded strike.
- **Native modules** (`@duckdb/node-api`, `better-sqlite3`, `@prisma/client`) are kept external via `serverExternalPackages` in `next.config.ts`.
- The backtest data tables (`backtest_equity/futures/options`) are created via raw SQL on first use — not in the Prisma schema. View them with any SQLite browser (not Prisma Studio).
- **Per-contract option OI**: bhavcopy is stored per expiry-month (`bhavcopy_option_expiry`) alongside the summed total, plus an authoritative NSE expiry calendar (`fno_expiry_calendar`). So the option `oi_level` follows the *traded* contract and is clipped to its expiry cycle — it isn't distorted when a monthly expiry rolls strikes off (e.g. TradeFinder trading next-month in expiry week). Both tables are raw-SQL, backfilled on bhavcopy sync.
- **Trade Assistant** (`/trade-assistant`): Azure OpenAI **Responses API** with **function calling**. Its tools (`list_trades`, `get_trade_context` in `lib/ai-assistant/`) return only real pipeline data via `getDailyContext`, so the model cannot invent numbers; each answer shows a "Data sources" trace of the tools it called. The deployment is a reasoning model — the tool-calling loop echoes the model's full output (reasoning + calls) back, which Azure requires.
