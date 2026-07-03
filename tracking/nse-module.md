# NSE module — free official NSE feeds (`/nse/*`), explained

Built 2026-06-20. A self-contained module that powers two pages — **NSE Heatmap** and **NSE Market Movers** — entirely from NSE's free public web APIs (nseindia.com). No Dhan auth, no token, no TOTP. Lives under `nse/` folders so the whole feature is one cohesive, removable unit.

## 1. Why this module exists

The existing Dhan `/heatmap` reconstructs each sector's move (turnover-weighted) and cross-checks it against the official NSE sectoral index — but that official side comes from **Dhan's IDX_I quote**, which zeroes `net_change` once the session closes, so it reads **0.00% after hours** and needs a live Dhan token.

NSE's own site exposes the same numbers for free, and they stay meaningful 24/7 (they carry `previousClose`). So this module reads **straight from NSE** — the canonical source — giving an official, broker-independent view that also works on weekends.

## 2. The NSE endpoints (probed 2026-06-20)

NSE has **no published rate limit** for these `/api/*` endpoints; it enforces anti-bot throttling instead (rapid bursts start returning empty bodies). Reachability was probed directly from the server.

### Working (used)
| Endpoint | Returns | Used by |
| --- | --- | --- |
| `/api/allIndices` | 139 indices — `percentChange`, `last`, `previousClose` | NSE Heatmap |
| `/api/marketStatus` | open/closed, NIFTY 50, GIFT Nifty, total market cap | status strip (both pages) |
| `/api/live-analysis-variations?index=gainers\|loosers` | top ~20 per group (`allSec`, `FOSec`, `NIFTY`…) — `ltp`, `perChange`, `turnover` | Movers — Gainers/Losers |
| `/api/live-analysis-most-active-securities?index=value\|volume` | top 20 — `pChange`, `totalTradedValue` (₹), OHLC | Movers — Most Active |
| `/api/live-analysis-oi-spurts-underlyings` | **all 216 F&O underlyings** — OI change %, fut/opt value, underlying price | Movers — F&O OI Build-up |

### Working but intraday-only (NOT wired yet)
| Endpoint | Returns | Note |
| --- | --- | --- |
| `/api/chart-databyindex?index=NIFTY 50&indices=true` | intraday points for one index → sparklines | `grapthData` is **empty on weekends**; only populates during/after a live session |
| `/api/option-chain-equities?symbol=RELIANCE` | per-stock option chain (CE/PE OI, Greeks) | returns **empty when market closed** |

Held off on these two until they can be built against their real live shape (rather than guessing a structure off an empty weekend payload).

### Blocked from the server (403/404)
`/api/equity-stockIndices` (index constituents) · `/api/quote-equity` (single stock) · `/api/option-chain-indices`. So a *live, complete, per-stock-by-index* heatmap is not possible from NSE here — the full F&O per-stock list with live % needs the `oi-spurts` price + bhavcopy `previousClose` hybrid, or EOD bhavcopy.

## 3. Architecture — everything under `nse/`

```
lib/nse/                  data layer (NSE fetching only)
  client.ts               shared cookie cache + nseApiGet (one warm-up shared by all routes)
  indices.ts              fetchNseAllIndices()  → allIndices
  pulse.ts                fetchMarketStatus() + per-feed fetchers via FEED_FETCHERS registry → movers + status feeds
app/nse/                  UI
  _lib/heat.ts            finviz colour scale + formatters (fmtNum, fmtCr, fmtPct, pctClass)
  _components/            <MarketStatusStrip/>, <IndexTile/>
  heatmap/page.tsx        → /nse/heatmap
  movers/page.tsx         → /nse/movers          (LIVE intraday snapshot)
  movers-history/page.tsx → /nse/movers-history   (EOD, date-picked, from bhavcopy)
app/api/nse/
  heatmap/route.ts        → /api/nse/heatmap         (allIndices + marketStatus, 60s cache, serve-stale)
  pulse/[feed]/route.ts   → /api/nse/pulse/[feed]     (one mover feed each, per-feed 30s cache, serve-stale; feed ∈ FEED_KEYS)
  movers-history/route.ts → /api/nse/movers-history  (pure bhavcopy_days read; ?dates=true | ?date=YYYY-MM-DD)
```

Sidebar (after the Dhan "Heatmap"): **NSE Heatmap** (`/nse/heatmap`), **NSE Movers** (`/nse/movers`, live), **EOD Movers** (`/nse/movers-history`, historical).

### Gotchas — why live and EOD differ (both real, neither fabricated)
> **UPDATE 2026-06-30:** the two differences below were *closed* so EOD now matches the live feed — see [`eod-movers-lot-size-fix.md`](./eod-movers-lot-size-fix.md). Price/% now use the last-traded price (not the official close), and OI is counted in **contracts** (per-expiry OI ÷ that expiry's board lot) instead of summed shares — which fixes lot-revision names like MCX that previously flipped sign. The notes below are kept for context on what the original behaviour was.
- **Price %** (gainers/losers/most-active): live uses **LTP (last traded price)**; EOD bhavcopy uses NSE's **official closing price** (last-30-min weighted avg / closing auction). Previous close matches to the rupee — only the "current price" differs, so the % differs slightly.
- **OI build-up**: NSE's live "OI spurts" measures **total derivatives OI = futures + options** (`futOi + optOi`), NOT futures-only. The EOD route must sum both (verified: matches live to the decimal for most names). Using `futOiChange` alone was wrong (INFY read 12% vs the correct 25%).
- Residual tiny OI gaps on a few names = live is an intraday OI snapshot vs EOD final settlement OI.

### EOD Movers (`/nse/movers-history`)
The historical counterpart to the live movers page — a date picker (◀ / session dropdown / ▶, 129 sessions 2025-12-09 → 2026-06-19) over **NSE bhavcopy** in the DB. For any session it reconstructs, **close-to-close**, the F&O OI Build-up, Most Active (value/volume), and Top Gainers/Losers. Pure DB read, no NSE/Dhan calls, no impact on the live page. Live NSE mover feeds are current-snapshot only (no date param), so this is the only way to view a past session — and it's EOD granularity, not the intraday snapshot the live page shows.

## 4. The two pages

**`/nse/heatmap`** — official NSE indices as colour-by-%-change tiles.
- **Main sectors** view (default): the ~17 sectoral indices that mirror the Dhan heatmap buckets (IT, BANK, PVT/PSU BANK, FIN SERVICE, AUTO, PHARMA, FMCG, METAL, ENERGY, REALTY, CEMENT, CONSUMER DURABLES, CHEMICALS…), **ordered by magnitude of move** (biggest mover first, like the Dhan heatmap), plus a broad-market strip (NIFTY 50, NEXT 50, 500, MIDCAP/SMALLCAP 100, INDIA VIX).
- **All indices** view: every one of the 139, grouped by NSE category.
- A market-status strip (open/closed · NIFTY 50 · GIFT Nifty · market cap) sits under the header.

**`/nse/movers`** — market-activity dashboard, dense (small fonts, multi-column tables to fit the viewport). Panels in order:
1. **F&O OI Build-up** — top OI increases (fresh positions), full F&O universe.
2. **Most Active** — Value / Volume toggle.
3. **Top Gainers / Losers** — universe toggle (All / F&O / Nifty 50).
4. **52-Week Highs**.

## 5. Rate-limit & refresh strategy

- **Cookie cached 3 min** in `client.ts`, shared by every NSE route — one warm-up, not one per call (this is what stops the throttling seen while exploring).
- **Per-route response cache**: heatmap 30s, pulse 60s — many tabs + the page poll collapse into ≤1 upstream fetch per window.
- **Adaptive polling** on the pages: **60s while the market is open, 5 min when closed** (closed data is the static last session). One pulse refresh ≈ 7 upstream NSE calls, so ~7/min on a single cookie session while open — comfortably under NSE's throttle.
- 401/403 invalidates the cached cookie and retries once with a fresh one.

## 6. Data honesty (no fabrication)

- Every displayed number maps a **real NSE field** — nothing hardcoded, sampled, or assumed.
- Index rows without a genuine `previousClose` are **dropped, not faked**.
- The only curation is *which* real indices to feature (the main-sectors allowlist) — a selection, not invented data.

## 7. What this module is NOT

- **Not live per-stock-by-sector.** NSE blocks the index-constituent endpoint here, so the heatmap is index-level; the movers lists are NSE's own top-20 (gainers/losers/most-active) plus the full-216 OI feed.
- **Not intraday charts / option chains yet** — those two endpoints are empty outside live hours (see §2).
- After hours / weekends it shows the **real last session** (e.g. 19-Jun), clearly labelled — not a placeholder. Live values resume at 9:15 IST.

## 8. Verification (build day, market closed — last session 19-Jun-2026)

End-to-end probe of every wired endpoint returned real, internally-consistent data:
- Status: Closed · NIFTY 50 24013.1 −0.64% · GIFT 24042 −0.2% · Mkt Cap ₹477.25 L Cr.
- NIFTY IT −3.65% (sector); INFY −6.5% shows up as top F&O loser, most-active stock, **and** a +25.1% OI build-up — the same name across feeds.
- OI spurts: 216 underlyings (145 OI-up / 71 down); most-active 20; gainers/losers 20 each; 52-wk highs 126.
- ESLint + `tsc --noEmit` clean across the whole module; both pages and both APIs return HTTP 200.

## 9. Next steps (in order of value)

1. **Wire the official NSE sector % into the Dhan `/heatmap` cross-check** (the original thread) — replace the post-market-broken Dhan IDX_I source with `allIndices`, so the reconstruction-vs-official validation works 24/7.
2. **Add the two intraday endpoints once verified live** (Monday): `chart-databyindex` sparklines on index tiles; an on-demand `option-chain-equities` panel (one call per chosen stock — rate-safe).
3. Consider a per-stock NSE sector heatmap via the `oi-spurts` (live price) + bhavcopy (`previousClose`) hybrid — the only NSE-only path to a *complete* live per-stock view.
