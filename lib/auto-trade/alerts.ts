/**
 * Lightweight alerting for critical auto-trade events — sends to a Telegram
 * bot (or any webhook) so the operator sees real-time notifications without
 * checking Railway logs. Best-effort: a failure here never blocks the engine.
 *
 * Set AUTO_TRADE_ALERT_WEBHOOK to a Telegram bot URL like:
 *   https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>
 *
 * Or any POST-accepting webhook. The message is sent as JSON body { text }.
 */

import { env } from '@/lib/env';

const TAG = '[AutoTradeAlert]';

function webhookUrl(): string | null {
  return env.AUTO_TRADE_ALERT_WEBHOOK ?? null;
}

/** Send an alert. Fire-and-forget — never throws, never blocks. */
export function sendAlert(message: string): void {
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