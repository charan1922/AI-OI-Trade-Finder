# 6. How To Run It — Step By Step ▶️

Follow these in order. You only do the setup steps once.

## What you need first

- **Node.js** installed (version 20+).
- **pnpm** installed (the package manager). If you don't have it: `npm install -g pnpm`.
- A **`.env.local`** file in the project with your Dhan credentials (this was copied over already — see doc 5).
- The **`data/project-r.db`** file present (copied over already, with `master_contracts` filled).

## One-time setup

Open a terminal **inside the project folder** (`D:\Learnings\Project-R\Project-R-simulator`).

```bash
# 1. Install all the libraries the project needs
pnpm install

# 2. Generate the database client (lets the code talk to the DB)
pnpm db:generate
```

> Tip: If you ever see an error like *"Cannot find module '.prisma/client'"*, just run `pnpm db:generate` again and restart.

## Start the app

```bash
pnpm dev
```

Then open your browser at:

```
http://localhost:5001
```

(The number **5001** is set in `package.json`. The big project uses 5000, so they don't clash.)

## Using it, in order

1. **Market Simulator** (`/market-simulator`)
   - Search a stock, pick interval + dates, click **Download**, then **Play**.

2. **Data Downloader** (`/data-downloader`)
   - Click **Download Next 10** to fetch data for recent TradeFinder trades.
   - Watch the badges turn 🟢 **ready**.

3. **Backtest** (`/backtest`)
   - Pick a 🟢 ready trade and look at its charts.

## All the commands you can run

| Command | What it does |
|---------|--------------|
| `pnpm dev` | Start the app in development (auto-reloads on changes), port 5001 |
| `pnpm build` | Build the production version (checks everything compiles) |
| `pnpm start` | Run the production build |
| `pnpm typecheck` | Check the TypeScript types (no errors = good) |
| `pnpm format` | Auto-format the code with Prettier |
| `pnpm db:generate` | Re-create the database client |
| `pnpm db:studio` | Open a visual DB editor (only shows Prisma tables — see doc 8) |

## Stopping the app

In the terminal where `pnpm dev` is running, press **Ctrl + C**.

## First-time checklist ✅

- [ ] `pnpm install` finished without errors
- [ ] `pnpm db:generate` said "Generated Prisma Client"
- [ ] `pnpm dev` shows "Ready" and a localhost link
- [ ] Browser opens `http://localhost:5001` and you see the sidebar
- [ ] Clicking **Data Downloader → Download Next 10** starts downloading

👉 Next: [07-what-i-did.md](07-what-i-did.md)
