# 3. Folders & Files Explained 🗂️

Here is the project laid out. You don't need to touch most of it — this is just so nothing is a mystery.

```
Project-R-simulator/
├── app/                  ← the website pages + the server "API" routes
│   ├── market-simulator/    the Simulator screen
│   ├── data-downloader/     the Data Downloader screen
│   ├── backtest/            the Backtest screen
│   ├── api/                 the "back-end" — code that runs on the server
│   │   ├── simulator/         control · stream · download · search
│   │   └── backtest/          download-stream · tf-validate
│   ├── layout.tsx           the shared frame (sidebar + theme) around every page
│   ├── page.tsx             the home page
│   └── globals.css          global styling
│
├── components/           ← reusable UI pieces (buttons, calendar, sidebar…)
│   ├── ui/                  small building blocks (button, calendar, popover…)
│   ├── app-sidebar.tsx      the left navigation menu
│   └── layout-shell.tsx     wraps pages with the sidebar
│
├── lib/                  ← the "brains" — logic with no screen attached
│   ├── simulator/           the replay engine (the heart of the Simulator)
│   ├── backtest/            downloading trade data + reviewing trades
│   ├── dhan/                logging in to Dhan + calling its API safely
│   ├── historify/           looking up stock IDs ("master contracts") + DuckDB helper
│   ├── ai-trading/          only one file kept: commissions (fee/charge math)
│   ├── db.ts                connects to the SQLite database
│   ├── env.ts               reads settings from .env.local
│   ├── utils.ts             tiny helpers
│   └── logger.ts            logging
│
├── prisma/               ← database definition
│   ├── schema.prisma        describes the database tables
│   └── prisma.config.ts     points to data/project-r.db
│
├── data/                 ← your actual data lives here
│   ├── project-r.db         the SQLite database file (tables of data)
│   ├── parquet/             saved candle files for the Simulator
│   ├── tradefinder_platform_trades.json   the list of real past trades
│   └── .dhan-token.json     a cached Dhan login token (auto-managed)
│
├── helpingdoc/           ← these documents you're reading
├── .env.local            ← your secret Dhan login settings (do NOT share)
├── package.json          ← list of libraries + the commands (dev/build…)
├── next.config.ts        ← Next.js settings
└── README.md             ← short project readme
```

## The 3 important areas to understand

### 1. `app/` — what you see + the server
- The **folders with a `page.tsx`** become **web pages** you can open in the browser.
  - `app/market-simulator/page.tsx` → the page at `/market-simulator`
- The **`app/api/...` folders** are **not pages** — they are little programs that run on the server and do work (like "download data" or "give me the replay"). The pages talk to these.

### 2. `lib/` — the logic
This is where the real work happens, separated from the screens (this is good design — "modular"). Examples:
- [`lib/simulator/replay-engine.ts`](../lib/simulator/replay-engine.ts) — keeps the clock and sends each tick.
- [`lib/backtest/data-downloader.ts`](../lib/backtest/data-downloader.ts) — downloads equity/futures/options data.
- [`lib/dhan/rate-limiter.ts`](../lib/dhan/rate-limiter.ts) — makes sure we don't call Dhan too fast.

### 📄 Quick links to the key code files

- Simulator engine: [config.ts](../lib/simulator/config.ts) · [replay-engine.ts](../lib/simulator/replay-engine.ts) · [data-source.ts](../lib/simulator/data-source.ts) · [quote-synthesizer.ts](../lib/simulator/quote-synthesizer.ts) · [parquet-store.ts](../lib/simulator/parquet-store.ts)
- Backtest: [data-downloader.ts](../lib/backtest/data-downloader.ts) · [backtest-evaluator.ts](../lib/backtest/backtest-evaluator.ts) · [duckdb-schema.ts](../lib/backtest/duckdb-schema.ts)
- Dhan: [auth.ts](../lib/dhan/auth.ts) · [rate-limiter.ts](../lib/dhan/rate-limiter.ts) · [market-feed.ts](../lib/dhan/market-feed.ts)
- Lookups: [master-contracts.ts](../lib/historify/master-contracts.ts) · [duckdb.ts](../lib/historify/duckdb.ts)
- Database: [db.ts](../lib/db.ts) · [schema.prisma](../prisma/schema.prisma)

### 3. `data/` — where everything is saved
- `project-r.db` — one file holding many tables (see doc 5).
- `parquet/` — the Simulator's downloaded candles.
- `tradefinder_platform_trades.json` — the trade list the Downloader reads.

## A note on `_components`, `_hooks`, `_lib`

Inside a page folder you'll see folders starting with an underscore, like `_components`. The underscore tells Next.js: *"these are helper files for this page, not pages themselves."* For example:
- `_components/` — small UI pieces used only by that page.
- `_hooks/` — reusable browser logic (React "hooks").
- `_lib/` — small helpers (types, math) for that page.

👉 Next: [04-the-three-screens.md](04-the-three-screens.md)
