import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { prisma } from '@/lib/db';

const SESSION_KEY_ENV = 'TF_LIVE_SESSION_KEY';
const SESSION_URL = 'https://tradefinder.in/api/auth/session';
const MAX_COOKIE_LENGTH = 32_000;

let tablesReady = false;

type SessionRow = {
  encryptedCookie: string;
  updatedAt: string;
  expiresAt: string | null;
  verifiedAt: string | null;
  lastError: string | null;
};

export type TfLiveSessionStatus = {
  configured: boolean;
  updatedAt: string | null;
  expiresAt: string | null;
  verifiedAt: string | null;
  lastError: string | null;
};

async function ensureTables(): Promise<void> {
  if (tablesReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS tf_live_session (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      encryptedCookie TEXT NOT NULL,
      updatedAt       TEXT NOT NULL,
      expiresAt       TEXT,
      verifiedAt      TEXT,
      lastError       TEXT
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS tf_live_captures (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      capturedAt  TEXT NOT NULL,
      endpoint    TEXT NOT NULL,
      status      TEXT NOT NULL,
      payloadHash TEXT,
      payloadJson TEXT,
      error       TEXT
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_tf_live_captures_at ON tf_live_captures(capturedAt)`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS tf_live_rows (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      captureId   INTEGER NOT NULL,
      rowKey      TEXT NOT NULL,
      symbol      TEXT,
      payloadJson TEXT NOT NULL,
      UNIQUE(captureId, rowKey)
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_tf_live_rows_symbol ON tf_live_rows(symbol)`);
  tablesReady = true;
}

function sessionKey(): Buffer {
  const value = process.env[SESSION_KEY_ENV];
  if (!value) throw new Error(`${SESSION_KEY_ENV} is not configured`);
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error(`${SESSION_KEY_ENV} must be a base64-encoded 32-byte key`);
  return key;
}

/** Fail before accepting a sensitive session value if encrypted storage is not ready. */
export function assertTfLiveSessionKeyConfigured(): void {
  sessionKey();
}

function encryptCookie(cookie: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sessionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(cookie, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}

/** Used by the collector only; never return this value from a Route Handler. */
export async function getTfLiveCookie(): Promise<string | null> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT encryptedCookie FROM tf_live_session WHERE id = 1`
  )) as Pick<SessionRow, 'encryptedCookie'>[];
  const encrypted = rows[0]?.encryptedCookie;
  if (!encrypted) return null;

  const [version, ivText, tagText, ciphertextText] = encrypted.split(':');
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText) throw new Error('stored TradeFinder session is malformed');
  const decipher = createDecipheriv('aes-256-gcm', sessionKey(), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64')), decipher.final()]).toString('utf8');
}

export async function getTfLiveSessionStatus(): Promise<TfLiveSessionStatus> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT encryptedCookie, updatedAt, expiresAt, verifiedAt, lastError FROM tf_live_session WHERE id = 1`
  )) as SessionRow[];
  const row = rows[0];
  return row
    ? {
        configured: true,
        updatedAt: row.updatedAt,
        expiresAt: row.expiresAt,
        verifiedAt: row.verifiedAt,
        lastError: row.lastError,
      }
    : { configured: false, updatedAt: null, expiresAt: null, verifiedAt: null, lastError: null };
}

export async function validateTfLiveCookie(cookie: string): Promise<{ valid: boolean; expiresAt: string | null; error?: string }> {
  if (cookie.length === 0 || cookie.length > MAX_COOKIE_LENGTH) return { valid: false, expiresAt: null, error: 'cookie is empty or too large' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(SESSION_URL, {
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        cookie,
        referer: 'https://tradefinder.in/',
        'user-agent': 'Project-R tf_live session validator',
      },
      signal: controller.signal,
    });
    if (!response.ok) return { valid: false, expiresAt: null, error: `TradeFinder returned HTTP ${response.status}` };
    const body = (await response.json().catch(() => null)) as { user?: unknown; expires?: unknown } | null;
    if (!body || !body.user) return { valid: false, expiresAt: null, error: 'TradeFinder returned no signed-in user' };
    return { valid: true, expiresAt: typeof body.expires === 'string' ? body.expires : null };
  } catch {
    return { valid: false, expiresAt: null, error: 'TradeFinder session validation failed' };
  } finally {
    clearTimeout(timeout);
  }
}

export async function saveTfLiveCookie(cookie: string, expiresAt: string | null): Promise<void> {
  await ensureTables();
  const now = new Date().toISOString();
  await prisma.$executeRawUnsafe(
    `INSERT INTO tf_live_session (id, encryptedCookie, updatedAt, expiresAt, verifiedAt, lastError)
       VALUES (1, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         encryptedCookie = excluded.encryptedCookie,
         updatedAt = excluded.updatedAt,
         expiresAt = excluded.expiresAt,
         verifiedAt = excluded.verifiedAt,
         lastError = NULL`,
    encryptCookie(cookie),
    now,
    expiresAt,
    now
  );
}

/** Future collector helper: retain an immutable response without exposing it through status APIs. */
export async function recordTfLiveCapture(input: {
  endpoint: string;
  status: 'success' | 'error';
  payloadJson?: string;
  error?: string;
}): Promise<number> {
  await ensureTables();
  const hash = input.payloadJson ? createHash('sha256').update(input.payloadJson).digest('hex') : null;
  await prisma.$executeRawUnsafe(
    `INSERT INTO tf_live_captures (capturedAt, endpoint, status, payloadHash, payloadJson, error) VALUES (?, ?, ?, ?, ?, ?)`,
    new Date().toISOString(),
    input.endpoint,
    input.status,
    hash,
    input.payloadJson ?? null,
    input.error ?? null
  );
  const idRows = (await prisma.$queryRawUnsafe(`SELECT last_insert_rowid() AS id`)) as { id: number }[];
  return Number(idRows[0]?.id ?? 0);
}

/** Persist source-shaped records from one immutable capture. */
export async function recordTfLiveRows(captureId: number, rows: unknown[]): Promise<void> {
  await ensureTables();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const object = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
    const symbol = [object.symbol, object.Symbol, object.ticker, object.name].find((value) => typeof value === 'string');
    const rowKey = String(object.id ?? object.symbol ?? object.Symbol ?? object.ticker ?? index);
    await prisma.$executeRawUnsafe(
      `INSERT OR IGNORE INTO tf_live_rows (captureId, rowKey, symbol, payloadJson) VALUES (?, ?, ?, ?)`,
      captureId,
      rowKey,
      typeof symbol === 'string' ? symbol : null,
      JSON.stringify(row)
    );
  }
}
