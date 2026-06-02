# 4. The Three Screens 🖥️

The app has three pages. You switch between them using the **left sidebar**.

---

## Screen 1: Market Simulator 🎬

**URL:** `/market-simulator`

**📄 Code:** [page.tsx](../app/market-simulator/page.tsx) · [SymbolBar](../app/market-simulator/_components/SymbolBar.tsx) · [SimChart](../app/market-simulator/_components/SimChart.tsx) · [use-simulator hook](../app/market-simulator/_hooks/use-simulator.ts) · engine: [replay-engine.ts](../lib/simulator/replay-engine.ts) · download API: [route.ts](../app/api/simulator/download/route.ts)

**What it does:** Replays a past day of a stock like a live market video.

**How you use it:**
1. At the top there's a **Symbol Bar**. You choose:
   - a **stock** (type to search, e.g. "RELIANCE"),
   - **Equity or Futures** (which instrument to replay),
   - the **interval** (1, 5, 15, or 60-minute candles — 5 is the default),
   - a **date range** (which past days to replay).
2. Click **Download** — it fetches that real data from Dhan and saves it (as a Parquet file).
3. Click **Load / Play** — the chart starts moving, candle by candle, like the market is happening live.
4. Use the **transport controls**:
   - **Play / Pause** (or press Space)
   - **Step** one candle forward (→ arrow)
   - **Reset** (R)
   - **Speed** buttons (0.5× up to 60×)
   - A **slider** to jump to any point.

**What you see on screen:**
- A **candlestick chart** with optional lines: VWAP, EMA 9, EMA 20, Volume, and OI (for futures).
- A **Quote Panel**: last price, day high/low, volume, OI, etc.
- A **Depth Ladder**: a 5-level buy/sell book (this part is *estimated*, because 5-min data doesn't include the real order book).

**Important truth:** Every closed candle is the **real** downloaded data — nothing is made up. (The only "made up" bits are the tiny in-between movements and the depth ladder, which exist just to make it feel live. By default the setting is "one real candle per step", so it's pure real data.)

---

## Screen 2: Data Downloader 📥

**URL:** `/data-downloader`

**📄 Code:** [page.tsx](../app/data-downloader/page.tsx) · [download-progress](../app/data-downloader/_components/download-progress.tsx) · [symbol-table](../app/data-downloader/_components/symbol-table.tsx) · [use-download-stream hook](../app/data-downloader/_hooks/use-download-stream.ts) · APIs: [download-stream](../app/api/backtest/download-stream/route.ts), [tf-validate](../app/api/backtest/tf-validate/route.ts) · downloader: [data-downloader.ts](../lib/backtest/data-downloader.ts)

**What it does:** Downloads the price data for **TradeFinder's real past trades**, so you can study them.

**How it works:**
1. It reads the file `data/tradefinder_platform_trades.json` — a list of ~50 real trades (date, stock, CE/PE, strike, profit…).
2. For **each** trade it can download three things (5-minute data, ~45 days before the trade date):
   - the **stock** (equity),
   - its **futures**,
   - the **exact option** that was traded (e.g. ANGELONE 320 CE).
3. It shows each trade with a **status badge**:
   - 🟢 **ready** — all three downloaded.
   - 🟡 **partial** — some downloaded.
   - 🔴 **missing** — nothing yet.

**Buttons:**
- **Download Next 10** — fetches the next 10 not-yet-ready trades.
- **All N** — fetches everything missing.
- Search + filter to find specific trades.
- A live **progress bar** while downloading.

**Where it saves:** into the database tables `backtest_equity`, `backtest_futures`, `backtest_options` (see doc 5).

**The clever part:** many of these trades are on options that have **already expired**. Normal data feeds return nothing for expired options. The downloader automatically switches to a special Dhan endpoint (`rollingoption`) that *does* have expired-option history. (Doc 5 explains this.)

---

## Screen 3: Backtest 📊

**URL:** `/backtest`

**📄 Code:** [page.tsx](../app/backtest/page.tsx) · charts in [_components](../app/backtest/_components) (option-chart, pnl-chart, signal-chart) · review logic: [backtest-evaluator.ts](../lib/backtest/backtest-evaluator.ts)

**What it does:** Lets you **review one downloaded trade** on charts.

**How you use it:**
1. Pick a trade from the dropdown (only "ready" trades have data).
2. It loads that trade's data and shows:
   - **Option price chart** — how the option's price moved during the day (candlesticks).
   - **P&L curve** — profit/loss over the day if you'd held the trade.
   - **Signal chart** — a trend indicator (ADX) plus a "spread ratio" line.
3. You can tweak entry/exit times to simulate the trade.

**Honest note:** This screen uses a **simple signal** (trend strength + price-range expansion) — *not* a smart AI. The AI decision-maker was deliberately left out of this small project (it lives in the big project). So think of this screen as a **chart-based trade review**, not an AI verdict.

---

## How the screens connect to data

```
Market Simulator  ──uses──>  Parquet files   (its OWN downloads)
Data Downloader   ──fills──>  SQLite tables backtest_*
Backtest          ──reads──>  SQLite tables backtest_*  (what the Downloader filled)
```

⚠️ **Key point for beginners:** The **Simulator** and the **Data Downloader** download data **separately** and store it in **different places**. The Simulator does **not** use the Downloader's data, and vice-versa. They are two independent tools that happen to live in the same app. (Doc 5 explains why.)

👉 Next: [05-where-data-comes-from.md](05-where-data-comes-from.md)
