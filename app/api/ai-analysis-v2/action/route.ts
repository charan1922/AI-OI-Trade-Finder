import { NextResponse } from 'next/server';
import { todayIST } from '@/lib/ist';
import { executeAction } from '@/lib/ai-analysis-v2/actions';
import { claimAction, finishAction, getMessage } from '@/lib/ai-analysis-v2/store';
import { isActionExpired } from '@/lib/ai-analysis-v2/types';

export const maxDuration = 120; // run_pass runs a full scan + decision pass

/**
 * POST /api/ai-analysis-v2/action { messageId, decision: 'confirm' | 'cancel' } — the operator's tap on a v2 Confirm
 * card (an ASK-kind action). Only today's, fresh (10 min), still-pending cards run, and pending → running is an
 * atomic claim, so a double tap or a second tab can never run one action twice. Admin-only (rbac prefix).
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { messageId?: number; decision?: string };
    const id = Number(body.messageId);
    const decision = body.decision === 'confirm' ? 'confirm' : body.decision === 'cancel' ? 'cancel' : null;
    if (!Number.isInteger(id) || !decision) {
      return NextResponse.json({ error: 'body must be { messageId, decision: "confirm" | "cancel" }' }, { status: 400 });
    }
    const msg = await getMessage(id);
    if (!msg?.action) return NextResponse.json({ error: 'No action on that message.' }, { status: 404 });
    if (msg.date !== todayIST()) return NextResponse.json({ error: 'That card is from another day.' }, { status: 409 });
    if (msg.action.status !== 'pending') return NextResponse.json({ error: `Already ${msg.action.status}.` }, { status: 409 });
    if (decision === 'cancel') {
      if (!(await claimAction(id, 'cancelled'))) return NextResponse.json({ error: 'Already decided.' }, { status: 409 });
      return NextResponse.json({ success: true, status: 'cancelled' });
    }
    if (isActionExpired(msg.at)) {
      if (await claimAction(id, 'running')) await finishAction(id, 'failed', 'Expired — this card is over 10 minutes old. Ask again.');
      return NextResponse.json({ error: 'Expired — ask again for a fresh card.' }, { status: 409 });
    }
    if (!(await claimAction(id, 'running'))) return NextResponse.json({ error: 'Already decided.' }, { status: 409 });
    const outcome = await executeAction(msg.action, 'confirmed');
    await finishAction(id, outcome.ok ? 'done' : 'failed', outcome.message);
    return NextResponse.json({ success: outcome.ok, status: outcome.ok ? 'done' : 'failed', message: outcome.message });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
