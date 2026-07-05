# Project-R Trading Wiki

A living, LLM-maintained knowledge base for your F&O trading — the "LLM Wiki"
pattern. You curate sources and ask questions; the LLM writes and maintains
every page.

**Open this folder as an Obsidian vault.** Keep the LLM agent on one side and
Obsidian on the other: the LLM edits pages from your conversation; you browse the
results — following `[[links]]`, checking the graph view, reading updated pages.

## How to use it

1. **Drop a source** into `raw/` (a session into `raw/sessions/`, a TradeFinder
   capture into `raw/tf-captures/`, a scorecard into `raw/scorecards/`, an article
   into `raw/articles/`).
2. **Tell the LLM to ingest it.** It reads the source, discusses takeaways, writes
   a summary, and updates the affected stock / sector / setup pages.
3. **Ask questions.** Good answers get filed back as wiki pages, so your
   exploration compounds.
4. **Ask for a lint** now and then — the LLM checks for contradictions, stale
   claims, and gaps.

## Layout

- `CLAUDE.md` — the **schema**: how the LLM maintains this wiki (the key config).
- `index.md` — catalog of every page. `log.md` — timeline of what happened.
- `raw/` — your immutable sources (the LLM never edits these).
- `wiki/` — the LLM-generated pages (`stocks/`, `sectors/`, `setups/`, `sources/`,
  plus `overview.md` and `synthesis.md`). Starts empty; grows as you ingest.

## Optional Obsidian setup (one-time)

- Settings → Files and links → *Attachment folder path* = `raw/assets`.
- **Web Clipper** extension → clip articles into `raw/articles/`.
- **Dataview** plugin → dynamic tables over the page frontmatter.
- **Graph view** → the fastest way to see the shape of the wiki.

It's just markdown in git — version history and diffs for free.
