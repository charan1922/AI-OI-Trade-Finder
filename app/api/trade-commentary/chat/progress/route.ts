import { NextResponse } from 'next/server';
import { getTurn, isTurnId } from '@/lib/operator-chat/progress';

/**
 * GET /api/trade-commentary/chat/progress?turn=<id> — live steps of an in-flight v2 reply (what the AI is
 * doing right now). Display-only, in-process memory. Admin-only (chat prefix in lib/auth/rbac.ts).
 */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('turn');
  if (!isTurnId(id)) return NextResponse.json({ error: 'bad turn id' }, { status: 400 });
  const turn = getTurn(id);
  return NextResponse.json({ success: true, turn });
}
