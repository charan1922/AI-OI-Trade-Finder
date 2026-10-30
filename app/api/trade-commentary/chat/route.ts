import { NextResponse } from 'next/server';
import { getCommentary } from '@/lib/ai-commentary/store';
import { todayIST } from '@/lib/ist';
import { hasMimo } from '@/lib/env';
import { actionModeBlock, applyProposals } from '@/lib/operator-chat/auto-act';
import { backgroundStatusBlock, getAutoActions, getChatModel, isBackgroundActive } from '@/lib/operator-chat/background-store';
import { parseImages, saveImages } from '@/lib/operator-chat/images';
import { isTurnId, noteStep } from '@/lib/operator-chat/progress';
import { backgroundFraming } from '@/lib/operator-chat/background-tools';
import { chatProvider, replyToOperator } from '@/lib/operator-chat/reply';
import {
  addOperatorAction,
  addOperatorMessage,
  listOperatorMessages,
  setMessageImages,
  setMessageMeta,
} from '@/lib/operator-chat/store';

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
/** The trader's latest reads — per-message context (v2 places it LAST so the rules above stay cacheable). */
async function readsBlock(date: string, size: { reads: number; chars: number }): Promise<string> {
  const reads = await getCommentary({ date, limit: size.reads }).catch(() => []);
  const latest = reads.length
    ? reads.map((r) => `--- read at ${r.asOf} IST (${r.model}) ---\n${r.text.slice(0, size.chars)}`).join('\n\n')
    : '(no commentary read has been stored yet today)';
  return ["Latest commentary reads from the trader today (context only — quote it, don't invent beyond it):", latest].join('\n');
}

/** v1: rules + reads in one block, exactly as before. v2 (`rulesOnly`): the rules alone — identical every call. */
async function chatFraming(
  date: string,
  size: { reads: number; chars: number } = { reads: 2, chars: READ_CHARS },
  rulesOnly = false
): Promise<string> {
  const rules = [
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
    '- What the chat cannot do: enter a stock the scanner did not pick, or switch mode to live. Only the',
    '  propose_action kinds exist — anything else (turning the market-sideways check into an automatic',
    '  gate, changing a selector check or threshold) is a CODE change: say so plainly and never offer a',
    '  Confirm card or ask "want me to…" for it.',
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
  ].join('\n');
  return rulesOnly ? rules : `${rules}\n\n${await readsBlock(date, size)}`;
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
    const body = (await req.json().catch(() => ({}))) as {
      message?: string;
      surface?: string;
      images?: unknown;
      turnId?: unknown;
      think?: unknown;
    };
    const message = (body.message ?? '').trim();
    // Commentary v2 sends surface 'v2' (agentic: skills + plan) and may attach screenshots. v1 sends neither.
    const v2 = body.surface === 'v2';
    const parsedImages = parseImages(v2 ? body.images : null);
    if (!parsedImages.ok) return NextResponse.json({ error: parsedImages.error }, { status: 400 });
    const images = parsedImages.images;
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
    if (images.length > 0) {
      const names = await saveImages(saved.id, images);
      await setMessageImages(saved.id, names);
      saved.images = names;
    }

    // v2 always answers with MiMo on its own chat model (default Flash); v1 keeps the trader's provider.
    const chat = v2
      ? { provider: 'mimo' as const, mimoModel: await getChatModel(), configured: hasMimo() }
      : await chatProvider();
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
      // Commentary v2: with Background ON the chat also gets its watch/notebook tools + notebook context.
      // OFF (the default) leaves the tools and framing exactly as v1 always had them.
      // v2's watch tools exist only on v2 messages, and only while v2 is the selected page with Background
      // ON — one version at a time. v1 messages never get them.
      const background = v2 && (await isBackgroundActive());
      // v2 sends ONE shortened trader read (it can fetch more with read_app_data source commentary). MiMo caches
      // an identical prompt PREFIX automatically (measured 2026-10-29), so v2 keeps the rules identical and puts
      // everything that changes per message — reads, watches, notebook, clock — at the END.
      const framing = v2 ? await chatFraming(date, undefined, true) : await chatFraming(date);
      // v2: the per-message part goes LAST (cache-friendly); v1 keeps one block with the watch state appended.
      const autoActions = v2 ? await getAutoActions() : undefined;
      const context = v2
        ? [
            await backgroundStatusBlock(),
            actionModeBlock(autoActions!),
            ...(background ? [await backgroundFraming(date)] : []),
            await readsBlock(date, { reads: 1, chars: 1200 }),
          ].join('\n\n')
        : background
          ? await backgroundFraming(date)
          : undefined;
      const result = await replyToOperator({
        message,
        prior,
        framing,
        ...(context ? { context } : {}),
        ...(autoActions ? { autoActions } : {}),
        ...(background ? { background: { date } } : {}),
        ...(v2
          ? {
              agentic: true,
              images,
              model: { provider: chat.provider, mimoModel: chat.mimoModel },
              ...(isTurnId(body.turnId) ? { turnId: body.turnId } : {}),
              thinking: body.think !== false,
            }
          : {}),
      });
      const reply = await addOperatorMessage(date, 'assistant', result.text, result.tools, `${result.provider}/${result.model}`);
      await setMessageMeta(reply.id, result.meta).catch(() => undefined);
      // v1: each proposal becomes its own Confirm card. v2: per the operator's per-action switches, an AUTO kind
      // runs right now through the same gated code as a Confirm tap; an ASK kind stays a Confirm card.
      const turnId = v2 && isTurnId(body.turnId) ? body.turnId : null;
      const actions = [];
      if (autoActions) {
        actions.push(
          ...(await applyProposals(date, result.proposals, autoActions, turnId ? (label, state) => noteStep(turnId, label, state) : undefined))
        );
      } else {
        for (const p of result.proposals) actions.push(await addOperatorAction(date, p.description, p.action));
      }
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
      if (msg === 'Stopped by the operator.') {
        return NextResponse.json({ success: true, saved, reply: null, notice: 'Stopped. Your message is saved; nothing was posted.' });
      }
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
