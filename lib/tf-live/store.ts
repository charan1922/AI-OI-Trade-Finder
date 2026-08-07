import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { prisma } from '@/lib/db';
import { parseAllSector } from '@/lib/tf-live/parse';

const SESSION_KEY_ENV = 'TF_LIVE_SESSION_KEY';
const DAILY_INDEX_URL = 'https://tradefinder.in/api_be/data/order/daily-index';
const MAX_TOKEN_LENGTH = 8_000;

let tablesReady = false;

type SessionRow = {
  encryptedLt: string;
  encryptedAt: string;
  jwtExpiresAt: string | null;
  updatedAt: string;
  verifiedAt: string | null;
  lastError: string | null;
};

export type TfLiveSessionStatus = {
  configured: boolean;
  updatedAt: string | null;
  verifiedAt: string | null;
  lastError: string | null;
  /** Decoded from lt's own `exp` claim at paste time — no network call needed
   *  to know this. Confirmed live 2026-08-05: this JWT's lifetime is ~8 hours,
   *  NOT the ~30-day NextAuth login session it's easy to mistake it for. */
  jwtExpiresAt: string | null;
};

async function ensureTables(): Promise<void> {
  if (tablesReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS tf_live_session (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      encryptedLt   TEXT NOT NULL,
      encryptedAt   TEXT NOT NULL,
      jwtExpiresAt  TEXT,
      updatedAt     TEXT NOT NULL,
      verifiedAt    TEXT,
      lastError     TEXT
    )
  `);
  // Guarded ALTER for boxes whose tf_live_session predates this column —
  // CREATE TABLE IF NOT EXISTS is a no-op once the table already exists.
  try {
    await prisma.$executeRawUnsafe(`ALTER TABLE tf_live_session ADD COLUMN jwtExpiresAt TEXT`);
  } catch {
    /* column already exists */
  }
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
 * `lt` is itself a JWT with `exp` (and `start`) claims — decode them locally,
 * no TF call needed. This is metadata extraction (public JWT structure), not
 * signature verification: we never see TF's signing key and don't need to,
 * we just want to know when OUR OWN copy goes stale. Returns null for any
 * malformed/non-JWT input rather than throwing — this is a best-effort UX
 * hint, never load-bearing for auth.
 */
export function decodeJwtExpiry(jwt: string): string | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: number };
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
    return new Date(payload.exp * 1000).toISOString();
  } catch {
    return null;
  }
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
    `SELECT encryptedLt, jwtExpiresAt, updatedAt, verifiedAt, lastError FROM tf_live_session WHERE id = 1`
  )) as Pick<SessionRow, 'encryptedLt' | 'jwtExpiresAt' | 'updatedAt' | 'verifiedAt' | 'lastError'>[];
  const row = rows[0];
  return row
    ? {
        configured: true,
        updatedAt: row.updatedAt,
        verifiedAt: row.verifiedAt,
        lastError: row.lastError,
        jwtExpiresAt: row.jwtExpiresAt,
      }
    : { configured: false, updatedAt: null, verifiedAt: null, lastError: null, jwtExpiresAt: null };
}

/** Proves the pasted (lt, at) actually authenticate — a real, tiny data call,
 *  not just "non-empty strings". No cookies sent. Surfaces TF's own error
 *  code/message (e.g. "AT_ERROR: INVALID TOKEN") so a rejection says WHICH
 *  of the two values TF didn't like, not just "failed". */
export async function validateTfLiveTokens(lt: string, at: string): Promise<{ valid: boolean; error?: string }> {
  if (!lt || !at || lt.length > MAX_TOKEN_LENGTH || at.length > MAX_TOKEN_LENGTH) {
    return { valid: false, error: 'lt/at is empty or too large' };
  }
  const jwtExpiresAt = decodeJwtExpiry(lt);
  if (jwtExpiresAt && new Date(jwtExpiresAt).getTime() <= Date.now()) {
    return { valid: false, error: `lt already expired at ${jwtExpiresAt} — copy a fresh pair` };
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
    const body = (await response.json().catch(() => null)) as { status?: string; code?: string; message?: string } | null;
    if (!body || body.status !== 'SUCCESS') {
      const detail = body?.code ? `${body.code}: ${body.message ?? 'rejected'}` : 'no response body';
      return { valid: false, error: `TradeFinder rejected it (${detail})` };
    }
    return { valid: true };
  } catch (error) {
    const timedOut = (error as Error).name === 'AbortError';
    return { valid: false, error: timedOut ? 'TradeFinder timed out (12s)' : 'TradeFinder validation request failed (network)' };
  } finally {
    clearTimeout(timeout);
  }
}

export async function saveTfLiveTokens(lt: string, at: string): Promise<void> {
  await ensureTables();
  const now = new Date().toISOString();
  const jwtExpiresAt = decodeJwtExpiry(lt);
  await prisma.$executeRawUnsafe(
    `INSERT INTO tf_live_session (id, encryptedLt, encryptedAt, jwtExpiresAt, updatedAt, verifiedAt, lastError)
       VALUES (1, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         encryptedLt = excluded.encryptedLt,
         encryptedAt = excluded.encryptedAt,
         jwtExpiresAt = excluded.jwtExpiresAt,
         updatedAt = excluded.updatedAt,
         verifiedAt = excluded.verifiedAt,
         lastError = NULL`,
    encryptValue(lt),
    encryptValue(at),
    jwtExpiresAt,
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

/** Latest capture per endpoint, for the /tf status panel's headline chips. */
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

/** Per-IST-day capture counts, most recent day first — the "date-wise"
 *  history view. captureDate is 'YYYY-MM-DD' derived from the stored UTC
 *  capturedAt, so a day boundary matches the trading calendar (IST), not UTC
 *  midnight. */
export async function getTfLiveCaptureHistory(
  limitDays = 30
): Promise<{ captureDate: string; endpoint: string; total: number; success: number; error: number; lastCapturedAt: string }[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `
    SELECT
      date(datetime(capturedAt, '+5 hours', '+30 minutes')) AS captureDate,
      endpoint,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error,
      MAX(capturedAt) AS lastCapturedAt
    FROM tf_live_captures
    GROUP BY captureDate, endpoint
    ORDER BY captureDate DESC, endpoint ASC
    LIMIT ?
  `,
    limitDays * 4
  )) as { captureDate: string; endpoint: string; total: unknown; success: unknown; error: unknown; lastCapturedAt: string }[];
  // SQLite COUNT/SUM come back as BigInt through Prisma's raw driver, and
  // BigInt has no JSON representation — returning it straight from a Route
  // Handler throws "Do not know how to serialize a BigInt" and 500s the whole
  // /tf page (hit in prod 2026-08-06). Normalize at the boundary.
  return rows.map((r) => ({
    captureDate: r.captureDate,
    endpoint: r.endpoint,
    total: Number(r.total ?? 0),
    success: Number(r.success ?? 0),
    error: Number(r.error ?? 0),
    lastCapturedAt: r.lastCapturedAt,
  }));
}

/** Every IST calendar date with at least one SUCCESSFUL capture for the given
 *  endpoint, most recent first — the EOD page's date picker. */
export async function getTfLiveCaptureDates(endpoint: 'all_sector' | 'daily-index'): Promise<string[]> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `
    SELECT DISTINCT date(datetime(capturedAt, '+5 hours', '+30 minutes')) AS captureDate
    FROM tf_live_captures
    WHERE endpoint = ? AND status = 'success'
    ORDER BY captureDate DESC
  `,
    endpoint
  )) as { captureDate: string }[];
  return rows.map((r) => r.captureDate);
}

/** The LAST successful capture on the given IST calendar date for one
 *  endpoint — the EOD (closing) snapshot, not an intraday one, even if the
 *  collector ran several times that day. Returns the raw parsed payload plus
 *  when it was actually captured. */
export async function getTfLiveCaptureForDate(
  endpoint: 'all_sector' | 'daily-index',
  date: string
): Promise<{ capturedAt: string; payload: unknown } | null> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(
    `
    SELECT capturedAt, payloadJson
    FROM tf_live_captures
    WHERE endpoint = ? AND status = 'success'
      AND date(datetime(capturedAt, '+5 hours', '+30 minutes')) = ?
    ORDER BY capturedAt DESC
    LIMIT 1
  `,
    endpoint,
    date
  )) as { capturedAt: string; payloadJson: string | null }[];
  const row = rows[0];
  if (!row || !row.payloadJson) return null;
  try {
    return { capturedAt: row.capturedAt, payload: JSON.parse(row.payloadJson) };
  } catch {
    return null;
  }
}

/**
 * Per-symbol lookup from the MOST RECENT successful `all_sector` capture,
 * whatever date that was — feeds the Live Urgency page's TF column. The schema
 * is owned by lib/tf-live/parse.ts and was CONFIRMED against a real payload
 * (2026-08-06), so nothing here guesses at field names; an unparseable payload
 * yields no rows rather than invented values.
 *
 * Note the deliberate difference from lib/tf-live/snapshot.ts: this returns the
 * latest capture from ANY date, because a display column showing yesterday's TF
 * number is acceptable. Anything feeding a TRADE decision must use the
 * date-scoped snapshot instead — a stale board must never be read as today's.
 */
export async function getLatestTfRFactorBySymbol(): Promise<{
  capturedAt: string | null;
  bySymbol: Map<string, { rFactor: number | null; pctChange: number | null; previousClose: number | null }>;
}> {
  await ensureTables();
  const rows = (await prisma.$queryRawUnsafe(`
    SELECT capturedAt, payloadJson
    FROM tf_live_captures
    WHERE endpoint = 'all_sector' AND status = 'success'
    ORDER BY capturedAt DESC
    LIMIT 1
  `)) as { capturedAt: string; payloadJson: string | null }[];
  const row = rows[0];
  const bySymbol = new Map<string, { rFactor: number | null; pctChange: number | null; previousClose: number | null }>();
  if (!row?.payloadJson) return { capturedAt: null, bySymbol };

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payloadJson);
  } catch {
    return { capturedAt: null, bySymbol };
  }
  for (const r of parseAllSector(parsed)) {
    bySymbol.set(r.symbol, { rFactor: r.rFactor, pctChange: r.pctChange, previousClose: r.previousClose });
  }
  return { capturedAt: row.capturedAt, bySymbol };
}
