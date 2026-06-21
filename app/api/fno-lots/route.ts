import { NextResponse } from "next/server"
import { prisma } from "@/lib/db"
import { classifyTradeBand } from "@/lib/trade-band"

export const dynamic = "force-dynamic"

export type FnoRow = {
  name: string
  symbol: string
  lotJun: string
  lotJul: string
  lotAug: string
  sector: string
  tradeBand: string
}

export async function GET() {
  try {
    // Only select long-standing fields so this works regardless of Prisma-client
    // regeneration. The band is derived from lotSize via the shared lib (single
    // source of truth); fno_stocks.tradeBand persists the same value for SQL use.
    const rows = await prisma.fnoStock.findMany({
      orderBy: { symbol: "asc" },
      select: {
        symbol: true,
        name: true,
        lotSize: true,
        lotSizeNext: true,
        lotSizeFar: true,
        sector: true,
      },
    })

    const data: FnoRow[] = rows.map((r) => ({
      name: r.name,
      symbol: r.symbol,
      lotJun: String(r.lotSize),
      lotJul: r.lotSizeNext ? String(r.lotSizeNext) : "-",
      lotAug: r.lotSizeFar ? String(r.lotSizeFar) : "-",
      sector: r.sector,
      tradeBand: classifyTradeBand(r.lotSize) ?? "",
    }))

    return NextResponse.json({ success: true, data })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
