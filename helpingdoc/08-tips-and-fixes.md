# 8. Tips, Common Problems & How To Look At The Data 🧰

## How to SEE the data in the database

The database is the file `data/project-r.db`. It has tables like `backtest_equity`, `backtest_futures`, `backtest_options`.

- ✅ **Use a SQLite viewer** — easiest is **"DB Browser for SQLite"** (free app). Open `data/project-r.db`, click a table, browse rows.
- ✅ Or the command line: `sqlite3 data/project-r.db "SELECT * FROM backtest_options LIMIT 5;"`
- ❌ **Prisma Studio (`pnpm db:studio`) will NOT show `backtest_*`** — those tables are made by raw SQL in [`../lib/backtest/duckdb-schema.ts`](../lib/backtest/duckdb-schema.ts), not defined in [`../prisma/schema.prisma`](../prisma/schema.prisma). Prisma Studio only shows tables in the schema (like `master_contracts`).

The Simulator's data is **not** in the database — it's in **Parquet files** under `data/parquet/simulator/`. You view those through the Simulator screen itself.

## Common problems & fixes

| Problem (message you might see) | What it means | Fix |
|---|---|---|
| `Cannot find module '.prisma/client'` | The DB client wasn't generated | Run `pnpm db:generate`, then restart `pnpm dev` |
| `Master contracts not synced` | The `master_contracts` table is empty (can't translate names → IDs) | Make sure `data/project-r.db` (with data) is present; or sync master contracts |
| `Data API not subscribed` / `DH-902` | Your Dhan account isn't subscribed to the **Data APIs** needed for historical candles | Subscribe to Dhan Data APIs, then retry |
| `429` errors | Too many requests too fast (rate limit) | The code already paces requests via [`../lib/dhan/rate-limiter.ts`](../lib/dhan/rate-limiter.ts); just retry — never run many downloads in parallel |
| Auth / token errors | Login problem | Check `.env.local` has correct `DHAN_CLIENT_ID`, `DHAN_PIN`, `DHAN_TOTP_SECRET` |
| A trade stays 🔴/🟡 | Some data couldn't be fetched | See the BAJAJ-AUTO note below |

## The BAJAJ-AUTO note (one trade is "partial")

When we tested, **BAJAJ-AUTO** downloaded its stock and option data, but its **futures** failed with *"Futures not found"*.

- **Why:** the symbol has a hyphen (`BAJAJ-AUTO`). The futures lookup in [`../lib/historify/master-contracts.ts`](../lib/historify/master-contracts.ts) didn't match it (the futures contract is likely stored under a slightly different name like `BAJAJAUTO`).
- **Effect:** that trade shows 🟡 **partial** (no futures), but its option data is fine.
- **Fix (optional):** improve the symbol matching in `master-contracts.ts` to handle hyphenated names. Not done yet — small, separate task.

## Code style (Prettier)

The copied code uses single quotes / a different style than your scaffold's Prettier setup. This is **only cosmetic** — it does not affect the build. If you want everything to match your style, run:

```bash
pnpm format
```

## The harmless build warning

When you run `pnpm build`, you may see a Turbopack warning about `process.cwd()` in [`../lib/backtest/data-downloader.ts`](../lib/backtest/data-downloader.ts). This is **safe to ignore** — it's just about reading the `tradefinder_platform_trades.json` file at runtime, which works fine.

## Where to change common things

| You want to… | Edit this file |
|---|---|
| Change the port (5001) | [`../package.json`](../package.json) (the `dev`/`start` scripts) |
| Add/remove a sidebar menu item | [`../components/app-sidebar.tsx`](../components/app-sidebar.tsx) |
| Change default simulator settings (interval, speed, seed) | [`../lib/simulator/config.ts`](../lib/simulator/config.ts) |
| Change download lookback / option logic | [`../lib/backtest/data-downloader.ts`](../lib/backtest/data-downloader.ts) |
| Change the entry/exit charge model | [`../lib/ai-trading/commissions.ts`](../lib/ai-trading/commissions.ts) |
| Add a new database table (typed) | [`../prisma/schema.prisma`](../prisma/schema.prisma) then `pnpm db:generate` |

## Safety reminders

- `.env.local` contains **secret login info** — never commit it or share it.
- This app only **reads** market data. It does not trade real money.
- Don't run many Dhan downloads at the same time (rate limits).

## Quick map of the most useful files

- Simulator heart → [`../lib/simulator/replay-engine.ts`](../lib/simulator/replay-engine.ts)
- Simulator download → [`../app/api/simulator/download/route.ts`](../app/api/simulator/download/route.ts) + [`../lib/simulator/data-source.ts`](../lib/simulator/data-source.ts)
- Trade data download → [`../app/api/backtest/download-stream/route.ts`](../app/api/backtest/download-stream/route.ts) + [`../lib/backtest/data-downloader.ts`](../lib/backtest/data-downloader.ts)
- Trade status check → [`../app/api/backtest/tf-validate/route.ts`](../app/api/backtest/tf-validate/route.ts)
- Backtest review logic → [`../lib/backtest/backtest-evaluator.ts`](../lib/backtest/backtest-evaluator.ts)

⬅ Back to [README.md](README.md)
