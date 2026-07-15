import { NextResponse } from 'next/server';
import { listBrowsableTables } from '@/lib/db-explorer/tables';
import { adminOnly } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

/** Index of browsable (non-sensitive) tables with row/column counts. */
export async function GET(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const tables = await listBrowsableTables();
    return NextResponse.json({ success: true, data: tables });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
