# Project-R Simulator

[![app](https://img.shields.io/website?url=https%3A%2F%2Fproject-r-simulator-production.up.railway.app%2Fapi%2Fhealth&label=app&up_message=live&down_message=down)](https://project-r-simulator-production.up.railway.app)
[![deployed on Railway](https://img.shields.io/badge/deployed_on-Railway-8b5cf6?logo=railway&logoColor=white)](https://railway.app)
[![healthcheck](https://img.shields.io/badge/healthcheck-%2Fapi%2Fhealth-brightgreen)](https://project-r-simulator-production.up.railway.app/api/health)
[![market-hours autoscale](https://github.com/charan1922/Project-R-simulator/actions/workflows/market-hours.yml/badge.svg)](https://github.com/charan1922/Project-R-simulator/actions/workflows/market-hours.yml)

[![last commit](https://img.shields.io/github/last-commit/charan1922/Project-R-simulator/main)](https://github.com/charan1922/Project-R-simulator/commits/main)
[![release](https://img.shields.io/github/v/tag/charan1922/Project-R-simulator?label=release&sort=semver)](https://github.com/charan1922/Project-R-simulator/tags)

[![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![TypeScript 5](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![pnpm 10](https://img.shields.io/badge/pnpm-10-f69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![Prisma 7](https://img.shields.io/badge/Prisma-7-2d3748?logo=prisma&logoColor=white)](https://www.prisma.io)
[![Tailwind 4](https://img.shields.io/badge/Tailwind-4-06b6d4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)

Live F&O market-intelligence + options-trade assistant for the Indian market
(NSE), plus TradeFinder trade downloading and an AI trade coach. Data is
recorded continuously from Fyers (5-min candles + OI) and NSE (EOD bhavcopy),
scored by the R-Factor / OI-urgency engine, and surfaced as ranked near-ATM
option suggestions.

| Area | Routes | What it does |
|------|--------|--------------|
| **Live market** | `/live`, `/nse/movers`, `/nse/heatmap`, `/heatmap`, `/fyers` | Live Urgency board (F&O movers with live depth by category), NSE movers & sector heatmaps, and the Fyers 5-min recorder status. |
| **Assistant** | `/trade-suggest`, `/trade-suggest/history`, `/trade-assistant` | Daily ranked near-ATM option picks (R-Factor + OI-urgency + opening-range breakout, live-quoted); the **Trade Log** (daywise picks + same-day scorecards); and an **AI chatbot** (Azure OpenAI Responses API + function calling, grounded on real pipeline numbers). |
| **Data / backtest** | `/data-downloader`, `/trade-viewer` | Download real 5-min equity + futures + **option** data per TradeFinder trade (expired options via Dhan `/v2/charts/rollingoption`); inspect coverage and the "why this trade" read. |
| **Reference** | `/nse/movers-history`, `/live/history`, `/holidays`, `/fno-lots`, `/api-docs`, `/config` | EOD movers & urgency history, market holidays, F&O lot sizes, OpenAPI docs, and runtime feature-toggle config. |

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Prisma + SQLite (`better-sqlite3`) · Tailwind v4 + shadcn/ui. Deployed on Railway (Docker + persistent volume) — see [DEPLOY.md](DEPLOY.md).

## Structure

```
app/
  live/               Live Urgency board (+ live/history)
  nse/                movers · heatmap · movers-history
  fyers/              Fyers 5-min recorder status
  trade-suggest/      daily option picks + history (Trade Log)
  trade-assistant/    AI chat UI — page + _components + _hooks/use-chat
  data-downloader/    download UI (_components, _hooks, _lib)
  trade-viewer/       inspect downloaded TF trades
  api/                live/* · nse/* · trade-suggest · fyers/* · bhavcopy · health · heatmap · ai-assistant · …
proxy.ts              one-password gate (HTTP Basic Auth; active when APP_PASSWORD set)
instrumentation.ts    boots the Fyers poller on server start
lib/
  trade-suggest/      scan engine, scoring, config, store
  r-factor/           R-Factor / OI-urgency scoring
  fyers/              5-min candle + OI recorder (poller, client, candle-store)
  signals/            indicators (Supertrend, VWAP, ATR), oi-intraday
  backtest/           data-downloader (incl. rollingoption), evaluator, backtest-store
  ai-assistant/       azure-client · tools · trade-data (grounding) · assistant (Responses loop)
  dhan/               auth (TOTP) · rate-limiter · market-feed
  nse/                movers feeds · combined-oi
  historify/          master-contracts (symbol -> securityId) · bhavcopy-service
  config/             feature-toggles (runtime switches, /config)
  db.ts env.ts utils.ts logger.ts
prisma/               schema + config (SQLite at data/project-r.db)
data/                 project-r.db, .dhan-token / .fyers-token caches (gitignored)
Dockerfile · railway.json · DEPLOY.md   Railway deployment (Docker + volume + healthcheck)
.github/workflows/keep-awake.yml        market-hours keep-alive (see DEPLOY.md)
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

## Deployment

Runs as a single always-on **Railway** service (Next.js UI + API + SQLite + the
Fyers poller) with a persistent volume at `/app/data`. Every push to the **`prod`**
branch auto-deploys; Railway verifies **`/api/health`** returns 200 before
switching traffic (healthcheck in `railway.json`). The whole app is behind a
**one-password gate** (`proxy.ts`, active when `APP_PASSWORD` is set). Full runbook
— volume, env vars, port pinning, DB migration, market-hours sleep, rollback — in
**[DEPLOY.md](DEPLOY.md)**.

Release flow: work on `main`; ship with `git checkout prod && git merge --ff-only main && git push origin prod`; tag with `git tag -a vX.Y.Z -m "…" && git push origin vX.Y.Z`.

## Notes

- **Dhan rate limits**: all API calls go through `lib/dhan/rate-limiter.ts` (Data 10/s, Quote 1/s) — never parallelize Dhan requests.
- **Expired options**: `lib/backtest/data-downloader.ts` falls back from `/charts/intraday` to `/charts/rollingoption` (underlying + ATM-relative strike + relative monthly expiry) and filters to the exact traded strike.
- **Native modules** (`better-sqlite3`, `@prisma/client`, `fyers-api-v3`) are kept external via `serverExternalPackages` in `next.config.ts`.
- Several tables (`backtest_equity/futures/options`, `bhavcopy_*_expiry`, `market_holidays`, `feature_toggles`, `oi_intraday`, …) are created via raw SQL on first use — not in the Prisma schema. So on the deployed image `prisma db push` runs **only on a fresh DB**; an existing DB boots straight through (otherwise db push would drop those tables). View them with any SQLite browser (not Prisma Studio).
- **Per-contract option OI**: bhavcopy is stored per expiry-month (`bhavcopy_option_expiry`) alongside the summed total, plus an authoritative NSE expiry calendar (`fno_expiry_calendar`). So the option `oi_level` follows the *traded* contract and is clipped to its expiry cycle — it isn't distorted when a monthly expiry rolls strikes off (e.g. TradeFinder trading next-month in expiry week). Both tables are raw-SQL, backfilled on bhavcopy sync.
- **Trade Assistant** (`/trade-assistant`): Azure OpenAI **Responses API** with **function calling**. Its tools (`list_trades`, `get_trade_context` in `lib/ai-assistant/`) return only real pipeline data via `getDailyContext`, so the model cannot invent numbers; each answer shows a "Data sources" trace of the tools it called. The deployment is a reasoning model — the tool-calling loop echoes the model's full output (reasoning + calls) back, which Azure requires.
