#!/usr/bin/env npx tsx
/**
 * Register the Telegram webhook for Project-R auto-trade bot.
 *
 * Run:   npx tsx scripts/setup-telegram-webhook.ts [URL]
 *
 * If URL is omitted, defaults to the production Railway origin.
 * Requires TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET
 * in .env or environment.
 */

import { setWebhook, deleteWebhook, getWebhookInfo, isTelegramConfigured } from '../lib/telegram/bot';
import { env } from '../lib/env';

const PRODUCTION_ORIGIN = 'https://project-r-simulator-production.up.railway.app';

async function main() {
  const args = process.argv.slice(2);

  // ── Delete mode ──────────────────────────────────────────────────────
  if (args[0] === '--delete') {
    if (!isTelegramConfigured()) {
      console.error('❌ TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set.');
      process.exit(1);
    }
    console.log('🗑  Deleting webhook...');
    const ok = await deleteWebhook();
    console.log(ok ? '✅ Webhook deleted.' : '❌ Failed to delete webhook.');
    process.exit(ok ? 0 : 1);
  }

  // ── Info mode ────────────────────────────────────────────────────────
  if (args[0] === '--info') {
    if (!isTelegramConfigured()) {
      console.error('❌ TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set.');
      process.exit(1);
    }
    console.log('ℹ️  Current webhook info:');
    const info = await getWebhookInfo();
    console.log(JSON.stringify(info, null, 2));
    process.exit(0);
  }

  // ── Register mode (default) ──────────────────────────────────────────
  if (!isTelegramConfigured()) {
    console.error('❌ Missing environment variables:');
    console.error('   TELEGRAM_BOT_TOKEN   — from @BotFather');
    console.error('   TELEGRAM_CHAT_ID     — your numeric chat id');
    console.error('   TELEGRAM_WEBHOOK_SECRET — arbitrary secret for webhook verification');
    process.exit(1);
  }

  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    console.error('❌ TELEGRAM_WEBHOOK_SECRET must be set for secure webhook registration.');
    process.exit(1);
  }

  const origin = args[0] || PRODUCTION_ORIGIN;
  const webhookUrl = `${origin.replace(/\/$/, '')}/api/telegram/webhook`;

  console.log(`🔗 Registering webhook: ${webhookUrl}`);
  console.log(`   Secret: ${env.TELEGRAM_WEBHOOK_SECRET.slice(0, 4)}****`);

  const ok = await setWebhook(webhookUrl, env.TELEGRAM_WEBHOOK_SECRET);

  if (ok) {
    console.log('✅ Webhook registered successfully!');
    console.log('');
    console.log('   Telegram will now POST updates to:');
    console.log(`   ${webhookUrl}`);
    console.log('');
    console.log('   Send /status to your bot to test.');

    // Show current info
    const info = await getWebhookInfo();
    if (info) {
      console.log('\n📋 Webhook info:');
      console.log(JSON.stringify(info, null, 2));
    }
  } else {
    console.error('❌ Failed to register webhook. Check bot token and try again.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('❌ Fatal:', err);
  process.exit(1);
});