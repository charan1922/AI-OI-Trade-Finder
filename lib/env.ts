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
  // One-password gate (middleware.ts). Set to enable HTTP Basic Auth over the
  // whole app on a deployed host; leave unset for password-free local dev.
  APP_PASSWORD: z.string().optional(),
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
