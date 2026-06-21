import { NextResponse } from "next/server"
import { prisma } from "@/lib/db"

export const dynamic = "force-dynamic"

export type FnoRow = {
  name: string
  symbol: string
  lotJun: string
  lotJul: string
  lotAug: string
  sector: string
  tradeBand: string
  isOverride: boolean
  overrideNote: string
}

type RawRow = {
  symbol: string
  name: string
  lotSize: number
  lotSizeNext: number
  lotSizeFar: number
  sector: string
  tradeBand: string
  isOverride: number
  overrideNote: string
}

export async function GET() {
  try {
    // Raw SQL so this works regardless of Prisma-client regeneration, and so we
    // can LEFT JOIN the manual band_overrides. fno_stocks.tradeBand already holds
    // the effective band (lot-based + overrides applied by the seeder).
    const rows = await prisma.$queryRaw<RawRow[]>`
      SELECT f.symbol, f.name, f.lotSize, f.lotSizeNext, f.lotSizeFar, f.sector, f.tradeBand,
             CASE WHEN o.symbol IS NOT NULL THEN 1 ELSE 0 END AS isOverride,
             COALESCE(o.note, '') AS overrideNote
      FROM fno_stocks f
      LEFT JOIN band_overrides o ON o.symbol = f.symbol
      ORDER BY f.symbol ASC
    `

    const data: FnoRow[] = rows.map((r) => ({
      name: r.name,
      symbol: r.symbol,
      lotJun: String(Number(r.lotSize)),
      lotJul: Number(r.lotSizeNext) ? String(Number(r.lotSizeNext)) : "-",
      lotAug: Number(r.lotSizeFar) ? String(Number(r.lotSizeFar)) : "-",
      sector: r.sector,
      tradeBand: r.tradeBand,
      isOverride: Number(r.isOverride) === 1,
      overrideNote: r.overrideNote || "",
    }))

    return NextResponse.json({ success: true, data })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
