// Canonical trade-band classification by F&O lot size.
//
// Bands come from the TradeFinder trade-coverage analysis:
//   Core      250–1,500            → ~56% of historical trades (best fit, low friction)
//   Extended  150–249 / 1,501–2,500 → widening to here lifts coverage to ~77%
//   Avoid     <150  or  >2,500      → pricey low-lot (BOSCH/MARUTI/indices) or
//                                      cheap high-lot penny-ish names (IDEA/YESBANK/SUZLON)
//
// TRADE_BAND_SEGMENTS below is THE numeric definition — everything else derives
// from it. scripts/seed-fno-stocks.mjs mirrors these segments to (a) persist
// fno_stocks.tradeBand and (b) populate the trade_band_ranges reference table.
// Keep the two in sync.

export type TradeBand = "core" | "extended" | "avoid"

export const TRADE_BAND_ORDER: TradeBand[] = ["core", "extended", "avoid"]

/** Inclusive lot-size segments. "extended" intentionally has two shoulders. */
export const TRADE_BAND_SEGMENTS: { band: TradeBand; min: number; max: number }[] = [
  { band: "avoid", min: 0, max: 149 },
  { band: "extended", min: 150, max: 249 },
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
      if (s.min === 0) return `< ${s.max + 1}`
      if (s.max >= Number.MAX_SAFE_INTEGER) return `> ${s.min - 1}`
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
    desc: "Best fit — about 56% of trades. Liquid, low friction.",
    dot: "bg-green-500",
    badgeCls: "bg-green-50 text-green-700 border-green-200",
    pillCls: "bg-green-50 text-green-700 border-green-200 data-[active=true]:bg-green-600 data-[active=true]:text-white",
  },
  extended: {
    label: "Extended",
    range: bandRangeText("extended"),
    desc: "Acceptable — widening to here covers about 77% of trades.",
    dot: "bg-amber-500",
    badgeCls: "bg-amber-50 text-amber-700 border-amber-200",
    pillCls: "bg-amber-50 text-amber-700 border-amber-200 data-[active=true]:bg-amber-600 data-[active=true]:text-white",
  },
  avoid: {
    label: "Avoid",
    range: bandRangeText("avoid"),
    desc: "Skip — pricey low-lot (BOSCH, MARUTI, indices) or cheap high-lot (IDEA, YESBANK, SUZLON).",
    dot: "bg-red-500",
    badgeCls: "bg-red-50 text-red-700 border-red-200",
    pillCls: "bg-red-50 text-red-700 border-red-200 data-[active=true]:bg-red-600 data-[active=true]:text-white",
  },
}
