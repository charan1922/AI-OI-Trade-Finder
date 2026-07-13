/**
 * Lightweight alerting for critical auto-trade events — sends to a Telegram
 * bot (or any webhook) so the operator sees real-time notifications without
 * checking Railway logs. Best-effort: a failure here never blocks the engine.
 *
 * Alert routing (first match wins):
 *   1. If TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set → use the native
 *      Telegram Bot API via lib/telegram/bot.ts (supports Markdown, delivery
 *      receipts, and inbound command replies through the webhook).
 *   2. Else if AUTO_TRADE_ALERT_WEBHOOK is set → POST { text } as JSON to
 *      that URL (legacy webhook mode — works with any POST endpoint).
 *   3. Neither set → alerts are silently dropped.
 */

import { env } from '@/lib/env';
import { sendMessage, isTelegramConfigured } from '@/lib/telegram';

const TAG = '[AutoTradeAlert]';

function webhookUrl(): string | null {
  return env.AUTO_TRADE_ALERT_WEBHOOK ?? null;
}

/** Send an alert. Fire-and-forget — never throws, never blocks. */
export function sendAlert(message: string): void {
  // Priority 1: native Telegram bot (richer — Markdown, webhook replies)
  if (isTelegramConfigured()) {
    sendMessage(message);
    return;
  }

  // Priority 2: legacy generic webhook
  const url = webhookUrl();
  if (!url) return;
  // Fire-and-forget — don't await, don't block the engine
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
    signal: AbortSignal.timeout(5_000),
  }).catch((err) => {
    console.warn(`${TAG} alert failed: ${(err as Error).message}`);
  });
}

/** Shorthand severity levels for common events. */
export const alerts = {
  tradePlaced: (symbol: string, side: string, price: number) =>
    sendAlert(`🟢 TRADE ${side} ${symbol} @ ₹${price}`),

  tradeExited: (symbol: string, reason: string, pnl: number | null) =>
    sendAlert(`🔴 EXIT ${symbol}: ${reason}${pnl != null ? ` (P&L ₹${pnl})` : ''}`),

  killSwitchActivated: () =>
    sendAlert(`🚨 KILL SWITCH activated — no new orders`),

  dailyLossHalt: (loss: number) =>
    sendAlert(`🛑 DAILY LOSS HALT: ₹${loss} — no new entries`),

  exitFailureEscalation: (symbol: string, failures: number) =>
    sendAlert(`⚠️ ${symbol}: ${failures} consecutive exit failures — MANUAL INTERVENTION NEEDED`),

  eodSquareOff: (symbol: string) =>
    sendAlert(`⏰ EOD square-off: ${symbol}`),

  stalePhantom: (symbol: string) =>
    sendAlert(`👻 STALE PHANTOM: ${symbol} — entry fill unconfirmed >5 min, trade FAILED`),
};