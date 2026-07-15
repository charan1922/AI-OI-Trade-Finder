import { z } from 'zod';

const envSchema = z.object({
  DHAN_CLIENT_ID: z.string().optional(),
  DHAN_ACCESS_TOKEN: z.string().optional(),
  DHAN_PIN: z.string().optional(),
  DHAN_TOTP_SECRET: z.string().optional(),
  VERCEL: z.string().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  AI_GATEWAY_API_KEY: z.string().optional(), // Vercel AI Gateway or DeepSeek API key
  // Azure OpenAI (Trade Assistant chatbot) — see lib/ai-assistant/
  AZURE_OPENAI_API_KEY: z.string().optional(),
  AZURE_OPENAI_INSTANCE_NAME: z.string().optional(),
  AZURE_OPENAI_CHAT_DEPLOYMENT: z.string().optional(),
  AZURE_OPENAI_API_VERSION: z.string().optional(),
  // Fyers live 5-min F&O data (lib/fyers/) — TOTP auto-login; all six required together
  FYERS_ID: z.string().optional(), // Fyers login/client id, e.g. XC01234
  FYERS_APP_ID: z.string().optional(), // API app id incl. type suffix, e.g. ABCD1EFG2H-100
  FYERS_SECRET_KEY: z.string().optional(), // API app secret key
  FYERS_TOTP_SECRET: z.string().optional(), // base32 TOTP secret from Fyers 2FA setup
  FYERS_PIN: z.string().optional(), // 4-digit login PIN
  FYERS_REDIRECT_URI: z.string().optional(), // must exactly match the app's configured redirect
  // Password gate + RBAC (proxy.ts, policy in lib/auth/rbac.ts). APP_PASSWORD
  // enables HTTP Basic Auth over the whole app and grants the admin role;
  // leave unset for password-free local dev. APP_READONLY_PASSWORD (optional,
  // only meaningful alongside APP_PASSWORD) grants the read-only viewer role:
  // every page and read API, but all state-changing actions 403.
  APP_PASSWORD: z.string().optional(),
  APP_READONLY_PASSWORD: z.string().optional(),
  GOOGLE_VIEWER_EMAILS: z.string().optional(),
  // Auth.js (NextAuth v5) Google sign-in — the "Continue with Google" button on
  // /login. AUTH_GOOGLE_ID/SECRET are read by the Google provider via Auth.js
  // env convention; AUTH_SECRET signs the session JWTs (generate with
  // `npx auth secret` or 32 random bytes). The OAuth client in Google Cloud
  // Console must list <origin>/api/auth/callback/google as an authorized
  // redirect URI for every host (http://localhost:5001 + production).
  AUTH_GOOGLE_ID: z.string().optional(),
  AUTH_GOOGLE_SECRET: z.string().optional(),
  AUTH_SECRET: z.string().optional(),
  // REQUIRED IN PRODUCTION: the app's public origin, e.g.
  // https://project-r-simulator-production.up.railway.app — behind Railway's
  // proxy the request URL shows the internal bind address (0.0.0.0:5001), so
  // without this Auth.js sends Google an insecure/IP redirect_uri and Google
  // blocks the sign-in with "invalid_request" (seen live 2026-07-12).
  AUTH_URL: z.string().optional(),
  // Xiaomi MiMo (OpenAI-compatible) — powers the /trade-commentary AI narration
  // of the deterministic scan picks. Reasoning model; see lib/ai-commentary/.
  MIMO_API_KEY: z.string().optional(),
  MIMO_BASE_URL: z.string().optional(),
  MIMO_MODEL: z.string().optional(), // default 'mimo-v2.5-pro'
  // Second key for auto-trade LIVE mode (lib/auto-trade/): the /auto-trade page
  // can select mode 'live', but real autonomous orders stay blocked until this
  // is ALSO 'true' — a deliberate two-key safety on real money.
  AUTO_TRADE_LIVE_ENABLED: z.string().optional(),
  // Optional webhook for auto-trade alerts (lib/auto-trade/alerts.ts).
  // Telegram example: https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>
  AUTO_TRADE_ALERT_WEBHOOK: z.string().optional(),
  // Telegram bot for bidirectional alerts + webhook commands.
  // TELEGRAM_BOT_TOKEN is the bot token from @BotFather.
  // TELEGRAM_CHAT_ID is the operator's chat id (numeric string).
  // TELEGRAM_WEBHOOK_SECRET is an arbitrary secret token Telegram sends back
  // in the X-Telegram-Bot-Api-Secret-Token header for webhook verification.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  // Additional read-only recipients for commentary broadcasts (comma-separated
  // numeric chat ids). They receive commentary only — operator commands and
  // approval prompts still go exclusively to TELEGRAM_CHAT_ID.
  TELEGRAM_VIEWER_CHAT_IDS: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
});

export const env = envSchema.parse(process.env);

export function hasDhanCredentials(): boolean {
  return !!env.DHAN_CLIENT_ID && !!env.DHAN_ACCESS_TOKEN;
}

/** True when the full Fyers TOTP auto-login chain is configured (lib/fyers/auth.ts). */
export function hasFyersCredentials(): boolean {
  return (
    !!env.FYERS_ID &&
    !!env.FYERS_APP_ID &&
    !!env.FYERS_SECRET_KEY &&
    !!env.FYERS_TOTP_SECRET &&
    !!env.FYERS_PIN &&
    !!env.FYERS_REDIRECT_URI
  );
}

/** True when Azure OpenAI is configured (the Trade Assistant needs all three). */
export function hasAzureOpenAI(): boolean {
  return !!env.AZURE_OPENAI_API_KEY && !!env.AZURE_OPENAI_INSTANCE_NAME && !!env.AZURE_OPENAI_CHAT_DEPLOYMENT;
}

export function isVercel(): boolean {
  return env.VERCEL === '1';
}

/** True when the MiMo commentary model is configured (key + base URL). */
export function hasMimo(): boolean {
  return !!env.MIMO_API_KEY && !!env.MIMO_BASE_URL;
}

/** Second key for auto-trade live mode (see lib/auto-trade/risk/gates.ts). */
export function isAutoTradeLiveEnabled(): boolean {
  return env.AUTO_TRADE_LIVE_ENABLED === 'true';
}

/** True when Auth.js Google sign-in is configured (client id + secret + JWT key). */
export function hasGoogleAuth(): boolean {
  return !!env.AUTH_GOOGLE_ID && !!env.AUTH_GOOGLE_SECRET && !!env.AUTH_SECRET;
}
