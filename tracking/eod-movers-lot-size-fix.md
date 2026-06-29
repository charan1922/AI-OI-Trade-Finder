# EOD Movers — counting OI in contracts (the MCX lot-size fix)

Done 2026-06-30. Makes the EOD page (`/nse/movers-history`) **F&O OI Build-up** match the live NSE feed (`/nse/movers`) even for stocks mid lot-size revision — and, while there, makes price/% match the live feed too. Supersedes the "why live and EOD differ" gotchas in `nse-module.md` §3.

## 1. The symptom

For 25-Jun-2026, the live page showed **MCX** in the F&O OI Build-up (NSE `avgInOI` = **+11.68%**, rank ~#6). Our EOD page did **not** show it — our number was **−1.57%** (OI *unwinding*), so MCX fell to ~rank #32 and off the top-24 list. Same stock, opposite sign.

## 2. Root cause — shares vs contracts, under a lot revision

OI can be measured two ways:
- in **shares/units** (what NSE bhavcopy stores in `OpnIntrst`),
- in **contracts/lots** (what NSE's live "OI spurts" feed counts).

They give the **same %** — *unless the stock's lot size changes between expiries*. NSE was cutting MCX's lot **625 → 225** for the new months. So OI was rolling from the June contract (lot 625) into July (lot 225):
- In **shares**: moving 1 position June→July = −625 + 225 = **−400 shares** → looks like shrinking.
- In **contracts**: 1 June contract → 1 July contract = **no loss**, plus genuine fresh adds → growing.

Our EOD page summed bhavcopy OI in **shares**; NSE's feed counts **contracts**. Hence the sign flip.

**Proved it wasn't a one-off:** across all 211 F&O names on 25-Jun, every disagreement >3pp vs the live feed was a lot-revision stock — **20 of 20**, zero false positives. The ~190 stable-lot names already matched NSE to ~0.0pp. So the metric (fut+opt total) was right; only the **unit** was wrong for revision stocks.

| Approach | top-24 overlap vs NSE | Spearman ρ | MCX |
| --- | --- | --- | --- |
| shares total (old) | 19/24 | 0.918 | −1.57% (rank 32) ❌ |
| futures-only | 12/24 | 0.686 | — (rejected — degrades everything) |
| **contracts (per-expiry lot)** | **21/24** | **~1.0** | **+11.68% (rank 5)** ✅ |

(The 3 names we still can't match are indices — FINNIFTY/MIDCPNIFTY — which aren't in the equity bhavcopy universe.)

## 3. The data gap — and why `fno_stocks` was the wrong lot source

To count contracts you divide **each expiry's OI by that expiry's own lot** (June ÷ 625, July ÷ 225). Two problems:

1. **No per-expiry futures OI.** We stored options OI per expiry (`bhavcopy_option_expiry`) but futures only as one lumped `futOi`. With lumped futures I had to assume the near-month lot (625) for all of it — that under-counted the July futures (which had rolled to the 225 lot) and gave **+3.48%**, still short of NSE's +11.68%.

2. **`fno_stocks` lots are positional and stale.** `fno_stocks` has three fixed columns — `lotSize / lotSizeNext / lotSizeFar` for `lotMonths = "Jun 2026 / Jul 2026 / Aug 2026"`, captured at one seed time. Mapping a date's expiries to those columns by position breaks as months roll forward, and is plain wrong for old dates. Proof: on 15-Dec-2025 it would apply today's 625 to a December contract whose real lot was **125** (MCX was pre-split, ~₹10,000).

## 4. The fix — read the lot per contract from the bhavcopy file

NSE's F&O bhavcopy already carries a per-contract lot column: **`NewBrdLotQty`**. Verified on the 25-Jun file:

```
MCX 30-Jun → 625    MCX 28-Jul → 225    MCX 25-Aug → 225
MCX 15-Dec-25 → 125 (pre-split)
```

So the lot is correct for every date and every expiry, straight from the same file as the OI — no dependence on `fno_stocks`, no staleness, no split/rollover drift.

What changed:
- **`lib/historify/bhavcopy-service.ts`**
  - New table **`bhavcopy_fut_expiry`** (`date, symbol, expiry, futOi, futVolume, lotSize`) — the futures counterpart to `bhavcopy_option_expiry`.
  - Both per-expiry tables gained a **`lotSize`** column (added on existing DBs via `addColumnIfMissing` — no Prisma migration).
  - Parser captures `NewBrdLotQty` per contract for both futures (`STF`) and options (`STO`).
  - Persistence upserts (`ON CONFLICT … DO UPDATE`) so a re-sync refreshes lots; "needs work" detection treats a date as missing until `lotSize > 0`, so old rows backfill automatically.
- **`app/api/nse/movers-history/route.ts`**
  - `oiPct` now = change in **Σ (expiry OI ÷ that expiry's stored lot)**, futures + options. Drops the `fno_stocks` dependency entirely. Adds an `oiBasis` field (`contracts` | `shares`). Falls back to the shares total only if a stored lot is genuinely missing (safety net).
- **`app/nse/movers-history/page.tsx`** — note/tooltip now say OI is counted in contracts using per-contract lots from the bhavcopy file.

Backfilled all **158 sessions** so every date is lot-based (no fallback in practice).

## 5. Related fix done in the same pass — price/% uses last-traded price

Same goal (match the live feed), different field. The bhavcopy CM file has **two** closing numbers:
- `ClsPric` = official VWAP-of-last-30-min close (e.g. LAURUSLABS 25-Jun **1,500.30**),
- `LastPric` = final traded price (**1,487.60**) — what Google, brokers, and the live page show.

We were displaying `ClsPric`, so LAURUSLABS read **+3.47%** vs everyone else's **+2.59%** (it spiked near the close). Fix:
- Added **`eqLastPrice`** to `bhavcopy_days` (captures `LastPric`); `eqClose` (official close) is **left untouched** so the **R-Factor engine keeps the official close it was calibrated against**.
- The movers route now shows last price and computes `% = (lastPrice today − official close prior session) / official close prior session` — exactly how the live feed/Google compute it.
- Backfilled `eqLastPrice` for all 158 sessions.

Note: `/heatmap` and `/live/sector-leaders` still use `eqClose` for their displayed %, so they'd show the same tiny official-close-vs-LTP gap if cross-checked — left as-is (separate features, not flagged).

## 6. Verification (25-Jun & 29-Jun-2026)

- **MCX 25-Jun:** EOD OI Build-up = **+11.68%, rank #5** = NSE's number to the decimal (Δlots = +7,835 = NSE's reported `changeInOI`).
- Full pass vs live: **210 / 211** stocks within 1pp; lot-revision names went from mean 3.41pp error → **0.00pp**; **zero** names off by >3pp.
- **LAURUSLABS 29-Jun:** EOD = **1,487.60 / +2.59%** = Google + live page; EOD Top Gainers list now mirrors the live list.
- ESLint clean; `/nse/movers` and `/nse/movers-history` both return HTTP 200.

## 7. Data honesty

- Lots come **per-contract from the bhavcopy file** (`NewBrdLotQty`) — never a hardcoded/assumed lot, never the stale `fno_stocks` snapshot.
- Contracts math runs only when a real stored lot exists; otherwise it falls back to the honest shares total (and says so via `oiBasis`).
- `ClsPric` (official close) is preserved untouched for R-Factor; the movers UI adds `LastPric` rather than overwriting.

## 8. Operational note

- The schema gained `eqLastPrice` (in `prisma/schema.prisma`); reads/writes use raw SQL so no `db push` was needed, but run `pnpm db:generate` so the Prisma client types match.
- New dates self-heal: every daily bhavcopy sync now stores per-contract lots and last price automatically. Older un-synced dates fall back to shares/official-close until a wider sync runs.
