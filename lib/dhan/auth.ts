/**
 * Dhan Access Token Auto-Generation
 *
 * Generates JWT access tokens via TOTP (2FA) so you never need to
 * manually update DHAN_ACCESS_TOKEN in .env.local.
 *
 * Token is cached in globalThis (survives HMR) + disk (survives restarts).
 * Only regenerates when token is near expiry (1hr buffer).
 *
 * Required env vars:
 *   DHAN_CLIENT_ID    — numeric Dhan client ID
 *   DHAN_PIN          — 6-digit login PIN
 *   DHAN_TOTP_SECRET  — base32 TOTP secret from authenticator setup
 *
 * Falls back to static DHAN_ACCESS_TOKEN if TOTP vars aren't set.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TOTP } from 'otpauth';

const TAG = '[DhanAuth]';
const REFRESH_BUFFER_MS = 60 * 60 * 1000; // 1hr before expiry
const TOKEN_CACHE_FILE = path.join(process.cwd(), 'data', '.dhan-token.json');

// ─── Global cache (survives HMR reloads in dev) ─────────────────────────────

const g = globalThis as unknown as {
  __dhanToken?: string | null;
  __dhanExpiry?: number;
  __dhanPromise?: Promise<string> | null;
};

function getToken(): string | null {
  return g.__dhanToken ?? null;
}
function getExpiry(): number {
  return g.__dhanExpiry ?? 0;
}
function setToken(token: string, expiresAt: number): void {
  g.__dhanToken = token;
  g.__dhanExpiry = expiresAt;
  fs.writeFile(TOKEN_CACHE_FILE, JSON.stringify({ token, expiresAt })).catch(() => {});
}

async function loadFromDisk(): Promise<void> {
  if (getToken()) return;
  try {
    const raw = await fs.readFile(TOKEN_CACHE_FILE, 'utf-8');
    const { token, expiresAt } = JSON.parse(raw);
    if (token && expiresAt > Date.now() + REFRESH_BUFFER_MS) {
      g.__dhanToken = token;
      g.__dhanExpiry = expiresAt;
      console.log(
        `${TAG} Loaded cached token from disk, expires ${new Date(expiresAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
      );
    }
  } catch {
    // No cached token on disk
  }
}

// ─── TOTP helpers ────────────────────────────────────────────────────────────

function hasTotpCredentials(): boolean {
  return !!(process.env.DHAN_CLIENT_ID && process.env.DHAN_PIN && process.env.DHAN_TOTP_SECRET);
}

function generateTotpCode(): string {
  return new TOTP({
    secret: process.env.DHAN_TOTP_SECRET!,
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
  }).generate();
}

function parseJwtExpiry(jwt: string): number {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    return payload.exp * 1000;
  } catch {
    return Date.now() + 24 * 60 * 60 * 1000;
  }
}

// ─── Token generation ────────────────────────────────────────────────────────

async function fetchAccessToken(): Promise<{ token: string; expiresAt: number }> {
  const clientId = process.env.DHAN_CLIENT_ID!;
  const pin = process.env.DHAN_PIN!;
  const totp = generateTotpCode();

  console.log(`${TAG} Generating access token via TOTP...`);

  const url = `https://auth.dhan.co/app/generateAccessToken?dhanClientId=${clientId}&pin=${pin}&totp=${totp}`;
  const resp = await fetch(url, { method: 'POST' });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`${TAG} Token generation failed (HTTP ${resp.status}): ${body}`);
  }

  const data = await resp.json();
  if (!data.accessToken) {
    throw new Error(`${TAG} No accessToken in response: ${JSON.stringify(data)}`);
  }

  const expiresAt = parseJwtExpiry(data.accessToken);
  console.log(
    `${TAG} Token generated. Expires: ${new Date(expiresAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
  );

  return { token: data.accessToken, expiresAt };
}

async function tryRenewToken(currentToken: string): Promise<{ token: string; expiresAt: number } | null> {
  try {
    console.log(`${TAG} Attempting token renewal...`);
    const resp = await fetch('https://api.dhan.co/v2/RenewToken', {
      method: 'POST',
      headers: {
        'access-token': currentToken,
        'Content-Type': 'application/json',
        'client-id': process.env.DHAN_CLIENT_ID!,
      },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.accessToken) return null;
    console.log(`${TAG} Token renewed.`);
    return { token: data.accessToken, expiresAt: parseJwtExpiry(data.accessToken) };
  } catch {
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get a valid Dhan access token.
 *
 * Priority:
 * 1. Cached token (globalThis, survives HMR)
 * 2. Disk cache (survives full restart)
 * 3. Renew existing token via /v2/RenewToken
 * 4. Generate fresh token via TOTP
 * 5. Fall back to static DHAN_ACCESS_TOKEN env var
 */
export async function getDhanAccessToken(): Promise<string> {
  // 1. Return cached token if still fresh
  if (getToken() && Date.now() < getExpiry() - REFRESH_BUFFER_MS) {
    return getToken()!;
  }

  // Prevent concurrent generation (Dhan rate limits to 1 per 2 min)
  if (g.__dhanPromise) return g.__dhanPromise;

  g.__dhanPromise = (async () => {
    try {
      // 2. Try loading from disk
      await loadFromDisk();
      if (getToken() && Date.now() < getExpiry() - REFRESH_BUFFER_MS) {
        return getToken()!;
      }

      // 3. Try renewing existing token
      const current = getToken();
      if (current) {
        const renewed = await tryRenewToken(current);
        if (renewed) {
          setToken(renewed.token, renewed.expiresAt);
          return renewed.token;
        }
      }

      // 4. Generate via TOTP
      if (hasTotpCredentials()) {
        const { token, expiresAt } = await fetchAccessToken();
        setToken(token, expiresAt);
        return token;
      }

      // 5. Fall back to static env var
      const staticToken = process.env.DHAN_ACCESS_TOKEN;
      if (staticToken) {
        console.log(`${TAG} Using static DHAN_ACCESS_TOKEN`);
        setToken(staticToken, parseJwtExpiry(staticToken));
        return staticToken;
      }

      throw new Error(`${TAG} No Dhan credentials. Set DHAN_PIN + DHAN_TOTP_SECRET, or DHAN_ACCESS_TOKEN.`);
    } finally {
      g.__dhanPromise = null;
    }
  })();

  return g.__dhanPromise;
}

/**
 * Clear cached token (in-memory + disk).
 * Call when Dhan returns 400/401 — forces fresh TOTP generation on next request.
 */
export function clearCachedToken(): void {
  g.__dhanToken = null;
  g.__dhanExpiry = 0;
  fs.unlink(TOKEN_CACHE_FILE).catch(() => {});
  console.warn(`${TAG} Cleared cached token`);
}

/**
 * Check if Dhan credentials are available (either TOTP or static token).
 */
export function hasDhanAuth(): boolean {
  return hasTotpCredentials() || !!(process.env.DHAN_CLIENT_ID && process.env.DHAN_ACCESS_TOKEN);
}
