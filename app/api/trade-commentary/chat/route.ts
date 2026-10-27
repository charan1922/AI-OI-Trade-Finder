import { NextResponse } from 'next/server';
import { getCommentary } from '@/lib/ai-commentary/store';
import { todayIST } from '@/lib/ist';
import { chatProvider, replyToOperator } from '@/lib/operator-chat/reply';
import { addOperatorMessage, listOperatorMessages } from '@/lib/operator-chat/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // tool-calling round-trips can take a few seconds

const MAX_CHARS = 2000;
/** How much of the day's latest reads the chat model is shown — enough to discuss, not to flood. */
const READ_CHARS = 2500;

/**
 * Framing for the chat model. It is the operator's desk analyst, NOT the
 * trader: it cannot place orders, and it must not promise that a message will
 * cause a trade. What the operator types is passed to the auto-trader, which
 * follows it as far as its code gates allow (lib/operator-chat/format.ts).
 */
async function chatFraming(date: string): Promise<string> {
  const reads = await getCommentary({ date, limit: 2 }).catch(() => []);
  const latest = reads.length
    ? reads.map((r) => `--- read at ${r.asOf} IST (${r.model}) ---\n${r.text.slice(0, READ_CHARS)}`).join('\n\n')
    : '(no commentary read has been stored yet today)';
  return [
    '## Operator chat (this conversation)',
    'You are talking with the operator in the SAME thread as the live /trade-commentary reads — your',
    "replies and the trader's commentary appear together, in order. They can talk to you about",
    "anything — the market, today's picks, a stock, a plan, a doubt. Be conversational and direct.",
    "- The auto-trader reads the operator's messages on its next pass (about every 5 minutes) — or at",
    '  its next tool step if it is mid-pass — and makes its call according to them, as far as its code',
    '  gates and the TradeFinder selector allow. You cannot place, change or cancel an order yourself, and',
    '  you must never say or imply that you did.',
    '- When the operator gives an instruction for the trader ("avoid banks", "take the best CE pick"),',
    '  confirm it has been passed on and will be read next pass — and say plainly if it asks for something',
    '  the gates would not allow (a stock the scanner did not pick, a bigger size, a bypassed limit).',
    '- If the operator states a market fact you cannot verify with a tool, call it their claim.',
    '',
    "Latest commentary reads from the trader today (context only — quote it, don't invent beyond it):",
    latest,
  ].join('\n');
}

/** GET /api/trade-commentary/chat?date=YYYY-MM-DD — the day's thread, oldest first. */
export async function GET(req: Request) {
  try {
    const date = new URL(req.url).searchParams.get('date') || todayIST();
    const [messages, chat] = await Promise.all([listOperatorMessages(date), chatProvider()]);
    return NextResponse.json({
      success: true,
      date,
      configured: chat.configured,
      provider: chat.provider,
      messages,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * POST /api/trade-commentary/chat   Body: { message: string }
 *
 * Independent of commentary generation on purpose: it takes no generation lock,
 * so the operator can talk while a pass is running. The operator's message is
 * SAVED FIRST — the trader can read it even if the model call below is slow,
 * fails, or the assistant isn't configured.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { message?: string };
    const message = (body.message ?? '').trim();
    if (!message) return NextResponse.json({ error: 'Empty message.' }, { status: 400 });
    if (message.length > MAX_CHARS) {
      return NextResponse.json(
        { error: `Over the ${MAX_CHARS}-character limit — please shorten it.` },
        { status: 400 }
      );
    }

    const date = todayIST();
    // History is what was said BEFORE this message; read it first so the new one isn't doubled.
    const prior = await listOperatorMessages(date, 16);
    const saved = await addOperatorMessage(date, 'user', message);

    const chat = await chatProvider();
    if (!chat.configured) {
      return NextResponse.json({
        success: true,
        saved,
        reply: null,
        notice:
          `Saved — the trader will read it next pass. The decision AI (${chat.provider}) isn't configured ` +
          'on this instance, so there is no chat reply.',
      });
    }

    try {
      const result = await replyToOperator({ message, prior, framing: await chatFraming(date) });
      const reply = await addOperatorMessage(date, 'assistant', result.text);
      return NextResponse.json({ success: true, saved, reply, provider: result.provider, model: result.model });
    } catch (error) {
      // The operator's message is already stored and WILL reach the trader — say so.
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[operator-chat] model error:', msg);
      return NextResponse.json({
        success: true,
        saved,
        reply: null,
        notice: `Saved — the trader will read it next pass. The chat assistant hit an error and could not reply: ${msg}`,
      });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[operator-chat] error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
