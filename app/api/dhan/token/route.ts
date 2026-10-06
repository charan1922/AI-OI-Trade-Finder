import { NextResponse } from 'next/server';
import { adminOnly } from '@/lib/auth/server';
import { DHAN_RETIRED_MESSAGE } from '@/lib/market-data/provider';

export const dynamic = 'force-dynamic';

function retired(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  return NextResponse.json({ success: false, configured: false, retired: true, error: DHAN_RETIRED_MESSAGE }, { status: 410 });
}
export const GET = retired;
export const POST = retired;
