/**
 * Global Dhan API Rate Limiter
 *
 * Singleton queue that ALL Dhan API calls must go through.
 * Enforces rate limits globally — not per-module.
 *
 * Official Dhan rate limits:
 *   Data APIs (/charts/*):     10 req/sec → 100ms min gap
 *   Quote APIs (/marketfeed/*, /optionchain): 1 req/sec → 1000ms min gap
 *   Order APIs:                25 req/sec
 *   Non-Trading APIs:          20 req/sec
 *
 * Implementation: Sequential queue with per-category delay.
 * Built-in retry with exponential backoff on 429.
 */

import { env } from '@/lib/env';
import { getDhanAccessToken, hasDhanAuth } from './auth';

const DHAN_API = 'https://api.dhan.co';

// Rate limits per category (ms between calls)
const RATE_LIMITS: Record<string, number> = {
  data: 110, // Charts: 10/sec → 100ms + 10ms buffer
  quote: 1100, // Marketfeed/optionchain: 1/sec + 100ms buffer
  order: 50, // Orders: 25/sec
  default: 200,
};

// Track last call time per category
const lastCallTime: Record<string, number> = {};

// Global sequential lock — ensures only 1 Dhan call at a time across all modules
let queuePromise: Promise<void> = Promise.resolve();

function getCategory(endpoint: string): string {
  if (endpoint.includes('/charts/')) return 'data';
  if (endpoint.includes('/marketfeed/') || endpoint.includes('/optionchain')) return 'quote';
  if (endpoint.includes('/orders')) return 'order';
  return 'default';
}

/**
 * Rate-limited Dhan API POST request.
 * All modules MUST use this instead of direct fetch.
 *
 * Features:
 * - Global sequential queue (no parallel calls)
 * - Per-category rate limiting
 * - Retry with exponential backoff on 429
 * - Max 3 attempts
 */
export async function dhanRequest(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
  if (!hasDhanAuth()) throw new Error('Dhan auth not configured');

  // Queue this request — wait for all previous requests to complete
  const result = new Promise<unknown>((resolve, reject) => {
    queuePromise = queuePromise.then(async () => {
      try {
        const res = await executeWithRetry(endpoint, body);
        resolve(res);
      } catch (e) {
        reject(e);
      }
    });
  });

  return result;
}

async function executeWithRetry(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
  const category = getCategory(endpoint);
  const minDelay = RATE_LIMITS[category] ?? RATE_LIMITS.default;
  const token = await getDhanAccessToken();

  for (let attempt = 1; attempt <= 3; attempt++) {
    // Enforce minimum gap since last call in this category
    const now = Date.now();
    const lastCall = lastCallTime[category] ?? 0;
    const elapsed = now - lastCall;
    if (elapsed < minDelay) {
      await new Promise((r) => setTimeout(r, minDelay - elapsed));
    }

    lastCallTime[category] = Date.now();

    const resp = await fetch(`${DHAN_API}${endpoint}`, {
      method: 'POST',
      headers: {
        'access-token': token,
        'client-id': env.DHAN_CLIENT_ID!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (resp.status === 429 && attempt < 3) {
      const backoff = attempt * 2000;
      console.warn(`[Dhan] 429 on ${endpoint}, backoff ${backoff}ms (attempt ${attempt})`);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Dhan ${resp.status}: ${text.slice(0, 200)}`);
    }

    return resp.json();
  }

  throw new Error(`Dhan: max retries on ${endpoint}`);
}
