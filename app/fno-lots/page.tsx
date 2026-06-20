"use client"

import { useEffect, useMemo, useState } from "react"
import { Search, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

type FnoRow = {
  name: string
  symbol: string
  lotJun: string
  lotJul: string
  lotAug: string
  sector: string
}

const SECTOR_ORDER = [
  "INDEX", "IT", "AUTO", "PHARMA", "FMCG", "METAL",
  "ENERGY", "REALTY", "PVT BANK", "PSU BANK", "FIN SERVICE",
  "CEMENT", "CAPITAL GOODS", "CONSUMER DURABLES", "CHEMICALS", "TELECOM", "OTHER",
]

const SECTOR_COLOR: Record<string, string> = {
  INDEX:             "bg-slate-100 text-slate-700 border-slate-300 data-[active=true]:bg-slate-700 data-[active=true]:text-white",
  IT:                "bg-blue-50 text-blue-700 border-blue-200 data-[active=true]:bg-blue-600 data-[active=true]:text-white",
  AUTO:              "bg-orange-50 text-orange-700 border-orange-200 data-[active=true]:bg-orange-600 data-[active=true]:text-white",
  PHARMA:            "bg-green-50 text-green-700 border-green-200 data-[active=true]:bg-green-600 data-[active=true]:text-white",
  FMCG:              "bg-yellow-50 text-yellow-700 border-yellow-200 data-[active=true]:bg-yellow-600 data-[active=true]:text-white",
  METAL:             "bg-gray-100 text-gray-700 border-gray-300 data-[active=true]:bg-gray-600 data-[active=true]:text-white",
  ENERGY:            "bg-red-50 text-red-700 border-red-200 data-[active=true]:bg-red-600 data-[active=true]:text-white",
  REALTY:            "bg-purple-50 text-purple-700 border-purple-200 data-[active=true]:bg-purple-600 data-[active=true]:text-white",
  "PVT BANK":        "bg-indigo-50 text-indigo-700 border-indigo-200 data-[active=true]:bg-indigo-600 data-[active=true]:text-white",
  "PSU BANK":        "bg-teal-50 text-teal-700 border-teal-200 data-[active=true]:bg-teal-600 data-[active=true]:text-white",
  "FIN SERVICE":     "bg-cyan-50 text-cyan-700 border-cyan-200 data-[active=true]:bg-cyan-600 data-[active=true]:text-white",
  CEMENT:            "bg-stone-100 text-stone-700 border-stone-300 data-[active=true]:bg-stone-600 data-[active=true]:text-white",
  "CAPITAL GOODS":   "bg-amber-50 text-amber-700 border-amber-200 data-[active=true]:bg-amber-600 data-[active=true]:text-white",
  "CONSUMER DURABLES":"bg-lime-50 text-lime-700 border-lime-200 data-[active=true]:bg-lime-600 data-[active=true]:text-white",
  CHEMICALS:         "bg-violet-50 text-violet-700 border-violet-200 data-[active=true]:bg-violet-600 data-[active=true]:text-white",
  TELECOM:           "bg-sky-50 text-sky-700 border-sky-200 data-[active=true]:bg-sky-600 data-[active=true]:text-white",
  OTHER:             "bg-zinc-100 text-zinc-600 border-zinc-300 data-[active=true]:bg-zinc-600 data-[active=true]:text-white",
}

function SectorBadge({ sector }: { sector: string }) {
  const cls = (SECTOR_COLOR[sector] ?? SECTOR_COLOR.OTHER).split(" data-[active")[0]
  return (
    <span className={cn("inline-block rounded border font-medium text-[10px] px-1.5 py-0", cls)}>
      {sector}
    </span>
  )
}

export default function FnoLotsPage() {
  const [stocks, setStocks] = useState<FnoRow[]>([])
  const [query, setQuery] = useState("")
  const [activeSector, setActiveSector] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/fno-lots")
      .then((r) => r.json())
      .then((json) => {
        if (json.success) setStocks(json.data)
        else setError(json.error ?? "Failed to load")
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  const sectors = useMemo(() => {
    const present = new Set(stocks.map((s) => s.sector))
    return SECTOR_ORDER.filter((s) => present.has(s))
  }, [stocks])

  const sectorCounts = useMemo(() => {
    const map: Record<string, number> = {}
    for (const s of stocks) map[s.sector] = (map[s.sector] ?? 0) + 1
    return map
  }, [stocks])

  const filtered = useMemo(() => {
    let rows = stocks
    if (activeSector) rows = rows.filter((s) => s.sector === activeSector)
    if (query) {
      const q = query.toLowerCase()
      rows = rows.filter((s) => s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
    }
    return rows
  }, [stocks, activeSector, query])

  const anyFilter = activeSector !== null || query !== ""

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b shrink-0">
        <span className="text-sm font-semibold whitespace-nowrap">F&amp;O Lot Sizes</span>
        <span className="text-xs text-muted-foreground whitespace-nowrap">{filtered.length}/{stocks.length}</span>
        <div className="relative w-48 shrink-0 ml-auto">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            placeholder="Search..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8 h-7 text-xs"
          />
        </div>
        {anyFilter && (
          <button
            onClick={() => { setActiveSector(null); setQuery("") }}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground shrink-0"
          >
            <X className="size-3.5" /> Clear
          </button>
        )}
      </div>

      {/* Sector filter pills */}
      {!loading && !error && (
        <div className="flex flex-wrap gap-1 px-4 py-2 border-b shrink-0">
          <button
            onClick={() => setActiveSector(null)}
            className={cn(
              "text-[11px] px-2 py-0.5 rounded border font-medium transition-colors",
              activeSector === null
                ? "bg-foreground text-background border-foreground"
                : "bg-background text-muted-foreground border-border hover:border-foreground/40"
            )}
          >
            All
          </button>
          {sectors.map((s) => {
            const active = activeSector === s
            const cls = SECTOR_COLOR[s] ?? SECTOR_COLOR.OTHER
            return (
              <button
                key={s}
                data-active={active}
                onClick={() => setActiveSector(active ? null : s)}
                className={cn("text-[11px] px-2 py-0.5 rounded border font-medium transition-colors", cls)}
              >
                {s} <span className="opacity-60 font-normal">{sectorCounts[s]}</span>
              </button>
            )
          })}
        </div>
      )}

      {loading && <p className="text-xs text-muted-foreground p-4">Loading…</p>}
      {error && <p className="text-xs text-destructive p-4">{error}</p>}

      {!loading && !error && (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur z-10">
              <tr>
                <th className="text-left px-3 py-1.5 font-medium text-muted-foreground w-8">#</th>
                <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Symbol</th>
                <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Name</th>
                <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Sector</th>
                <th className="text-right px-3 py-1.5 font-medium text-muted-foreground">Lot Size</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                    No results found
                  </td>
                </tr>
              ) : (
                filtered.map((s, i) => (
                  <tr
                    key={s.symbol}
                    className="border-t hover:bg-muted/30 transition-colors cursor-pointer"
                    onClick={() => setActiveSector(activeSector === s.sector ? null : s.sector)}
                  >
                    <td className="px-3 py-1 text-muted-foreground tabular-nums">{i + 1}</td>
                    <td className="px-3 py-1 font-mono font-semibold">{s.symbol}</td>
                    <td className="px-3 py-1 text-muted-foreground">{s.name}</td>
                    <td className="px-3 py-1"><SectorBadge sector={s.sector} /></td>
                    <td className="px-3 py-1 text-right tabular-nums font-medium">
                      {s.lotJun === "-"
                        ? <span className="text-muted-foreground">—</span>
                        : Number(s.lotJun).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
