# Log — Project-R Trading Wiki

Append-only, newest at the bottom. Every entry starts with a grep-able prefix:
`grep "^## \[" log.md | tail -5` shows recent activity.

Format: `## [YYYY-MM-DD] <ingest|query|lint|note> | <short description>`

---

## [2026-07-05] note | vault created — LLM Wiki scaffold
Set up the three layers (raw / wiki / schema), index, and log. No sources
ingested yet; the wiki is empty and ready to grow.

## [2026-07-05] ingest | ADANIPORTS 1780 PE 2026-06-23 — pilot trade page
Set the standard per-trade format (schema § Trade pages) and filled the pilot
from the verified TF ticket + Trade Viewer bars + bhavcopy context:
[[2026-06-23-ADANIPORTS-1780-PE]]. Remaining verified trades follow once the
format is approved.

## [2026-07-06] ingest | TF trader video-method notes → top-down-smart-money
User's two video-analysis summaries stored verbatim in
raw/articles/2026-07-06-tf-video-method-notes.md; derived the method page
[[top-down-smart-money]] (sector-first funnel, confirmation entries, ~₹2.5k
loss cap, ₹25–60k capital, hedging use).

## [2026-07-06] ingest | F&O sector map — 211 stocks × 17 buckets
Built [[fno-sector-map]] from the fno_stocks DB (TF-derived buckets), the
/api/nse/heatmap live feed (NSE index inventory, 03-Jul-2026 close), and
web-verified NIFTY India Defence constituents. Includes bucket↔NSE-index
mapping table, per-bucket stock lists, and classification caveats. Found one
app-code drift: NSE now lists NIFTY CEMENT as a sectoral index but
lib/sector/sectoral-indices.ts still says no cement index exists (not fixed —
app code out of vault scope).

## [2026-07-06] note | sector map regrouped to NSE official classification
User challenged the TF grouping ("i see ADANIPORTS in capital goods?").
Rebuilt [[fno-sector-map]] grouped by NSE's official taxonomy from
ind_nifty500list.csv (niftyindices.com) — all 211 F&O symbols matched, 18 NSE
sectors. ADANIPORTS confirmed NSE **Services** (with GMRAIRPORT). 15 stocks
disagree between the lenses (table on the page): ASHOKLEY→Capital Goods,
DMART/JUBLFOOD/NAUKRI/NYKAA→Consumer Services, ADANIENT→Metals & Mining,
ASIANPAINT→Consumer Durables, LT/RVNL/NBCC→Construction, PAGEIND→Textiles,
SUZLON/INOXWIND/WAAREEENER/PREMIERENE/KAYNES/SUPREMEIND/APLAPOLLO→Capital
Goods. TF buckets kept as per-stock tags (the app still groups by them).
Method note: NSE's per-symbol quote-equity API is bot-blocked server-side
(plain fetch AND headless Chromium); the NIFTY 500 constituent CSV is the
reliable path to the same taxonomy.

## [2026-07-06] note | sector map split into 18 per-sector pages (graph shape)
User: the graph showed one 211-spoke starburst around [[fno-sector-map]].
Split it: 18 NSE-sector pages under wiki/sectors/ (each with its stock list,
TF tags, index-to-watch, quirks), and the map slimmed to a hub (tables +
sector links only). Graph is now map → sectors → stock clusters, mirroring
the top-down funnel. [[capital-goods]] and [[services]] links on the
ADANIPORTS trade page now resolve.

## [2026-07-06] lint | ADANIPORTS sector — TF bucket vs NSE classification
User challenged "capital goods". Verified: our sector map is
TradeFinder-derived (`fno_sectors.json`, seed script `sectorSource: 'tf-map'`);
NSE officially classifies ADANIPORTS as Services → Transport Infrastructure
(Port & Port Services), and NSE has no capital-goods index (/nse/heatmap shows
official NSE sectoral indices only). Decision: app map untouched; vault trade
pages label the peer set "TF sector-scope bucket" and carry an `nse_sector`
frontmatter key + dated note when classifications differ. Schema updated;
[[2026-06-23-ADANIPORTS-1780-PE]] relabeled.

## [2026-07-06] note | trade-page format v2 (user-approved, 9 sections)
Rewrote [[2026-06-23-ADANIPORTS-1780-PE]] to the approved 9-section structure
(Trade Card / Top-Down / Smart Money / Entry / Exit & Management / Risk /
Charts / Read & Lessons / Sources). Added real sector + market breadth from
bhavcopy (capital goods 18/19 red; F&O universe 176/211 red) and the two
trade-viewer chart captures in raw/assets/ (Playwright, light theme). Schema
§ Trade pages updated to match. Rule reaffirmed: propose + get approval BEFORE
ingesting; charts are captured from /trade-viewer, never mocked.
