import { NextResponse } from "next/server"
import { readFileSync } from "fs"
import { join } from "path"
import fnoSectors from "@/lib/data/fno_sectors.json"

export const dynamic = "force-dynamic"

const INDEX_SYMBOLS = new Set(["BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTY", "NIFTYNXT50"])

export type FnoRow = {
  name: string
  symbol: string
  lotJun: string
  lotJul: string
  lotAug: string
  sector: string
}

function parseCSV(content: string): FnoRow[] {
  const lines = content.trim().split("\n").slice(1) // skip header
  const rows: FnoRow[] = []

  for (const line of lines) {
    const fields = line.match(/"([^"]*)"/g)?.map((f) => f.replace(/"/g, "")) ?? []
    if (fields.length < 6) continue

    const symbol = fields[2]
    const sector = INDEX_SYMBOLS.has(symbol)
      ? "INDEX"
      : (fnoSectors as Record<string, string>)[symbol] ?? "OTHER"

    rows.push({
      name: fields[0],
      symbol,
      lotJun: fields[3],
      lotJul: fields[4],
      lotAug: fields[5],
      sector,
    })
  }

  return rows
}

export async function GET() {
  try {
    const csvPath = join(process.cwd(), "Dhan - Nse Fno Lot Size.csv")
    const content = readFileSync(csvPath, "utf-8")
    const data = parseCSV(content)
    return NextResponse.json({ success: true, data })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
