/**
 * Telegram bot barrel export — the public surface for the telegram module.
 */

export {
  isTelegramConfigured,
  sendMessage,
  sendMessageTo,
  setWebhook,
  deleteWebhook,
  getWebhookInfo,
  verifyWebhookSecret,
} from './bot';

export type {
  TelegramUpdate,
  TelegramMessage,
  TelegramCallbackQuery,
  SendMessageOptions,
} from './bot';

export { handleTelegramMessage } from './handlers';