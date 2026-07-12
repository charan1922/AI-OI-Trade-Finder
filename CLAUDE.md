# CLAUDE.md — Project-R Simulator

This file extends the parent repo's `../CLAUDE.md` with simulator-specific guidance. Where they conflict, this file wins (the simulator uses **ESLint + Prettier on port 5001**, not Biome/5000; validate with `pnpm lint` and `pnpm typecheck`).

## Auto-Trade Module (`lib/auto-trade/`)

AI-driven order execution over the deterministic `/trade-suggest` scanner. Design law: **the AI proposes, code disposes** — every mutating tool re-runs `risk/gates.ts` in code; no prompt failure can bypass a limit.

### Modes (runtime setting on `/auto-trade`, default `off`)

- `paper` — simulated fills at real live quotes (never fabricated; no quote → order fails)
- `approval` — AI proposes real orders; each waits for a human Approve on `/auto-trade` (approval re-runs all gates against a fresh quote)
- `live` — autonomous real orders. **Two-key rule:** also requires env `AUTO_TRADE_LIVE_ENABLED=true`; the approval mode does NOT need the env key (the human click is the second key)

### Hard limits (user's risk rules — enforced in code, not prompts)

- Entries only **09:45–11:00 IST**; exits any time; forced square-off at **15:12** (`SQUARE_OFF_MIN`)
- Max **2 trades/day**, max **2 open lots**, max **₹60k** deployed premium, **₹3k** daily-loss halt (settings-tunable ranges in `lib/auto-trade/settings.ts`)
- Always 1 lot; scanner picks only (the AI cannot choose symbol/strike/size); no re-entry of a symbol the same day; stop moves may only tighten
- Position guard (premium SL/target + spot plan + square-off) runs BEFORE the AI every pass and under the kill switch — deterministic, works with the LLM down

### Brokers (adapter pattern in `brokers/`)

One active at a time (`broker` setting: `fyers` | `dhan`). Fyers uses the installed `fyers-api-v3` SDK trading methods (ambient types extended in `lib/fyers/fyers-api-v3.d.ts`); Dhan is raw `/v2/orders` REST. Exits always route to the venue the trade opened on. Every order carries a unique idempotency key — retries can never double-fire. **The real broker order APIs are untested against live accounts — watch the first approval/live order manually.**

### One AI analysis per cycle

The auto-trade pass runs FIRST in the Fyers poller's autonomous capture. When its pass produces a read, it is stored into `trade_commentary` (`commentaryStored: true`) and the standalone MiMo commentary is **skipped**. MiMo commentary only runs as the fallback (mode off / kill switch / nothing to decide / AI failed). Never reintroduce a second parallel AI analysis of the same scan — explicit user rule.

### Prompts (battle-tested; versioned)

- `lib/ai-commentary/generate.ts` exports `COMMENTARY_SYSTEM` (the battle-tested narrator — keep byte-identical unless re-benched with `scripts/dry-run-commentary.ts`) plus the shared blocks `COMMENTARY_OUTPUT_FORMAT` / `COMMENTARY_HARD_RULES`
- The auto-trader prompt (`lib/auto-trade/decision/system-prompt.ts`) composes those shared blocks **verbatim** + an executor verdict mapping — one source of truth for the writing rules
- Prompt versioning (`lib/prompts/store.ts`, table `prompt_versions`, page `/prompts`): every distinct prompt text auto-records a new version at generation time; commentary rows carry `promptKey`/`promptVersion`. The table is read-only history — **code stays the source of truth; never make the DB a live prompt override**

### AI providers

`aiProvider` setting: `azure` (Responses API, proven tool-calling) | `mimo` (chat.completions tools; reasoning model — budget max_tokens generously and read `content`). Loop implementations in `lib/auto-trade/decision/providers.ts`.

### Storage & verification

- Tables `auto_trades` / `auto_orders` / `auto_decisions` / `auto_trade_settings` / `prompt_versions` are runtime-created (raw `CREATE TABLE IF NOT EXISTS`), mirrored in `schema.prisma`
- **Never run `prisma db push --accept-data-loss`** — the DB holds six runtime tables never declared in `schema.prisma` (`bhavcopy_fut_expiry`, `bhavcopy_option_expiry`, `bhavcopy_option_strike`, `fno_expiry_calendar`, `market_holidays`, `trade_commentary`); a forced push would drop them with real data
- Bench: `npx tsx scripts/verify-auto-trade.ts` (34 checks: gates, symbology, settings, store math, quiet engine pass) — run before trusting a config change or going toward live
