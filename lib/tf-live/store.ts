import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { prisma } from '@/lib/db';

const SESSION_KEY_ENV = 'TF_LIVE_SESSION_KEY';
const DAILY_INDEX_URL = 'https://tradefinder.in/api_be/data/order/daily-index';
const MAX_TOKEN_LENGTH = 8_000;

let tablesReady = false;

type SessionRow = {
  encryptedLt: string;
  encryptedAt: string;
  updatedAt: string;
  verifiedAt: string | null;
  lastError: string | null;
};

export type TfLiveSessionStatus = {
  configured: boolean;
  updatedAt: string | null;
  verifiedAt: string | null;
  lastError: string | null;
};

async function ensureTables(): Promise<void> {
  if (tablesReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS tf_live_session (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      encryptedLt   TEXT NOT NULL,
      encryptedAt   TEXT NOT NULL,
      updatedAt     TEXT NOT NULL,
      verifiedAt    TEXT,
      lastError     TEXT
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

/** Fail before accepting a sensitive value if encrypted storage is not ready. */
export function assertTfLiveSessionKeyConfigured(): void {
  sessionKey();
}

function encryptValue(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sessionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}

function decryptValue(encrypted: string): string {
  const [version, ivText, tagText, ciphertextText] = encrypted.split(':');
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText) throw new Error('stored TradeFinder token is malformed');
  const decipher = createDecipheriv('aes-256-gcm', sessionKey(), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * Used by the collector only; never return these from a Route Handler.
 * TradeFinder's own frontend sends `lt` (from localStorage) as the `jwtToken`
 * header and `at` (from sessionStorage) as the `accessToken` header — no
 * cookie required. Confirmed live 2026-08-05 against both `all_sector` and
 * `daily-index` with credentials:'omit'.
 */
export async function getTfLiveTokens(): Promise<{ lt: string; at: string } | null> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT encryptedLt, encryptedAt FROM tf_live_session WHERE id = 1`
  )) as Pick<SessionRow, 'encryptedLt' | 'encryptedAt'>[];
  const row = rows[0];
  if (!row) return null;
  return { lt: decryptValue(row.encryptedLt), at: decryptValue(row.encryptedAt) };
}

export async function getTfLiveSessionStatus(): Promise<TfLiveSessionStatus> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT encryptedLt, updatedAt, verifiedAt, lastError FROM tf_live_session WHERE id = 1`
  )) as Pick<SessionRow, 'encryptedLt' | 'updatedAt' | 'verifiedAt' | 'lastError'>[];
  const row = rows[0];
  return row
    ? { configured: true, updatedAt: row.updatedAt, verifiedAt: row.verifiedAt, lastError: row.lastError }
    : { configured: false, updatedAt: null, verifiedAt: null, lastError: null };
}

/** Proves the pasted (lt, at) actually authenticate — a real, tiny data call,
 *  not just "non-empty strings". No cookies sent. */
export async function validateTfLiveTokens(lt: string, at: string): Promise<{ valid: boolean; error?: string }> {
  if (!lt || !at || lt.length > MAX_TOKEN_LENGTH || at.length > MAX_TOKEN_LENGTH) {
    return { valid: false, error: 'lt/at is empty or too large' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(DAILY_INDEX_URL, {
      cache: 'no-store',
      headers: { accept: 'application/json', jwtToken: lt, accessToken: at },
      signal: controller.signal,
    });
    if (!response.ok) return { valid: false, error: `TradeFinder returned HTTP ${response.status}` };
    const body = (await response.json().catch(() => null)) as { status?: string } | null;
    if (!body || body.status !== 'SUCCESS') return { valid: false, error: 'TradeFinder rejected the token (not SUCCESS)' };
    return { valid: true };
  } catch {
    return { valid: false, error: 'TradeFinder token validation failed (network or timeout)' };
  } finally {
    clearTimeout(timeout);
  }
}

export async function saveTfLiveTokens(lt: string, at: string): Promise<void> {
  await ensureTables();
  const now = new Date().toISOString();
  await prisma.$executeRawUnsafe(
    `INSERT INTO tf_live_session (id, encryptedLt, encryptedAt, updatedAt, verifiedAt, lastError)
       VALUES (1, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         encryptedLt = excluded.encryptedLt,
         encryptedAt = excluded.encryptedAt,
         updatedAt = excluded.updatedAt,
         verifiedAt = excluded.verifiedAt,
         lastError = NULL`,
    encryptValue(lt),
    encryptValue(at),
    now,
    now
  );
}

/** Records that the collector itself used the stored tokens successfully (or
 *  why not), independent of the paste-time validation above. */
export async function recordTfLiveSessionOutcome(ok: boolean, error?: string): Promise<void> {
  await ensureTables();
  const now = new Date().toISOString();
  if (ok) {
    await prisma.$executeRawUnsafe(`UPDATE tf_live_session SET verifiedAt = ?, lastError = NULL WHERE id = 1`, now);
  } else {
    await prisma.$executeRawUnsafe(`UPDATE tf_live_session SET lastError = ? WHERE id = 1`, error ?? 'unknown error');
  }
}

/** Retain an immutable response without exposing it through status APIs. */
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

/** Latest capture per endpoint, for the /tf status panel. */
export async function getLatestTfLiveCaptures(): Promise<
  { endpoint: string; capturedAt: string; status: string; error: string | null }[]
> {
  await ensureTables();
  return (await prisma.$queryRawUnsafe(`
    SELECT endpoint, capturedAt, status, error
      FROM tf_live_captures c
     WHERE capturedAt = (
       SELECT MAX(capturedAt) FROM tf_live_captures c2 WHERE c2.endpoint = c.endpoint
     )
     ORDER BY endpoint
  `)) as { endpoint: string; capturedAt: string; status: string; error: string | null }[];
}
