# Project-R Trading Wiki — schema & operating manual

This file is the **schema** for an LLM-maintained trading knowledge base (the
"LLM Wiki" pattern). It tells you — the LLM agent — how this wiki is structured
and how to maintain it. It governs only the `R-Obsidian/project-r/` vault.

> **Roles.** Obsidian is the IDE; you (the LLM) are the programmer; this vault is
> the codebase. The user curates sources and asks questions. You do ALL the
> writing — summarizing, cross-referencing, filing, bookkeeping. The user never
> writes wiki pages by hand.

## The three layers

1. **`raw/` — immutable sources.** Session tapes, TradeFinder captures,
   scorecards, clipped articles, screenshots. You **read** these; you **never
   modify** them. This is the source of truth.
2. **`wiki/` — LLM-owned pages.** Everything you generate: per-stock and
   per-sector entity pages, setup/pattern pages, source summaries, the overview,
   the synthesis. You own this layer entirely. It starts empty and grows as the
   user ingests sources.
3. **schema — this file.** Co-evolve it with the user as conventions settle.

## Trader context (what the wiki serves)

- Indian **F&O**, capital **₹50–60k** → normally **one lot**.
- Buys **near-ATM options** — **CE** bullish, **PE** bearish.
- Morning window **09:40–11:00 IST**; hunts the `/nse/movers` feeds (OI spurts,
  gainers/losers, most-active).

## Directory map

```
R-Obsidian/project-r/
├── CLAUDE.md            ← this schema
├── README.md           ← human orientation
├── index.md            ← content catalog (you update every ingest)
├── log.md              ← append-only timeline (you append every op)
├── raw/                ← immutable sources (read-only)
│   ├── sessions/        daily session tapes / observations
│   ├── tf-captures/     TradeFinder captures
│   ├── scorecards/      trade-suggest scorecards
│   ├── articles/        clipped articles
│   └── assets/          images / attachments
└── wiki/               ← LLM-owned generated pages (starts empty)
    ├── overview.md      entry point + current state
    ├── synthesis.md     the evolving "what works for me" thesis
    ├── stocks/          per-symbol pages (UPPERCASE symbol, e.g. RELIANCE.md)
    ├── sectors/         per-sector pages (kebab-case, e.g. pharma.md)
    ├── setups/          setup / pattern pages (kebab-case)
    ├── trades/          one page per verified trade (see "Trade pages")
    └── (sources live in raw/ verbatim — no wiki/sources summary pages)
```

## Page conventions

- **Links:** Obsidian **wikilinks** — `[[RELIANCE]]`, `[[options-led-build]]`.
  Link liberally; a link to a page that doesn't exist yet is fine (it marks a
  page to create). This is what makes the graph view useful.
- **Frontmatter (required on every wiki page)** — Dataview-friendly:
  ```yaml
  ---
  type: stock | sector | setup | trade | source | overview | synthesis
  tags: [searchable, keywords]
  created: 2026-07-05        # first authored (IST date)
  updated: 2026-07-05        # last touched
  sources: 0                 # how many raw sources feed this page
  ---
  ```
- **Dates:** always IST, absolute (`2026-07-05`), never "yesterday"/"last week".
- **Naming:** stocks = exchange symbol UPPERCASE; sectors/setups = kebab-case;
  source pages prefixed with date (`2026-07-03-session.md`); trade pages
  `YYYY-MM-DD-SYMBOL-STRIKE-CE|PE.md` (date-first → sorts chronologically).
- **Provenance:** every non-obvious claim cites its source — a raw source
  (`[[2026-07-03-session]]`) or a verified figure. If it's an inference, say so.

## Trade pages (standard format)

One file per verified trade in `wiki/trades/`. Data sources: the TF ticket
(`data/tradefinder_platform_trades.json` — verified execution), Trade Viewer
5-min bars (`backtest_equity`/`backtest_options`), and the NSE-bhavcopy
trade-context insight. Only real numbers from those sources — anything missing
is written "not recorded", never estimated.

Frontmatter (with the required keys above):

```yaml
type: trade
symbol: ADANIPORTS        # UPPERCASE exchange symbol
sector: capital-goods     # kebab-case — the app's TF-derived bucket (fno_sectors.json)
nse_sector: services      # NSE official classification, ONLY when it differs
trade_date: 2026-06-23
side: PE                  # CE | PE
strike: 1780
expiry: 2026-06-30
entry_time: "10:20"       # IST 24h
entry_premium: 6.4663
exit_time: "12:10"
exit_premium: 18.70
lots: 3
lot_size: 475
quantity: 1425
capital_used: 9215
pnl: 17433
return_pct: 189.2         # on premium
hold_minutes: 110
result: win               # win | loss | scratch
verified: true            # broker-verified entry/exit exist
```

Body — fixed heading order (approved 2026-07-06; mirrors the trader's
[[entry-setups]] method):

1. Title `# SYMBOL STRIKE SIDE — date`, then a one-line bold verdict
   (result · ₹ · % · hold time · max heat).
2. `## 1 · Trade Card (verified execution)` — the verified fills as a
   `| Field | Value |` table; name the verification source.
3. `## 2 · Top-Down: Market & Sector` — market breadth (our F&O bhavcopy
   universe up/down counts + avg), sector peer breadth and where the stock
   ranked (computed from `bhavcopy_days` closes × `fno_sectors.json`), index/
   VIX if recorded. Label the peer set as the "TF sector-scope bucket" — the
   map is TradeFinder-derived, not NSE's taxonomy; when NSE's official
   classification differs, add a dated classification note (e.g. ADANIPORTS:
   TF bucket capital goods, NSE Services → Transport Infrastructure).
4. `## 3 · Smart Money Evidence (why this stock)` — futures OI (day-on-day,
   5-session, 20-session level, quadrant read); futures turnover vs 30-day
   average; option flow (traded-strike OI change, contract-month OI, OI
   level); direction-agreement check; R-Factor if recorded for that date.
5. `## 4 · Entry: Confirmation, not prediction` — minutes after open, what
   was already established, entry-bar signal state (ADX/±DI), moneyness,
   premium vs day low.
6. `## 5 · Exit & Trade Management` — exit vs hold-period best print, max
   favorable/adverse excursion during the hold (from 5-min bars), points
   banked vs the day's best case, booked-target vs trailed read.
7. `## 6 · Risk` — worst case = premium paid vs capital; ticket SL (usually
   "not recorded"); the ~₹2.5k loss-cap applied to this position (label it
   derived-from-rule, not from the ticket); return on capital used.
8. `## 7 · Charts` — the two trade-viewer panels embedded:
   `<date>-<SYMBOL>-<strike>-<side>-option.png` and `...-equity.png`
   (embed with Obsidian's image-embed syntax).
   PNGs live in `raw/assets/`, captured from `/trade-viewer` via the
   Playwright script (parent repo's install; scratchpad
   `capture-trade-charts.js` pattern) — never hand-drawn or mocked.
9. `## 8 · Read & Lessons` — the grounded story + reusable pattern notes;
   every claim tied to a number above; wikilink setups and the stock page.
10. `## 9 · Sources` — where each number came from.

Tickets without verified entry/exit (`verified: false`) get the Trade Card
with known fields only, plus Top-Down and Smart Money Evidence. Pilot/
reference example: `wiki/trades/2026-06-23-ADANIPORTS-1780-PE.md`.

## Operations

### Ingest (a new source arrives in `raw/`)
1. Read the source fully.
2. Briefly discuss the key takeaways with the user (unless told to batch).
3. Store the source verbatim under `raw/` (one file per source with a short
   provenance header). No separate wiki summary page per source — derived
   understanding goes straight into the affected consolidated pages (the
   user's few-docs rule; practice settled 2026-07-06).
4. Update every affected page: the **stocks** named, their **sectors**, any
   **setup** the source illustrates, and the **synthesis** if it shifts the
   thesis. A single source often touches several pages.
5. If a source contradicts an existing claim, **flag it on both pages** with the
   dates — do not silently overwrite. Newer verified data wins; history stays.
6. Update `[[index]]` and append to `[[log]]`.

### Query (the user asks a question)
1. Read `[[index]]` first to find relevant pages, then drill in.
2. Answer with citations to wiki pages / raw sources.
3. **File good answers back** as new wiki pages — a comparison, a discovered
   pattern, a per-stock finding shouldn't vanish into chat. Explorations compound
   like sources do.

### Lint (health check, on request or periodically)
- **Contradictions** — a stock's read on two dates that disagree with no noted reason.
- **Stale claims** — a synthesis claim a newer source has superseded.
- **Orphans** — a page with no inbound links.
- **Missing pages** — a symbol/sector/setup referenced repeatedly with no page.
- **Data gaps** — claims that could be confirmed but haven't been.
- Suggest new questions to investigate and sources to capture.

## index.md and log.md

- **index.md** — content catalog by category (Overview, Synthesis, Stocks,
  Sectors, Setups, Sources). Each entry: `[[link]]` + one-line summary. Update on
  every ingest and every filed query answer.
- **log.md** — append-only, newest at bottom. Every entry starts with a grep-able
  prefix so `grep "^## \[" log.md | tail -5` shows recent activity:
  ```
  ## [2026-07-05] ingest | 2026-07-03 morning session
  ## [2026-07-05] query  | which setups stopped out on gap-downs?
  ## [2026-07-05] lint   | flagged 2 stale synthesis claims
  ```

## Hard rules (non-negotiable)

- **No fabrication.** Never invent a price, OI, premium, Greek, win-rate, or
  R-Factor. Every number traces to a raw source or a verified figure — else say
  "not recorded / unknown".
- **Verify before asserting.** When a figure looks off, check the source before
  trusting it.
- **No orders, ever.** This wiki is analysis.
- **Ask, don't assume.** Ambiguous intent → ask before writing.
- **Don't touch `raw/`.** Read-only. Don't stage/commit unless the user says.
