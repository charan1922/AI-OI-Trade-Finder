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
});

export const env = envSchema.parse(process.env);

export function hasDhanCredentials(): boolean {
  return !!env.DHAN_CLIENT_ID && !!env.DHAN_ACCESS_TOKEN;
}

export function isVercel(): boolean {
  return env.VERCEL === '1';
}
