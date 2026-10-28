import { NextResponse } from 'next/server';
import { adminOnly } from '@/lib/auth/server';
import { todayIST } from '@/lib/ist';
import { executeAction } from '@/lib/operator-chat/act';
import { isActionExpired } from '@/lib/operator-chat/format';
import { addOperatorMessage, claimAction, finishAction, getOperatorMessage } from '@/lib/operator-chat/store';

// No `dynamic` / `runtime` exports: Next 16.4 route handlers are uncached by default and Node.js is
// the default runtime (node_modules/next/dist/docs …/route-handlers.md, …/route-segment-config/runtime.md).
export const maxDuration = 120; // take_trade / run_pass run a full scan + decision pass

/**
 * POST /api/trade-commentary/chat/action   Body: { messageId, decision: 'confirm' | 'cancel' }
 *
 * The operator's tap on a Confirm card. Admin-only twice over: the route sits
 * under the ADMIN_ONLY /api/trade-commentary/chat prefix (lib/auth/rbac.ts) and
 * checks adminOnly() itself. Only TODAY's, still-fresh (ACTION_TTL_MS),
 * still-pending proposals run, and pending → running is an atomic claim, so a
 * double tap or a second tab can never run one action twice.
 */
export async function POST(req: Request) {
  const denied = adminOnly(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as { messageId?: number; decision?: string };
    const id = Number(body.messageId);
    const decision = body.decision === 'confirm' ? 'confirm' : body.decision === 'cancel' ? 'cancel' : null;
    if (!Number.isInteger(id) || !decision) {
      return NextResponse.json({ error: 'body must be { messageId, decision: "confirm" | "cancel" }' }, { status: 400 });
    }
    const msg = await getOperatorMessage(id);
    if (!msg?.action) return NextResponse.json({ error: 'No action on that message.' }, { status: 404 });
    const date = todayIST();
    if (msg.date !== date) return NextResponse.json({ error: 'That proposal is from another day.' }, { status: 409 });
    if (msg.action.status !== 'pending') {
      return NextResponse.json({ error: `Already ${msg.action.status}.` }, { status: 409 });
    }

    if (decision === 'cancel') {
      if (!(await claimAction(id, 'cancelled'))) return NextResponse.json({ error: 'Already decided.' }, { status: 409 });
      return NextResponse.json({ success: true, status: 'cancelled' });
    }

    if (isActionExpired(msg.at)) {
      if (await claimAction(id, 'running')) {
        await finishAction(id, 'failed', 'Expired — this card is over 10 minutes old. Ask again for a fresh one.');
      }
      return NextResponse.json({ error: 'Expired — ask again for a fresh card.' }, { status: 409 });
    }
    if (!(await claimAction(id, 'running'))) return NextResponse.json({ error: 'Already decided.' }, { status: 409 });

    const outcome = await executeAction(msg.action);
    await finishAction(id, outcome.ok ? 'done' : 'failed', outcome.message);
    await addOperatorMessage(date, 'assistant', `${outcome.ok ? '✅ Done' : '⚠️ Not done'}: ${outcome.message}`);
    return NextResponse.json({ success: outcome.ok, status: outcome.ok ? 'done' : 'failed', message: outcome.message });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[operator-chat] action error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
