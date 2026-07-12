import { NextResponse } from 'next/server';
import { listBrowsableTables } from '@/lib/db-explorer/tables';

export const dynamic = 'force-dynamic';

/** Index of browsable (non-sensitive) tables with row/column counts. */
export async function GET() {
  try {
    const tables = await listBrowsableTables();
    return NextResponse.json({ success: true, data: tables });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
