import { NextResponse } from 'next/server';
import { adminOnly } from '@/lib/auth/server';
import { cancelTurn, getTurn, isTurnId } from '@/lib/operator-chat/progress';

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

/** POST /api/trade-commentary/chat/progress { turn } — the Stop button: abort the running reply now. */
export async function POST(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { turn?: unknown };
  if (!isTurnId(body.turn)) return NextResponse.json({ error: 'bad turn id' }, { status: 400 });
  return NextResponse.json({ success: true, stopped: cancelTurn(body.turn) });
}
