# 5. Where Data Comes From & How It's Stored 🔌💾

This is the most important doc. Take it slowly.

## Step 0: Logging in to Dhan (automatic)

All data comes from **Dhan** (the broker). To get data we must be logged in.

- Your secret settings live in **`.env.local`**:
  ```
  DHAN_CLIENT_ID=...     your Dhan id
  DHAN_PIN=...           your login PIN
  DHAN_TOTP_SECRET=...   the secret behind your 6-digit authenticator code
  ```
- The file [`lib/dhan/auth.ts`](../lib/dhan/auth.ts) uses these to **generate the login token automatically** (using TOTP). It caches the token in `data/.dhan-token.json` so it doesn't log in every time. (All Dhan calls go through [`lib/dhan/rate-limiter.ts`](../lib/dhan/rate-limiter.ts).)
- You normally never touch this — it just works if `.env.local` is correct.

## Step 1: Knowing the "security ID" (master contracts)

Dhan does not understand the name "RELIANCE". It understands a number called a **securityId**.

- The table **`master_contracts`** maps names → IDs (e.g. RELIANCE → some number), and stores option details (strike, type, expiry).
- It is filled by downloading Dhan's big "master CSV" once (code: [`lib/historify/master-contracts.ts`](../lib/historify/master-contracts.ts)). The data already came with this project's database, so it's ready.
- ⚠️ If this table is empty, **nothing can download** (the code can't translate names to IDs). That's why we copied the database with it already filled.

## Step 2: How the Simulator downloads (Parquet path)

When you click **Download** on the Market Simulator:

```
You pick stock + dates
      │
      ▼
/api/simulator/download   (server)
      │  asks Dhan: POST /v2/charts/intraday
      ▼
Dhan returns 5-min candles (open, high, low, close, volume, OI)
      │
      ▼
Saved as a Parquet file in  data/parquet/simulator/
```

Then when you **Play**, the server reads that Parquet file, turns each candle into a stream of "ticks", and sends them to your browser over **SSE** so the chart animates.

## Step 3: How the Data Downloader downloads (SQLite path)

When you click **Download Next 10** on the Data Downloader:

```
Reads data/tradefinder_platform_trades.json  (the trade list)
      │
      ▼
For each trade, /api/backtest/download-stream (server) downloads:
   • equity 5-min   → table backtest_equity
   • futures 5-min  → table backtest_futures
   • the option     → table backtest_options
      │
      ▼
Stored in the SQLite database  data/project-r.db
```

This is **separate** from the Simulator's Parquet files (different tool, different purpose).

## The tricky part: expired options 🕒

Options **expire**. After the expiry date, the option contract no longer exists for trading.

- Dhan's normal endpoint `/v2/charts/intraday` returns **nothing** for an expired option.
- Many TradeFinder trades are months old, so their options are expired.

**The fix (built into [`lib/backtest/data-downloader.ts`](../lib/backtest/data-downloader.ts)):**

1. First it tries the normal `/charts/intraday`.
2. If that returns nothing (expired), it automatically switches to a special endpoint: **`/v2/charts/rollingoption`**.
3. `rollingoption` *does* keep history for expired options. You ask it using:
   - the **underlying stock's** id (not the option's),
   - how far the strike is from **ATM**,
   - which **monthly expiry** (1st, 2nd, or 3rd),
   - **CALL or PUT**.
4. It returns several strikes; the code **keeps only the exact strike** that TradeFinder traded.

This is why, after downloading, even old trades like "ANGELONE 320 CE (19 May)" show up as 🟢 **ready**.

## Where exactly is the data? (the database tables)

The file `data/project-r.db` is a SQLite database with several tables. The ones that matter:

| Table | What's inside | Created by |
|-------|---------------|-----------|
| `master_contracts` | name → securityId, option details | Prisma (in schema) |
| `backtest_equity` | 5-min stock candles | the Downloader (raw SQL) |
| `backtest_futures` | 5-min futures candles + OI | the Downloader |
| `backtest_options` | 5-min option candles (+ OI, IV, spot) | the Downloader |
| `tf_snapshots` | TradeFinder's daily "hot stock" scores (if imported) | optional |

> Note: `backtest_*` tables are created by **raw SQL** in [`lib/backtest/duckdb-schema.ts`](../lib/backtest/duckdb-schema.ts) the first time they're used, **not** in the Prisma schema. That's why **Prisma Studio won't show them**. Use a plain SQLite viewer instead (see [doc 8](08-tips-and-fixes.md)).

## How to picture it all

```
                ┌─────────────── Dhan (internet) ───────────────┐
                │  /charts/intraday   /charts/rollingoption       │
                └───────────────┬───────────────┬────────────────┘
                                │               │
        Simulator download      │               │   Downloader download
                                ▼               ▼
                 data/parquet/*.parquet    data/project-r.db (backtest_* tables)
                                │               │
                                ▼               ▼
                       Market Simulator     Backtest screen
                          (replay)            (charts)
```

👉 Next: [06-run-it-step-by-step.md](06-run-it-step-by-step.md)
