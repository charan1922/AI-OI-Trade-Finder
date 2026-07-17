# AI OI Trade Finder

[![app](https://img.shields.io/website?url=https%3A%2F%2Fcharan-projectr.duckdns.org%2Fapi%2Fhealth&label=app&up_message=live&down_message=down)](https://charan-projectr.duckdns.org)
[![build image](https://github.com/charan1922/Project-R-simulator/actions/workflows/build-image.yml/badge.svg)](https://github.com/charan1922/Project-R-simulator/actions/workflows/build-image.yml)
[![last commit](https://img.shields.io/github/last-commit/charan1922/Project-R-simulator/main)](https://github.com/charan1922/Project-R-simulator/commits/main)
[![release](https://img.shields.io/github/v/tag/charan1922/Project-R-simulator?label=release&sort=semver)](https://github.com/charan1922/Project-R-simulator/tags)

[![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![TypeScript 5](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![pnpm 10](https://img.shields.io/badge/pnpm-10-f69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![Prisma 7](https://img.shields.io/badge/Prisma-7-2d3748?logo=prisma&logoColor=white)](https://www.prisma.io)
[![Tailwind 4](https://img.shields.io/badge/Tailwind-4-06b6d4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)

Live F&O market-intelligence + options-trade assistant for the Indian market
(NSE), with AI trade commentary and autonomous trade execution. Data is recorded
continuously from Fyers (5-min candles + OI) and NSE (EOD bhavcopy), scored by the
R-Factor / OI-urgency engine, and surfaced as ranked near-ATM option suggestions —
which an AI layer then narrates and can execute under hard, code-enforced risk limits.

> **Naming:** the app is branded **AI OI Trade Finder**. Some internal identifiers
> keep the original codename (`project-r-simulator` package/image name, the `projectr`
> Docker container) — these are infrastructure names kept stable so the deploy
> pipeline doesn't break, and are not user-facing.

| Area                | Routes                                                                                   | What it does                                                                                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Live market**     | `/live`, `/nse/movers`, `/nse/heatmap`, `/heatmap`, `/fyers`, `/dhan`                     | Live Urgency board (F&O movers with live depth by category), NSE movers & sector heatmaps, and the Fyers/Dhan recorder + token status.                                                                                                                               |
| **Assistant**       | `/trade-suggest`, `/trade-commentary`, `/auto-trade`, `/trade-assistant`                 | Daily ranked near-ATM option picks; the AI **trade commentary** (decisive plain-English reads); the **auto-trade** console (AI proposes, code disposes — off/paper/approval/live); and an AI **chatbot** grounded on real pipeline numbers.                          |
| **Data / backtest** | `/data-downloader`, `/trade-viewer`, `/auto-trade/history`                                | Download real 5-min equity + futures + **option** data per TradeFinder trade; inspect coverage, the "why this trade" read, and auto-trade history + would-have P&L.                                                                                                  |
| **Ops / reference** | `/logs`, `/config`, `/prompts`, `/api-docs`, `/holidays`, `/fno-lots`                     | Live server console, runtime feature-toggle config, prompt version history, OpenAPI docs, market holidays, F&O lot sizes.                                                                                                                                            |

## Stack

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Prisma + SQLite
(`better-sqlite3`) · Tailwind v4 + shadcn/ui · Auth.js (Google sign-in). Runs in
production on a **self-hosted AWS EC2 box** (Docker + Caddy HTTPS) — see
[docs/aws-deployment/](docs/aws-deployment/README.md).

## Structure

```
app/
  live/               Live Urgency board (+ live/history)
  nse/                movers · heatmap · movers-history
  fyers/  dhan/       broker recorder + token status panels
  trade-suggest/      daily option picks + history (Trade Log)
  trade-commentary/   AI trade commentary reads
  auto-trade/         autonomous execution console (+ history)
  trade-assistant/    AI chat UI
  logs/               live server console (raw logs, survives redeploys)
  api/                live/* · nse/* · trade-suggest · fyers/* · dhan/* · auto-trade/* · bhavcopy · health · …
proxy.ts              auth gate (Google + break-glass password + Basic for self-calls)
instrumentation.ts    boots the Fyers poller + guard loop + file-log on server start
lib/
  trade-suggest/      scan engine, scoring, config, store
  r-factor/           R-Factor / OI-urgency scoring
  auto-trade/         AI execution layer — modes, gates, brokers, position guard
  ai-commentary/      the trade-commentary generator + execution-truth
  fyers/              5-min candle + OI recorder (poller, client, candle-store)
  dhan/               auth (TOTP) · rate-limiter · market-feed
  signals/  nse/  backtest/  config/  auth/  telegram/
  db.ts env.ts utils.ts logger.ts ops/file-log.ts
prisma/               schema + config (SQLite at data/project-r.db)
Dockerfile            single-stage image (built by CI → ghcr.io)
.github/workflows/    build-image.yml (push to prod → build + push :latest)
docs/aws-deployment/  how production runs on AWS (the operator runbook)
```

## Local development

```bash
pnpm install
pnpm dev             # http://localhost:5001
pnpm lint            # ESLint
pnpm typecheck       # tsc --noEmit
pnpm format          # Prettier
pnpm db:generate     # regenerate the Prisma client
```

Pull production data into your local DB (over HTTPS — no SSH):

```bash
pnpm db:pull-prod        # curated subset (fast)
pnpm db:pull-prod:full   # full clone
```

The laptop stays in a safe config (poller disabled, not autonomous, old broker app)
so local runs never place a live order — see
[docs/aws-deployment/05-settings-and-secrets.md](docs/aws-deployment/05-settings-and-secrets.md).

### Prerequisites (`.env.local`)

- Broker credentials (Fyers + Dhan, TOTP auto-token) and `APP_PASSWORD` for the gate.
- `data/project-r.db` with `master_contracts` synced (or run `pnpm db:pull-prod`).
- Optional: Azure OpenAI / MiMo keys for the AI features (pages degrade gracefully if absent).

## Production & deployment

Runs on a self-hosted **AWS EC2** box behind Caddy (HTTPS via DuckDNS + Let's
Encrypt). CI/CD: a push to the **`prod`** branch triggers GitHub Actions to build the
Docker image and push it to ghcr.io; a cron on the box pulls `:latest` and restarts
itself (never mid-trade). Everything trading-critical runs headlessly with no page
open.

The full runbook — the box, Elastic IP, HTTPS, CI/CD, the autonomous jobs, power
control, and safety — is in **[docs/aws-deployment/](docs/aws-deployment/README.md)**.

```bash
pnpm box:status     # is the box up? (needs AWS CLI configured)
pnpm box:start      # power the box on
pnpm box:stop       # power it off
```

> The legacy Railway deploy is fully decommissioned. `DEPLOY.md` is kept only as
> historical reference for that setup; AWS is the source of truth.

## Notes

- **Broker separation**: the autonomous 5-min equity/futures candle recorder uses **Fyers**; Dhan supplies live market/option quotes and broker order state. Calls stay behind their shared account-level gates; do not bypass them.
- **Dhan limits**: the chart downloader is capped below Dhan's Data API ceiling, market quotes are batched and serialized below 1/s, and option-chain requests follow their separate per-unique-request rule. Recheck Dhan's current v2 docs before changing these gates.
- **Native modules** (`better-sqlite3`, `@prisma/client`, `fyers-api-v3`) are kept external via `serverExternalPackages` in `next.config.ts`.
- Several tables (`backtest_*`, `bhavcopy_*_expiry`, `market_holidays`, `feature_toggles`, `oi_intraday`, `auto_trades`, `trade_commentary`, …) are created via raw SQL on first use — not in the Prisma schema. On the deployed image `prisma db push` runs **only on a fresh DB**; an existing DB boots straight through (otherwise db push would drop those tables). **Never run `db push --accept-data-loss` against prod.**
- **Auto-trade safety**: the AI proposes, code disposes — trade windows, max trades/day, capital cap, daily-loss halt, and forced square-off are enforced in `lib/auto-trade/risk/`, not in prompts. Live orders need a two-key rule (env flag + `live` mode). See [CLAUDE.md](CLAUDE.md).
