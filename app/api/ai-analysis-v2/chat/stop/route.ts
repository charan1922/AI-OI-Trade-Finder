import { NextResponse } from 'next/server';
import { isRunId, stopRun } from '@/lib/ai-analysis-v2/runs';

/** POST /api/ai-analysis-v2/chat/stop { runId } — the Stop button: abort the running answer now. Admin-only (rbac). */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { runId?: unknown };
  if (!isRunId(body.runId)) return NextResponse.json({ error: 'runId required' }, { status: 400 });
  return NextResponse.json({ success: true, stopped: stopRun(body.runId) });
}
