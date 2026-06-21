// Canonical trade-band classification by F&O lot size.
//
// Refined for an option-BUYER's execution friction (TradeFinder analysis, Jan–Jun 2026):
//   Core      250–1,500   → ~56% of historical trades (best fit, low friction)
//   Extended  ≤249 or 1,501–2,500 → fills fine for buyers; covers the rest up to ~90%
//   Avoid     >2,500       → cheap stocks ⇒ low-premium options ⇒ wide spreads, worst fills
//
// Note: low-lot/pricey names (lot <150: BOSCH, MARUTI, indices…) were previously
// "Avoid" but the friction analysis showed they fill FINE for option buyers, so
// they now sit in Extended. Only the high-lot/cheap end is genuinely worth avoiding.
//
// TRADE_BAND_SEGMENTS is THE numeric definition — everything derives from it.
// scripts/seed-fno-stocks.mjs mirrors these to persist fno_stocks.tradeBand and
// the trade_band_ranges reference table. Keep the two in sync.

export type TradeBand = "core" | "extended" | "avoid"

export const TRADE_BAND_ORDER: TradeBand[] = ["core", "extended", "avoid"]

/** Inclusive lot-size segments. "extended" has two pieces (≤249 and 1,501–2,500). */
export const TRADE_BAND_SEGMENTS: { band: TradeBand; min: number; max: number }[] = [
  { band: "extended", min: 0, max: 249 },
  { band: "core", min: 250, max: 1500 },
  { band: "extended", min: 1501, max: 2500 },
  { band: "avoid", min: 2501, max: Number.MAX_SAFE_INTEGER },
]

/** Classify a lot size into a trade band. Returns null for missing/invalid lots. */
export function classifyTradeBand(lot: number | null | undefined): TradeBand | null {
  if (lot == null || !Number.isFinite(lot) || lot <= 0) return null
  const seg = TRADE_BAND_SEGMENTS.find((s) => lot >= s.min && lot <= s.max)
  return seg ? seg.band : null
}

/** Human-readable numeric range for a band, derived from the segments. */
export function bandRangeText(band: TradeBand): string {
  return TRADE_BAND_SEGMENTS.filter((s) => s.band === band)
    .map((s) => {
      if (s.min === 0) return `≤ ${s.max.toLocaleString()}`
      if (s.max >= Number.MAX_SAFE_INTEGER) return `> ${(s.min - 1).toLocaleString()}`
      return `${s.min.toLocaleString()}–${s.max.toLocaleString()}`
    })
    .join("  /  ")
}

export const TRADE_BAND_META: Record<
  TradeBand,
  { label: string; range: string; desc: string; dot: string; badgeCls: string; pillCls: string }
> = {
  core: {
    label: "Core",
    range: bandRangeText("core"),
    desc: "Lot 250–1,500. 56% of TradeFinder's 337 trades fell in this range.",
    dot: "bg-green-500",
    badgeCls: "bg-green-50 text-green-700 border-green-200",
    pillCls: "bg-green-50 text-green-700 border-green-200 data-[active=true]:bg-green-600 data-[active=true]:text-white",
  },
  extended: {
    label: "Extended",
    range: bandRangeText("extended"),
    desc: "Lot ≤249 or 1,501–2,500. A further ~34% of trades; includes pricey low-lot names & indices.",
    dot: "bg-amber-500",
    badgeCls: "bg-amber-50 text-amber-700 border-amber-200",
    pillCls: "bg-amber-50 text-amber-700 border-amber-200 data-[active=true]:bg-amber-600 data-[active=true]:text-white",
  },
  avoid: {
    label: "Avoid",
    range: bandRangeText("avoid"),
    desc: "Lot >2,500. ~7% of trades; in recent trades these had by far the lowest option premiums (≈₹5 median) ⇒ most slippage.",
    dot: "bg-red-500",
    badgeCls: "bg-red-50 text-red-700 border-red-200",
    pillCls: "bg-red-50 text-red-700 border-red-200 data-[active=true]:bg-red-600 data-[active=true]:text-white",
  },
}
