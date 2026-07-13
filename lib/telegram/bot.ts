/**
 * Telegram Bot API client — lightweight wrapper for sending messages and
 * managing the webhook. Used by both the outbound alerts subsystem and the
 * inbound webhook handler.
 *
 * Configure via env:
 *   TELEGRAM_BOT_TOKEN   — from @BotFather
 *   TELEGRAM_CHAT_ID     — operator's numeric chat id
 *   TELEGRAM_WEBHOOK_SECRET — arbitrary secret for webhook verification
 */

import { env } from '@/lib/env';

const TAG = '[TelegramBot]';

const BASE_URL = 'https://api.telegram.org';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  from?: {
    id: number;
    is_bot: boolean;
    first_name: string;
    last_name?: string;
    username?: string;
  };
  chat: {
    id: number;
    type: string;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
  date: number;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramMessage['from'];
  message?: TelegramMessage;
  data?: string;
}

export interface SendMessageOptions {
  parse_mode?: 'Markdown' | 'HTML';
  reply_markup?: Record<string, unknown>;
  disable_web_page_preview?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function botToken(): string | null {
  return env.TELEGRAM_BOT_TOKEN ?? null;
}

function chatId(): string | null {
  return env.TELEGRAM_CHAT_ID ?? null;
}

/** Base URL for this bot's Telegram API methods. */
function apiUrl(method: string): string | null {
  const token = botToken();
  if (!token) return null;
  return `${BASE_URL}/bot${token}/${method}`;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/** True when Telegram bot token + chat id are both configured. */
export function isTelegramConfigured(): boolean {
  return !!botToken() && !!chatId();
}

/**
 * Send a text message to the configured operator chat.
 * Fire-and-forget — never throws, never blocks the caller.
 */
export function sendMessage(text: string, options?: SendMessageOptions): void {
  const url = apiUrl('sendMessage');
  if (!url) return;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId(), text, ...options }),
    signal: AbortSignal.timeout(10_000),
  }).catch((err) => {
    console.warn(`${TAG} sendMessage failed: ${(err as Error).message}`);
  });
}

/**
 * Send a text message to a specific chat id (for replying to the user who
 * sent a command via the webhook). Fire-and-forget.
 */
export function sendMessageTo(targetChatId: string | number, text: string, options?: SendMessageOptions): void {
  const url = apiUrl('sendMessage');
  if (!url) return;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: targetChatId, text, ...options }),
    signal: AbortSignal.timeout(10_000),
  }).catch((err) => {
    console.warn(`${TAG} sendMessageTo failed: ${(err as Error).message}`);
  });
}

/**
 * Register a webhook URL with Telegram.
 * Telegram will POST updates to this URL with the secret token in the
 * X-Telegram-Bot-Api-Secret-Token header.
 */
export async function setWebhook(webhookUrl: string, secretToken: string): Promise<boolean> {
  const url = apiUrl('setWebhook');
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: secretToken,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json()) as { ok: boolean; description?: string };
    if (!data.ok) {
      console.error(`${TAG} setWebhook failed: ${data.description}`);
      return false;
    }
    console.log(`${TAG} webhook registered → ${webhookUrl}`);
    return true;
  } catch (err) {
    console.error(`${TAG} setWebhook error: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Remove the current webhook (for teardown or re-registration).
 */
export async function deleteWebhook(): Promise<boolean> {
  const url = apiUrl('deleteWebhook');
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drop_pending_updates: false }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { ok: boolean };
    return data.ok;
  } catch (err) {
    console.error(`${TAG} deleteWebhook error: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Get current webhook info (for diagnostics).
 */
export async function getWebhookInfo(): Promise<Record<string, unknown> | null> {
  const url = apiUrl('getWebhookInfo');
  if (!url) return null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { ok: boolean; result?: Record<string, unknown> };
    return data.ok ? (data.result ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Verify the incoming webhook request's secret token header.
 * Returns true if the header matches TELEGRAM_WEBHOOK_SECRET.
 */
export function verifyWebhookSecret(requestSecret: string | null): boolean {
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return true; // no secret configured — allow all (dev mode)
  return requestSecret === expected;
}