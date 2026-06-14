import { NextResponse } from 'next/server';
import { runSignalScan, sanitizeScanParams, type ScanParams } from '@/lib/backtest/signal-scanner';

export const dynamic = 'force-dynamic';

/**
 * POST /api/backtest/scan — run the point-in-time universe scan.
 * Body: Partial<ScanParams> (missing/invalid fields fall back to safe defaults).
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Partial<ScanParams>;
    const params = sanitizeScanParams(body);
    const result = await runSignalScan(params);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error('[Signal Scan] Error:', error);
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
