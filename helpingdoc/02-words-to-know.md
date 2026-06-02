# 2. Words To Know (Plain-English Glossary) 📚

Don't memorize these — just refer back when a word confuses you.

## Stock-market words

- **Stock / Equity** — A share of a company (e.g. RELIANCE, TATASTEEL). "Equity" is the formal word for a normal stock.

- **F&O (Futures & Options)** — Special contracts whose price is based on a stock. This project mostly deals with these.

- **Futures** — A contract to buy/sell a stock at a future date. Traders use it to bet on price direction. It has extra info like **Open Interest**.

- **Option** — A contract that gives the right (not obligation) to buy or sell a stock at a fixed price. Two types:
  - **CE (Call)** — you profit if the price goes **UP**.
  - **PE (Put)** — you profit if the price goes **DOWN**.

- **Strike (strike price)** — The fixed price written in an option. Example: "TATASTEEL 190 PE" means a Put option at strike 190.

- **ATM (At The Money)** — An option whose strike is **closest to the current stock price**. Traders often buy ATM options.

- **Expiry (expiry date)** — The date an option/future stops existing. After expiry the contract is **"expired"** and normal data feeds no longer return its data (this matters a lot — see doc 5).

- **Spot price** — The current actual price of the stock itself (not the option).

- **OI (Open Interest)** — How many option/future contracts are currently "open" (held by traders). Rising OI can mean big players are building positions. Only futures/options have OI; plain stocks don't.

- **Lot / Lot size / Quantity** — Options are traded in fixed bundles called "lots". `quantity = lots × lot size`.

- **Intraday** — "Within one day." Intraday data = price during a single trading day.

- **TradeFinder (TF)** — An external trading tool/person. We have a file of **their real past trades** (`tradefinder_platform_trades.json`). The Data Downloader uses it to know which trades to fetch data for.

## Chart / data words

- **Candle / OHLC** — One bar on a candlestick chart. It shows 4 prices for a time period: **O**pen, **H**igh, **L**ow, **C**lose, plus **Volume** (how much traded).

- **5-min candle** — One candle that covers 5 minutes. A full trading day has many 5-min candles. This is the default data size we download.

- **Volume** — How many shares/contracts traded in that candle.

- **VWAP** — "Volume Weighted Average Price" — an average price line traders watch.

- **EMA** — "Exponential Moving Average" — a smooth average line (EMA 9, EMA 20).

- **ADX / +DI / -DI** — Indicators that measure how strong a trend is and its direction (up or down).

## Tech words

- **API** — A way for our program to ask Dhan's servers for data over the internet. We "call an API endpoint" like `/v2/charts/intraday`.

- **Endpoint** — One specific API address that does one job (e.g. "give me 5-min candles").

- **Rate limit** — Dhan only allows a certain number of requests per second. We must go slowly or we get blocked. (Data: 10/sec, Quote: 1/sec.)

- **TOTP** — The 6-digit code from an authenticator app. Our code uses your secret to generate it automatically and log in to Dhan (so you don't paste tokens manually).

- **SSE (Server-Sent Events)** — A way for the server to **stream** updates to the browser continuously (one message after another). The simulator uses this to send each "tick" of the replay.

- **Tick** — One tiny update of price, like one heartbeat of the market.

- **SQLite** — A database that is just **one file** on your disk (`data/project-r.db`). Easy, no setup.

- **Parquet** — A file format that stores table data compactly. The simulator saves downloaded candles as Parquet files.

- **Prisma** — A tool that lets our code talk to the SQLite database in a clean way.

- **Backtest** — Testing a strategy or reviewing a trade using **past** data, to see what would have happened.

- **Simulation / Replay** — Playing past data back over time, as if it were happening live.

👉 Next: [03-folders-explained.md](03-folders-explained.md)
