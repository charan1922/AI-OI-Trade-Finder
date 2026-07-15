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

export interface TelegramDeliveryResult {
  chatId: string;
  ok: boolean;
  status: number | null;
  error?: string;
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

/** Every commentary recipient: the operator chat plus TELEGRAM_VIEWER_CHAT_IDS
 *  (comma-separated read-only chats), deduped. Operator commands and approval
 *  prompts must keep using sendMessage (operator chat only) — the viewer list
 *  receives BROADCASTS only. */
function broadcastChatIds(): string[] {
  const ids = new Set<string>();
  const op = chatId();
  if (op) ids.add(op.trim());
  for (const raw of (env.TELEGRAM_VIEWER_CHAT_IDS ?? '').split(',')) {
    const id = raw.trim();
    if (id) ids.add(id);
  }
  return [...ids];
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

async function sendToChat(
  targetChatId: string | number | null,
  text: string,
  options?: SendMessageOptions
): Promise<TelegramDeliveryResult> {
  const target = String(targetChatId ?? '');
  const url = apiUrl('sendMessage');
  if (!url || !target) {
    return { chatId: target, ok: false, status: null, error: 'not configured' };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: target, text, ...options }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
    } | null;
    const ok = res.ok && body?.ok === true;
    return {
      chatId: target,
      ok,
      status: res.status,
      ...(ok ? {} : { error: body?.description ?? `Telegram HTTP ${res.status}` }),
    };
  } catch (err) {
    return {
      chatId: target,
      ok: false,
      status: null,
      error: (err as Error).message,
    };
  }
}

export async function sendMessageAsync(text: string, options?: SendMessageOptions): Promise<TelegramDeliveryResult> {
  const result = await sendToChat(chatId(), text, options);
  if (!result.ok) console.warn(`${TAG} sendMessage failed: ${result.error}`);
  return result;
}

/**
 * Send a text message to the configured operator chat.
 * Fire-and-forget — never throws, never blocks the caller.
 */
export function sendMessage(text: string, options?: SendMessageOptions): void {
  void sendMessageAsync(text, options);
}

/**
 * Send a text message to EVERY commentary recipient — the operator chat plus
 * any TELEGRAM_VIEWER_CHAT_IDS. Resolves with one verified delivery result per
 * recipient. Use for commentary/read-only broadcasts ONLY; actionable
 * operator messages stay on sendMessage.
 */
export async function broadcastMessage(text: string, options?: SendMessageOptions): Promise<TelegramDeliveryResult[]> {
  const results = await Promise.all(broadcastChatIds().map((id) => sendToChat(id, text, options)));
  for (const result of results) {
    if (!result.ok) console.warn(`${TAG} broadcast delivery failed: ${result.error}`);
  }
  return results;
}

/**
 * Send a text message to a specific chat id (for replying to the user who
 * sent a command via the webhook). Fire-and-forget.
 */
export function sendMessageTo(targetChatId: string | number, text: string, options?: SendMessageOptions): void {
  void sendToChat(targetChatId, text, options).then((result) => {
    if (!result.ok) console.warn(`${TAG} sendMessageTo failed: ${result.error}`);
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
    const data = (await res.json()) as {
      ok: boolean;
      result?: Record<string, unknown>;
    };
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
  if (!expected) {
    // Commands can approve orders and change trading mode. A production
    // webhook without its shared secret must fail closed.
    return env.NODE_ENV !== 'production' && !process.env.RAILWAY_ENVIRONMENT_NAME;
  }
  return requestSecret === expected;
}
