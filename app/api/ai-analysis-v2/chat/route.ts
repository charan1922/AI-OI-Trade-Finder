import { NextResponse } from 'next/server';
import { getOpenTrades } from '@/lib/auto-trade/store';
import { hasMimo } from '@/lib/env';
import { todayIST } from '@/lib/ist';
import { getAutoActions, getChatModel, isBackgroundActive, savedMemories } from '@/lib/ai-analysis-v2/background-store';
import { runAgent, userTurn } from '@/lib/ai-analysis-v2/graph';
import { parseImages, saveImages } from '@/lib/ai-analysis-v2/images';
import { endRun, isRunId, startRun } from '@/lib/ai-analysis-v2/runs';
import { finishAnswer, listMessages, reserveTurn, setMessageImages } from '@/lib/ai-analysis-v2/store';
import { newTurnState } from '@/lib/ai-analysis-v2/tools';
import type { AgentEvent, AnswerDetails } from '@/lib/ai-analysis-v2/types';

// No `dynamic` export: route handlers are uncached by default in Next 16.4 (bundled docs, route-handlers.md).
export const maxDuration = 300; // an agent turn can make several model rounds

const MAX_CHARS = 2000;
const HISTORY_TURNS = 8;
const HISTORY_CHARS = 1200;

/** GET /api/ai-analysis-v2/chat?date=YYYY-MM-DD — v2's own thread for the day, oldest first. Admin-only (rbac). */
export async function GET(req: Request) {
  try {
    const date = new URL(req.url).searchParams.get('date') || todayIST();
    return NextResponse.json({ success: true, date, configured: hasMimo(), messages: await listMessages(date) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

/**
 * POST /api/ai-analysis-v2/chat  { message, images?, runId, think? }  →  text/event-stream
 *
 * The question and an empty answer are saved FIRST (as the reference agent does), then the LangGraph agent runs and
 * its events stream as SSE; the answer row is filled in at the end — partial with a reason if it failed or the
 * operator pressed Stop (POST /chat/stop). Admin-only (the /api/ai-analysis-v2 prefix in lib/auth/rbac.ts).
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { message?: string; images?: unknown; runId?: unknown; think?: unknown };
  const message = (body.message ?? '').trim();
  if (!message) return NextResponse.json({ error: 'Empty message.' }, { status: 400 });
  if (message.length > MAX_CHARS) return NextResponse.json({ error: `Over the ${MAX_CHARS}-character limit.` }, { status: 400 });
  if (!isRunId(body.runId)) return NextResponse.json({ error: 'runId required' }, { status: 400 });
  if (!hasMimo()) return NextResponse.json({ error: 'MiMo is not configured on this server.' }, { status: 503 });
  const parsedImages = parseImages(body.images);
  if (!parsedImages.ok) return NextResponse.json({ error: parsedImages.error }, { status: 400 });
  const images = parsedImages.images;
  const runId = body.runId;

  const date = todayIST();
  const prior = await listMessages(date, 40);
  const { user, answer } = await reserveTurn(date, message);
  if (images.length) await setMessageImages(user.id, await saveImages(user.id, images));

  const history = prior
    .filter((m) => !m.action && m.content.trim())
    .slice(-HISTORY_TURNS)
    .map((m) => `${m.role === 'user' ? 'OPERATOR' : 'YOU'}: ${m.content.slice(0, HISTORY_CHARS)}`);

  const [model, autoActions, memories, background, open] = await Promise.all([
    getChatModel(),
    getAutoActions(),
    savedMemories(),
    isBackgroundActive(),
    getOpenTrades().catch(() => []),
  ]);
  const signal = startRun(runId);
  const turn = newTurnState();
  const started = Date.now();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      // What the page currently shows as the answer — kept so a Stop or a failure saves it as the partial answer.
      let streamed = '';
      const send = (e: AgentEvent) => {
        if (e.event === 'delta') streamed += e.data.text;
        else if (e.event === 'reset') streamed = '';
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
        } catch {
          closed = true; // the browser went away; the run still finishes and is saved
        }
      };
      send({ event: 'run', data: { runId, messageId: answer.id, userMessageId: user.id } });
      const ctx = {
        date,
        mode: 'chat' as const,
        model,
        thinking: body.think !== false,
        background,
        autoActions,
        memories,
        openPositions: open.filter((t) => t.date === date).map((t) => t.symbol),
        turn,
        signal,
        actions: [],
      };
      let failure: string | null = null;
      let text = '';
      let used = model;
      let state: Awaited<ReturnType<typeof runAgent>>['state'] | null = null;
      try {
        const r = await runAgent(ctx, userTurn({ history, message, images }), send);
        text = r.answer;
        used = r.model;
        state = r.state;
      } catch (err) {
        failure = signal.aborted ? 'Stopped by you.' : (err as Error).message.slice(0, 300);
        text = streamed.trim();
      } finally {
        endRun(runId);
      }
      const details: AnswerDetails = {
        steps: state?.steps ?? [],
        reasoning: state?.reasoning ?? [],
        thinkMs: state?.thinkMs ?? null,
        plan: turn.plan,
        skills: turn.skills,
        question: turn.question,
        memories: turn.memories,
        recovered: state?.recovered ?? [],
        reviews: state?.reviews ?? [],
        wake: null,
        ms: Date.now() - started,
        rounds: state?.round ?? 0,
        promptTokens: state?.promptTokens ?? 0,
        completionTokens: state?.completionTokens ?? 0,
        cachedTokens: state?.cachedTokens ?? 0,
        reasoningTokens: state?.reasoningTokens ?? 0,
      };
      const saved = await finishAnswer(answer.id, text || (failure ? '' : '(no answer produced)'), details, `mimo/${used}`, failure);
      if (failure && !signal.aborted) send({ event: 'error', data: { message: failure } });
      send({ event: 'done', data: { message: saved, actions: ctx.actions } });
      if (!closed) controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
