import { NextResponse } from 'next/server';
import { hasAzureConfig, runAssistant } from '@/lib/ai-assistant';
import type { ChatMessage } from '@/lib/ai-assistant';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // tool-calling round-trips can take a few seconds

/**
 * POST /api/ai-assistant/chat
 * Body: { message: string, history?: { role, content }[] }
 * Returns: { reply, toolTrace } or { error } with a friendly reply.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { message?: string; history?: ChatMessage[] };
    const message = (body.message ?? '').trim();
    if (!message) {
      return NextResponse.json({ error: 'Empty message.', reply: 'Please type a question.' }, { status: 400 });
    }
    if (message.length > 2000) {
      return NextResponse.json(
        { error: 'Too long.', reply: 'That message is over the 2000-character limit — please shorten it.' },
        { status: 400 },
      );
    }
    if (!hasAzureConfig()) {
      return NextResponse.json({
        reply:
          "The Trade Assistant isn't configured yet. Add AZURE_OPENAI_API_KEY, AZURE_OPENAI_INSTANCE_NAME, and " +
          'AZURE_OPENAI_CHAT_DEPLOYMENT to .env.local, then restart the dev server.',
        toolTrace: [],
        error: 'not-configured',
      });
    }

    const history = Array.isArray(body.history) ? body.history : [];
    const result = await runAssistant(message, history);
    return NextResponse.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[ai-assistant] error:', msg);
    return NextResponse.json(
      { error: msg, reply: `Sorry — I hit an error talking to the model: ${msg}`, toolTrace: [] },
      { status: 500 },
    );
  }
}
