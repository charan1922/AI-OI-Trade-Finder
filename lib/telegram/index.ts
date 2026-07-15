/**
 * Telegram bot barrel export — the public surface for the telegram module.
 */

export {
  isTelegramConfigured,
  sendMessage,
  sendMessageAsync,
  broadcastMessage,
  sendMessageTo,
  setWebhook,
  deleteWebhook,
  getWebhookInfo,
  verifyWebhookSecret,
} from './bot';

export { sendCommentaryToTelegram, markdownToTelegramHtml } from './commentary';

export type {
  TelegramUpdate,
  TelegramMessage,
  TelegramCallbackQuery,
  SendMessageOptions,
  TelegramDeliveryResult,
} from './bot';

export { handleTelegramMessage } from './handlers';
