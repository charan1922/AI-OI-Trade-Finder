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
import type { SendMessageOptions } from '@/lib/telegram/bot';
import { getAutoTradeSettings } from './settings';

const TAG = '[AutoTradeAlert]';

function webhookUrl(): string | null {
  return env.AUTO_TRADE_ALERT_WEBHOOK ?? null;
}

/** True when at least one alert channel exists. Approval/live mode refuses to
 *  engage without one (critical incidents must be deliverable somewhere). */
export function hasCriticalAlertChannel(): boolean {
  return isTelegramConfigured() || webhookUrl() != null;
}

/**
 * CRITICAL alert — safety incidents (unknown orders, position mismatches,
 * orphan positions, guard blindness, loss halts). Unlike sendAlert, this
 * IGNORES the telegramAlerts toggle: the operator may silence commentary and
 * trade chatter, but never incident notifications (AT-008). With no channel at
 * all it logs loudly — the mode preflight in settings.ts prevents approval/
 * live from engaging in that state.
 */
export function sendCriticalAlert(message: string): void {
  if (isTelegramConfigured()) {
    sendMessage(message);
    return;
  }
  const url = webhookUrl();
  if (url) {
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
      signal: AbortSignal.timeout(5_000),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`webhook HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      })
      .catch((err) => {
        console.error(`${TAG} CRITICAL alert delivery failed: ${(err as Error).message} — message was: ${message}`);
      });
    return;
  }
  console.error(`${TAG} CRITICAL (no alert channel configured): ${message}`);
}

/** Queue an alert without blocking the trading path. Delivery is checked and
 * logged by the Telegram/webhook client; a settings failure suppresses it. */
export function sendAlert(message: string): void {
  // Priority 1: native Telegram bot (richer — Markdown, webhook replies)
  if (isTelegramConfigured()) {
    // Check the toggle asynchronously; the trading path never waits on chat.
    getAutoTradeSettings()
      .then((s) => {
        if (s.telegramAlerts) sendMessage(message);
      })
      .catch((err) => {
        console.warn(`${TAG} settings lookup failed; alert suppressed: ${(err as Error).message}`);
      });
    return;
  }

  // Priority 2: legacy generic webhook
  const url = webhookUrl();
  if (!url) return;
  // Asynchronous delivery; response status is still verified below.
  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
    signal: AbortSignal.timeout(5_000),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`webhook HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    })
    .catch((err) => {
      console.warn(`${TAG} alert failed: ${(err as Error).message}`);
    });
}

/** Shorthand severity levels for common events. */
export const alerts = {
  tradePlaced: (symbol: string, side: string, price: number) => sendAlert(`🟢 TRADE ${side} ${symbol} @ ₹${price}`),

  tradeExited: (symbol: string, reason: string, pnl: number | null) =>
    sendAlert(`🔴 EXIT ${symbol}: ${reason}${pnl != null ? ` (P&L ₹${pnl})` : ''}`),

  /** Send a pending-approval alert with inline Approve / Reject buttons. */
  approvalRequested: (
    tradeId: number,
    symbol: string,
    optionType: string,
    strike: number,
    premium: number | null,
    reason: string
  ) => {
    const html = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const premiumStr = premium != null ? ` @ ₹${premium}` : '';
    const text =
      `⏳ <b>APPROVAL NEEDED</b> #${tradeId}\n\n` +
      `<b>${html(symbol)}</b> ${html(optionType)} ${strike}${premiumStr}\n` +
      `Reason: ${html(reason.slice(0, 200))}\n\n` +
      `⏰ Expires in a few minutes — tap a button below:`;
    const options: SendMessageOptions = {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `✅ Approve #${tradeId}`,
              callback_data: `/approve ${tradeId}`,
            },
            {
              text: `❌ Reject #${tradeId}`,
              callback_data: `/reject ${tradeId}`,
            },
          ],
        ],
      },
    };
    if (!isTelegramConfigured()) return;
    void getAutoTradeSettings()
      .then((settings) => {
        if (settings.telegramAlerts) sendMessage(text, options);
      })
      .catch((err) => {
        console.warn(`${TAG} approval alert suppressed: ${(err as Error).message}`);
      });
  },

  // ── CRITICAL class: never suppressed by the telegramAlerts toggle ──────────

  killSwitchActivated: () => sendCriticalAlert(`🚨 KILL SWITCH activated — no new orders`),

  dailyLossHalt: (loss: number) => sendCriticalAlert(`🛑 DAILY LOSS HALT: ₹${loss} — no new entries`),

  exitFailureEscalation: (symbol: string, failures: number) =>
    sendCriticalAlert(`⚠️ ${symbol}: ${failures} consecutive exit failures — MANUAL INTERVENTION NEEDED`),

  manualReconciliation: (symbol: string, side: 'BUY' | 'SELL', reference: string, detail: string) =>
    sendCriticalAlert(`🚨 ${symbol} ${side} ORDER UNRESOLVED — verify at broker now. Ref ${reference}. ${detail}`),

  positionMismatch: (symbol: string, detail: string) =>
    sendCriticalAlert(`🚨 POSITION MISMATCH ${symbol}: ${detail} — verify at the broker now`),

  guardBlind: (detail: string) => sendCriticalAlert(`🙈 GUARD BLIND: ${detail} — premium stops are NOT being checked`),

  eodSquareOff: (symbol: string) => sendAlert(`⏰ EOD square-off: ${symbol}`),
};
