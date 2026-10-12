# 8th TF Climbers check — be in /live's OI Build-up or Most Active list (design)

Date: 2026-10-12 · Operator request ("add 8 number - that check if the stock is in F&O OI Build-up /
Most Active in the visible list"), clarified: "F, M or FM - should inside it" = in the OI Build-up
list (F), the Most Active list (M), or both.

## Rule

Refuse an entry unless the stock is in /live's **visible** F&O OI Build-up list OR its Most Active
list (value or volume). Whole visible list by default (about 10 names each); `maxNseListRank`
turns it into a strict top-N.

"Visible" = NSE's ranked feed through the same filter the page applies (F&O only, no index, no
`avoid` band, live future). One shared definition: `lib/nse/live-lists.ts`
(`filterToLiveUniverse`, used by `/api/live/nse-watchlist` and the selector).

## Fail closed, per feed

- A feed older than 10 minutes, or one that cannot be read, is unavailable (null).
- In a readable list -> pass. In none while every list was read -> `notInNseLists`.
- In none while a list is unavailable -> `listsUnknown` (rejected as unknown, not as "in neither").
- All lists unavailable -> every name is unknown and rejected.

## Evidence and limits

Live (2026-10-12 10:39 IST): 1 of 10 TF names in either list; the only all-green name (ANGELONE)
in neither - expect far fewer entries. History (OI half only, rebuilt from stored NSE OI %): blocks
EICHERMOT and TCS (losers), passes COLPAL (#1) and the 8-Oct trend trades, blocks RELIANCE 6-Oct
(a winner that probably passes via Most Active live). n = 8: operator rule, not a proven edge.
The replay can only rebuild the OI half; Most Active has no history.

## Wiring

selector check 7 (dot 8); `GateStrip.inNseList`; `TfSymbolContext.nseLists` REQUIRED; engine,
recorded context builder (card) and replay all supply it; the card shows which list(s) the stock
is in. Tests: `scripts/verify-tf-selector.ts` (F / M / FM, top-10 cut-off, per-feed failure,
filter, real past-trade ranks, 8 dots <=> picked over every combination).
