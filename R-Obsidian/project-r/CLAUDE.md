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
    └── sources/         one summary page per ingested source
```

## Page conventions

- **Links:** Obsidian **wikilinks** — `[[RELIANCE]]`, `[[options-led-build]]`.
  Link liberally; a link to a page that doesn't exist yet is fine (it marks a
  page to create). This is what makes the graph view useful.
- **Frontmatter (required on every wiki page)** — Dataview-friendly:
  ```yaml
  ---
  type: stock | sector | setup | source | overview | synthesis
  tags: [searchable, keywords]
  created: 2026-07-05        # first authored (IST date)
  updated: 2026-07-05        # last touched
  sources: 0                 # how many raw sources feed this page
  ---
  ```
- **Dates:** always IST, absolute (`2026-07-05`), never "yesterday"/"last week".
- **Naming:** stocks = exchange symbol UPPERCASE; sectors/setups = kebab-case;
  source pages prefixed with date (`2026-07-03-session.md`).
- **Provenance:** every non-obvious claim cites its source — a raw source
  (`[[2026-07-03-session]]`) or a verified figure. If it's an inference, say so.

## Operations

### Ingest (a new source arrives in `raw/`)
1. Read the source fully.
2. Briefly discuss the key takeaways with the user (unless told to batch).
3. Create `wiki/sources/<date>-<slug>.md` — a summary with frontmatter.
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
