import { NextResponse } from 'next/server';
import { getCommentary } from '@/lib/ai-commentary/store';
import { todayIST } from '@/lib/ist';
import { chatProvider, replyToOperator } from '@/lib/operator-chat/reply';
import { addOperatorAction, addOperatorMessage, listOperatorMessages } from '@/lib/operator-chat/store';

// No `dynamic` export: route handlers are uncached by default in Next 16.4 (bundled docs, route-handlers.md).
export const maxDuration = 60; // tool-calling round-trips can take a few seconds

const MAX_CHARS = 2000;
/** How much of the day's latest reads the chat model is shown — enough to discuss, not to flood. */
const READ_CHARS = 2500;

/**
 * Framing for the chat model. It can ACT for the operator through
 * propose_action (Confirm cards, lib/operator-chat/act.ts) but never directly:
 * nothing happens until the operator taps Confirm, and every action runs
 * through the same gated code as the /auto-trade console.
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
    '  gates and the TradeFinder selector allow.',
    '- YOU CAN ACT. When the operator asks you to DO something — take a trade, change a setting, exit,',
    '  tighten a stop, approve/reject, run the trader now — use propose_action. Never tell them to go to',
    '  another page or "change it on your side". Nothing happens until they tap Confirm, so say "tap',
    '  Confirm" — never say it is done. "Take X" → propose take_trade X. If you can see a gate that would',
    '  block it (e.g. the per-lot risk above maxRiskPerLotRupees in the suggestion), propose the setting',
    '  fix too, in the same reply, and say in one line what that change means for every future trade.',
    '- Never claim the gates are open or that a trade WILL be taken — only the trader\'s check_order',
    '  decides. Never invent a setting value; read it (read_app_data auto_trade_today) if you need it.',
    '- What the chat cannot do: enter a stock the scanner did not pick, or switch mode to live.',
    "- To see WHY a name was rejected (which of the selector's ten checks failed — e.g. 'move started' for",
    "  quiet/fading, 'Supertrend with it' for the Supertrend veto), read_app_data source scan_verdicts. Quote",
    '  it; never infer per-name reasons from totals.',
    "- SKILL: to judge whether the WHOLE market is sideways right now (NIFTY stuck in a narrow opening",
    "  range, breadth split, most stocks still inside their ranges), call read_app_data source",
    '  check_market_sideways — whenever you want. Nothing blocks on it automatically: the trader has the',
    '  same skill and decides for itself; you report and advise.',
    '- If the operator states a market fact you cannot verify with a tool, call it their claim.',
    '- In this thread do NOT end with the "no order is placed" line — orders here are placed by the',
    '  trader, and that sign-off contradicts it.',
    '- LENGTH (overrides "about 120–200 words" above, in this thread only): one topic → 120–200 words;',
    '  an answer that covers 2+ picks or compares 2+ trades → up to ~300 words, hard max 350, so each',
    '  pick keeps its real numbers instead of vague compression. Never pad to fill the room.',
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
      // Each proposal becomes its own Confirm card right under the reply.
      const actions = [];
      for (const p of result.proposals) actions.push(await addOperatorAction(date, p.description, p.action));
      return NextResponse.json({
        success: true,
        saved,
        reply,
        actions,
        provider: result.provider,
        model: result.model,
      });
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
