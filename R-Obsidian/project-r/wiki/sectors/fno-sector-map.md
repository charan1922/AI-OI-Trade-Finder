---
type: sector
tags: [sector-map, reference, fno, heatmap, top-down, nse-official]
created: 2026-07-06
updated: 2026-07-06
sources: 0
---

# F&O Sector Map — 211 stocks, 18 NSE sectors

The step-1 lookup for the [[top-down-smart-money]] funnel: sector first, then
the F&O names inside it. This is the **hub** — each sector below is its own
page holding the stock list. Grouping is **NSE's official industry
classification** (NIFTY 500 constituent file; all 211 F&O symbols matched).

Two lenses exist for "sector" and they disagree for ~15 stocks:

1. **NSE official (these pages).** NSE Indices' industry taxonomy — the same
   one behind the sectoral indices on `/nse/heatmap`.
2. **TF buckets (what the app's pages group by).** `fno_stocks` DB, seeded
   from the TradeFinder-derived `fno_sectors.json`. Where a stock's TF bucket
   differs, its sector page tags it `(TF: …)`.

## Sectors

| NSE sector | Stocks | Index to watch on the heatmap | TF bucket(s) |
| --- | --- | --- | --- |
| [[financial-services]] | 56 | NIFTY BANK · FIN SERVICE · PVT BANK · PSU BANK | FIN SERVICE + PVT BANK + PSU BANK |
| [[capital-goods]] | 23 | — (NIFTY IND DEFENCE thematic covers the defence names) | CAPITAL GOODS (mostly) |
| [[healthcare]] | 16 | NIFTY PHARMA · NIFTY HEALTHCARE | PHARMA |
| [[auto]] | 16 | NIFTY AUTO | AUTO |
| [[fmcg]] | 14 | NIFTY FMCG | FMCG |
| [[it]] | 12 | NIFTY IT | IT |
| [[metals-mining]] | 10 | NIFTY METAL | METAL |
| [[consumer-durables]] | 10 | NIFTY CONSR DURBL | CONSUMER DURABLES |
| [[oil-gas]] | 9 | NIFTY OIL AND GAS | ENERGY (oil half) |
| [[consumer-services]] | 9 | NIFTY CONSUMPTION (thematic) | CONSUMER SERVICES + strays |
| [[power]] | 8 | NIFTY ENERGY (thematic) | ENERGY (power half) |
| [[realty]] | 6 | NIFTY REALTY | REALTY |
| [[services]] | 5 | NIFTY SERV SECTOR (thematic) | SERVICES + ADANIPORTS/GMRAIRPORT |
| [[construction-materials]] | 5 | NIFTY CEMENT | CEMENT |
| [[chemicals]] | 5 | NIFTY CHEMICALS | CHEMICALS |
| [[telecom]] | 3 | — (NIFTY MS IT TELCM is midsmall-only) | TELECOM |
| [[construction]] | 3 | NIFTY INFRA (thematic) | strays from CAPITAL GOODS/REALTY |
| [[textiles]] | 1 | — | stray from CONSUMER DURABLES |

## Where the two lenses disagree (all 15)

| Stock | NSE official | TF bucket |
| --- | --- | --- |
| ADANIPORTS | [[services]] | CAPITAL GOODS |
| GMRAIRPORT | [[services]] | CAPITAL GOODS |
| LT | [[construction]] | CAPITAL GOODS |
| RVNL | [[construction]] | CAPITAL GOODS |
| NBCC | [[construction]] | REALTY |
| ASHOKLEY | [[capital-goods]] | AUTO |
| APLAPOLLO | [[capital-goods]] | METAL |
| KAYNES | [[capital-goods]] | CONSUMER DURABLES |
| SUPREMEIND | [[capital-goods]] | CHEMICALS |
| SUZLON / INOXWIND / WAAREEENER / PREMIERENE | [[capital-goods]] | ENERGY |
| ADANIENT | [[metals-mining]] | ENERGY |
| ASIANPAINT | [[consumer-durables]] | CHEMICALS |
| PAGEIND | [[textiles]] | CONSUMER DURABLES |
| DMART / JUBLFOOD | [[consumer-services]] | FMCG |
| NAUKRI | [[consumer-services]] | IT |
| NYKAA | [[consumer-services]] | FIN SERVICE |

The app's pages (heatmap aggregate, sector-leaders) still group by the TF
buckets — use these pages to translate when the two lenses disagree.

## The heatmap lens (`/nse/heatmap`)

The page curates 17 official indices as "main sectors" (BANK, PVT BANK, PSU
BANK, FIN SERVICE, IT, AUTO, PHARMA, HEALTHCARE, FMCG, METAL, ENERGY,
OIL & GAS, REALTY, CEMENT, CONSUMER DURABLES, CHEMICALS, MEDIA) plus a
broad-market strip (NIFTY 50, NEXT 50, NIFTY 500, MIDCAP 100, SMALLCAP 100,
INDIA VIX). NSE has a MEDIA sectoral index but no media name is in the F&O
universe. NSE's live feed also lists NIFTY CEMENT as a sectoral index (the
app's `sectoral-indices.ts` comment saying otherwise is stale).

## Sources

- **NSE official classification:** `ind_nifty500list.csv` from
  niftyindices.com (NSE Indices Ltd), Industry column — fetched 2026-07-06;
  all 211 F&O symbols matched. (Direct per-symbol `quote-equity` API is
  bot-blocked server-side; the constituent CSV is the same taxonomy.)
- **TF buckets:** `fno_stocks` table (SQLite), seeded from
  `lib/data/fno_sectors.json` (`sectorSource: 'tf-map'`). Read 2026-07-06.
- **NSE index inventory:** `/api/nse/heatmap` live feed, 03-Jul-2026 close.
- **NIFTY India Defence** constituents/weights: niftyindices.com factsheet
  (May-2026), cross-checked with screener.in.
