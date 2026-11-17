import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The NIFTY option-chain context was REMOVED on 2026-11-17: Fyers' Standard
 * plan allows 5,000 data calls a day, and this display-only read (already
 * hidden on /live) cost two option-chain calls every poller cycle. The route
 * stays so the AI chats that list it as a readable path (v1 operator-chat,
 * v2 data reader) get a plain answer instead of a 404.
 */
export async function GET() {
  return NextResponse.json({
    success: true,
    data: null,
    note: 'NIFTY option-chain context removed on 2026-11-17 (Fyers Standard-plan data budget). No option-chain data is collected.',
  });
}
