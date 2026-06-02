# 1. What Is This Project? 🎯

## The simple idea

Imagine you could **record** the stock market on a past day, then **play it back** like a video — pause it, fast-forward it, study it. That is what this project does, plus two helper screens.

It is a **website that runs on your own computer** (not on the internet). You open it in your browser at `http://localhost:5001`.

## Why does it exist?

There was already a **big project** called `Project-R`. Over time it grew very large and complicated (lots of features: AI trading, market intelligence, analytics…). That made it hard to work on.

So we created **this smaller project** that contains **only** the parts needed for two jobs:

1. **Simulation** — replaying past market data.
2. **Backtesting** — checking how past trades played out.

Everything else (the AI brain, the scoring engine, etc.) was **left out on purpose** to keep this one simple. It still lives in the big project.

## What can you actually do with it?

The app has **three screens**:

1. **Market Simulator** 🎬
   Pick a stock and a past date range, download its data, then **play it back** on a candlestick chart that moves like a live market. You can pause, step forward one bar at a time, and change speed.

2. **Data Downloader** 📥
   It reads a list of **real past trades** (from a file called `tradefinder_platform_trades.json`) and downloads the price data for each one — the stock, its futures, and the exact option that was traded. It shows you which trades have data ("ready") and which don't ("missing").

3. **Backtest** 📊
   Pick one of those downloaded trades and see it on charts: the option's price during the day, a profit/loss curve, and a "signal" chart.

## What it is NOT

- It is **not** connected to real money or real trading. It only **reads** market data.
- It does **not** place orders.
- It does **not** include the AI decision-maker (that's in the big project).

## The technologies (just so the words aren't scary)

| Word | What it means here |
|------|--------------------|
| **Next.js** | The framework that builds the website (pages + server). |
| **React** | The library that draws the screens in the browser. |
| **TypeScript** | JavaScript with type-checking (catches mistakes early). |
| **Prisma + SQLite** | A small database stored in one file (`data/project-r.db`). |
| **DuckDB / Parquet** | A way to store lots of data efficiently in files. |
| **Tailwind / shadcn** | Tools that make the buttons and layout look nice. |
| **Dhan** | The Indian stock broker whose data we download. |

👉 Next: [02-words-to-know.md](02-words-to-know.md)
