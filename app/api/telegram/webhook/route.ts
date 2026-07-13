/**
 * Telegram webhook receiver — Telegram POSTs updates here.
 *
 * This endpoint is UNAUTHENTICATED (allowlisted in proxy.ts) because
 * Telegram's servers are the caller. Security is handled via the
 * X-Telegram-Bot-Api-Secret-Token header which we verify against
 * TELEGRAM_WEBHOOK_SECRET.
 *
 * Flow:
 *   1. Verify the secret token header.
 *   2. Parse the update (message or callback_query).
 *   3. Dispatch to command handlers.
 *   4. Reply to the user via the Telegram Bot API.
 */
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifyWebhookSecret, sendMessageTo } from '@/lib/telegram/bot';
import { handleTelegramMessage } from '@/lib/telegram/handlers';
import type { TelegramUpdate } from '@/lib/telegram/bot';

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Verify secret token
  const secret = req.headers.get('x-telegram-bot-api-secret-token');
  if (!verifyWebhookSecret(secret)) {
    console.warn('[TelegramWebhook] Invalid secret token — rejecting');
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 2. Parse update
  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // 3. Extract text + chat id from message or callback query
  const message = update.message ?? update.callback_query?.message;
  const text = update.message?.text ?? update.callback_query?.data;
  const chatId = message?.chat.id;

  if (!text || !chatId) {
    // Telegram expects 200 even for updates we don't handle
    return NextResponse.json({ ok: true });
  }

  // 4. Dispatch command
  const response = await handleTelegramMessage(text, chatId);

  // 5. Reply to the user
  if (response) {
    sendMessageTo(chatId, response, { parse_mode: 'Markdown' });
  }

  // Telegram requires 200 OK
  return NextResponse.json({ ok: true });
}

/** Allow GET for manual browser testing (returns a simple status). */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    ok: true,
    endpoint: 'telegram-webhook',
    method: 'POST',
    note: 'This endpoint receives Telegram bot updates via webhook.',
  });
}