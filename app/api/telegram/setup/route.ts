/**
 * Telegram webhook setup — registers (or removes) the webhook with Telegram.
 *
 * POST /api/telegram/setup   — register webhook (body: { action: 'register' | 'delete' })
 * GET  /api/telegram/setup   — show current webhook info (diagnostics)
 *
 * This endpoint IS authenticated (it's an operator action, not a Telegram callback).
 * Requires admin role.
 */
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { setWebhook, deleteWebhook, getWebhookInfo, isTelegramConfigured } from '@/lib/telegram/bot';
import { env } from '@/lib/env';

export async function GET(): Promise<NextResponse> {
  if (!isTelegramConfigured()) {
    return NextResponse.json({
      configured: false,
      message: 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set.',
    });
  }

  const info = await getWebhookInfo();
  return NextResponse.json({
    configured: true,
    webhookInfo: info,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isTelegramConfigured()) {
    return NextResponse.json({
      success: false,
      error: 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set.',
    }, { status: 400 });
  }

  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({
      success: false,
      error: 'TELEGRAM_WEBHOOK_SECRET must be set for secure webhook registration.',
    }, { status: 400 });
  }

  let body: { action?: string; url?: string };
  try {
    body = (await req.json()) as { action?: string; url?: string };
  } catch {
    body = {};
  }

  const action = body.action ?? 'register';

  if (action === 'delete') {
    const ok = await deleteWebhook();
    return NextResponse.json({ success: ok, action: 'deleted' });
  }

  // Build the webhook URL: either provided explicitly, or derived from the request
  let webhookUrl = body.url;
  if (!webhookUrl) {
    // Derive from the incoming request's origin
    const origin = req.nextUrl.origin;
    webhookUrl = `${origin}/api/telegram/webhook`;
  }

  const ok = await setWebhook(webhookUrl, secret);
  if (!ok) {
    return NextResponse.json({
      success: false,
      error: 'Telegram setWebhook failed. Check bot token and logs.',
    }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    action: 'registered',
    webhookUrl,
    note: 'Telegram will now POST updates to this URL.',
  });
}